package delivery

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/yucp/transfer-helper/internal/dpop"
	"github.com/yucp/transfer-helper/internal/packagecontract"
	"github.com/yucp/transfer-helper/internal/trust"
)

type ProtectedRenditionConfig struct {
	DownloadIdleTimeout time.Duration
	DownloadRoot        string
	Grant               packagecontract.DeliveryGrant
	GrantSource         GrantSource
	PollInterval        time.Duration
	PrivateKey          *ecdsa.PrivateKey
	Progress            func(ProtectedRenditionProgress) error
	ReceiptAuthority    trust.Authority
	Session             packagecontract.InstallSession
}

type ProtectedRenditionProgress struct {
	CompletedFiles        int64
	CompletedLogicalBytes int64
	QueuePosition         int
	Sequence              int64
	Stage                 string
	State                 string
	Status                string
	TotalFiles            int64
	TotalLogicalBytes     int64
	UpdatedAt             time.Time
}

type DownloadedRendition struct {
	Bytes         int64
	Path          string
	SignedReceipt string
	SHA256        string
}

type materializationStatus struct {
	ErrorCode string `json:"errorCode"`
	Progress  *struct {
		BatchChunks           int64  `json:"batchChunks"`
		BatchIndex            int64  `json:"batchIndex"`
		CompletedBatches      int64  `json:"completedBatches"`
		CompletedFiles        int64  `json:"completedFiles"`
		CompletedLogicalBytes int64  `json:"completedLogicalBytes"`
		OutputBytes           int64  `json:"outputBytes"`
		OutputFiles           int64  `json:"outputFiles"`
		Sequence              int64  `json:"sequence"`
		Stage                 string `json:"stage"`
		Status                string `json:"status"`
		TotalFiles            int64  `json:"totalFiles"`
		TotalLogicalBytes     int64  `json:"totalLogicalBytes"`
		TotalUniqueChunks     int64  `json:"totalUniqueChunks"`
		UpdatedAt             string `json:"updatedAt"`
	} `json:"progress"`
	QueuePosition int    `json:"queuePosition"`
	Receipt       string `json:"receipt"`
	ReceiptID     string `json:"receiptId"`
	State         string `json:"state"`
	Status        string `json:"status"`
}

const (
	defaultRenditionIdleTimeout  = 30 * time.Second
	maxRenditionDownloadAttempts = 8
	maxRenditionIdleTimeout      = 5 * time.Minute
)

var errRenditionIdleTimeout = errors.New("protected rendition download became idle")

func FetchProtectedRendition(
	ctx context.Context,
	cfg ProtectedRenditionConfig,
) (DownloadedRendition, packagecontract.MaterializationReceipt, error) {
	if ctx == nil || cfg.PrivateKey == nil || cfg.GrantSource == nil {
		return DownloadedRendition{}, packagecontract.MaterializationReceipt{},
			fmt.Errorf("protected rendition credentials are required")
	}
	jobID := cfg.Grant.MaterializationJobID()
	if jobID == "" {
		return DownloadedRendition{}, packagecontract.MaterializationReceipt{},
			fmt.Errorf("delivery grant has no materialization scope")
	}
	downloadRoot, err := requireAbsolutePath(cfg.DownloadRoot, "rendition download root")
	if err != nil {
		return DownloadedRendition{}, packagecontract.MaterializationReceipt{}, err
	}
	statusURL, err := endpointURL(
		cfg.Session.Issuer,
		"/api/v2/package-installs/materialization-status",
	)
	if err != nil {
		return DownloadedRendition{}, packagecontract.MaterializationReceipt{}, err
	}
	interval := cfg.PollInterval
	if interval <= 0 {
		interval = 500 * time.Millisecond
	}
	if interval > 10*time.Second {
		return DownloadedRendition{}, packagecontract.MaterializationReceipt{},
			fmt.Errorf("materialization poll interval exceeds its limit")
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.ResponseHeaderTimeout = 30 * time.Second
	client := &http.Client{
		Transport: transport,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	idleTimeout := cfg.DownloadIdleTimeout
	if idleTimeout <= 0 {
		idleTimeout = defaultRenditionIdleTimeout
	}
	if idleTimeout > maxRenditionIdleTimeout {
		return DownloadedRendition{}, packagecontract.MaterializationReceipt{},
			fmt.Errorf("rendition idle timeout exceeds its limit")
	}
	var encodedReceipt string
	for {
		status, statusErr := readMaterializationStatus(
			ctx,
			client,
			statusURL,
			jobID,
			cfg.GrantSource,
			cfg.PrivateKey,
		)
		if statusErr != nil {
			return DownloadedRendition{}, packagecontract.MaterializationReceipt{}, statusErr
		}
		switch status.Status {
		case "succeeded":
			if status.Receipt == "" || status.ReceiptID == "" {
				return DownloadedRendition{}, packagecontract.MaterializationReceipt{},
					fmt.Errorf("materialization status returned no signed receipt")
			}
			encodedReceipt = status.Receipt
		case "failed":
			return DownloadedRendition{}, packagecontract.MaterializationReceipt{},
				fmt.Errorf("materialization failed with stable error code %s", status.ErrorCode)
		case "pending":
			if status.QueuePosition < 0 ||
				(status.State != "MATERIALIZING" &&
					status.State != "QUEUED" &&
					status.State != "VERIFYING") {
				return DownloadedRendition{}, packagecontract.MaterializationReceipt{},
					fmt.Errorf("materialization pending status is invalid")
			}
			progress := ProtectedRenditionProgress{
				QueuePosition: status.QueuePosition,
				State:         status.State,
			}
			if status.Progress != nil {
				updatedAt, parseErr := time.Parse(time.RFC3339Nano, status.Progress.UpdatedAt)
				if parseErr != nil ||
					status.Progress.Sequence < 1 ||
					status.Progress.CompletedFiles < 0 ||
					status.Progress.CompletedLogicalBytes < 0 ||
					status.Progress.TotalFiles < 0 ||
					status.Progress.TotalLogicalBytes < 0 ||
					(status.Progress.TotalFiles > 0 &&
						status.Progress.CompletedFiles > status.Progress.TotalFiles) ||
					(status.Progress.TotalLogicalBytes > 0 &&
						status.Progress.CompletedLogicalBytes > status.Progress.TotalLogicalBytes) ||
					!validMaterializationProgressStage(status.Progress.Stage) ||
					!validMaterializationProgressStatus(status.Progress.Status) {
					return DownloadedRendition{}, packagecontract.MaterializationReceipt{},
						fmt.Errorf("materialization progress is invalid")
				}
				progress.CompletedFiles = status.Progress.CompletedFiles
				progress.CompletedLogicalBytes = status.Progress.CompletedLogicalBytes
				progress.Sequence = status.Progress.Sequence
				progress.Stage = status.Progress.Stage
				progress.Status = status.Progress.Status
				progress.TotalFiles = status.Progress.TotalFiles
				progress.TotalLogicalBytes = status.Progress.TotalLogicalBytes
				progress.UpdatedAt = updatedAt
			}
			if cfg.Progress != nil {
				if progressErr := cfg.Progress(progress); progressErr != nil {
					return DownloadedRendition{}, packagecontract.MaterializationReceipt{},
						fmt.Errorf("publish materialization progress: %w", progressErr)
				}
			}
		default:
			return DownloadedRendition{}, packagecontract.MaterializationReceipt{},
				fmt.Errorf("materialization status is invalid")
		}
		if encodedReceipt != "" {
			break
		}
		timer := time.NewTimer(interval)
		select {
		case <-ctx.Done():
			timer.Stop()
			return DownloadedRendition{}, packagecontract.MaterializationReceipt{},
				fmt.Errorf("wait for materialization: %w", ctx.Err())
		case <-timer.C:
		}
	}
	receiptEnvelope, err := base64.RawURLEncoding.DecodeString(encodedReceipt)
	if err != nil {
		return DownloadedRendition{}, packagecontract.MaterializationReceipt{},
			fmt.Errorf("decode materialization receipt: %w", err)
	}
	receiptPayload, err := packagecontract.VerifySign1(
		receiptEnvelope,
		cfg.ReceiptAuthority.PublicKey,
		cfg.ReceiptAuthority.KeyID,
		packagecontract.MaterializationReceiptPurpose,
	)
	if err != nil {
		return DownloadedRendition{}, packagecontract.MaterializationReceipt{},
			fmt.Errorf("verify materialization receipt: %w", err)
	}
	receipt, err := packagecontract.ParseMaterializationReceipt(receiptPayload)
	if err != nil {
		return DownloadedRendition{}, packagecontract.MaterializationReceipt{},
			fmt.Errorf("parse materialization receipt: %w", err)
	}
	if err := packagecontract.ValidateMaterializationReceipt(
		receipt,
		packagecontract.ReceiptValidationContext{
			CreatorID:   cfg.Session.CreatorID,
			GrantID:     cfg.Grant.GrantID,
			JobID:       jobID,
			Now:         time.Now(),
			ProductID:   cfg.Session.ProductID,
			ReleaseRoot: cfg.Session.ReleaseRoot[:],
		},
	); err != nil {
		return DownloadedRendition{}, packagecontract.MaterializationReceipt{}, err
	}
	renditionURL, err := endpointURL(
		cfg.Session.Audience,
		"/v2/renditions/"+url.PathEscape(jobID),
	)
	if err != nil {
		return DownloadedRendition{}, packagecontract.MaterializationReceipt{}, err
	}
	downloaded, err := downloadRendition(
		ctx,
		client,
		renditionURL,
		jobID,
		encodedReceipt,
		downloadRoot,
		cfg.GrantSource,
		cfg.PrivateKey,
		receipt,
		idleTimeout,
	)
	if err != nil {
		return DownloadedRendition{}, packagecontract.MaterializationReceipt{}, err
	}
	return downloaded, receipt, nil
}

func validMaterializationProgressStage(value string) bool {
	switch value {
	case "archive_build", "capability_consume", "codec", "completion",
		"key_derivation", "rendition_upload", "rendition_upload_ticket",
		"rendition_verify", "source_assembly", "source_manifest", "tree_extraction":
		return true
	default:
		return false
	}
}

func validMaterializationProgressStatus(value string) bool {
	switch value {
	case "completed", "progress", "started":
		return true
	default:
		return false
	}
}

func readMaterializationStatus(
	ctx context.Context,
	client *http.Client,
	endpoint string,
	jobID string,
	grantSource GrantSource,
	privateKey *ecdsa.PrivateKey,
) (materializationStatus, error) {
	grant, err := grantSource.Current(ctx)
	if err != nil {
		return materializationStatus{}, fmt.Errorf("read materialization authorization: %w", err)
	}
	var response *http.Response
	for attempt := 0; attempt < 2; attempt++ {
		proof, proofErr := dpop.CreateProof(
			privateKey,
			http.MethodPost,
			endpoint,
			grant,
			time.Now(),
		)
		if proofErr != nil {
			return materializationStatus{}, fmt.Errorf(
				"create materialization status proof: %w",
				proofErr,
			)
		}
		body, bodyErr := json.Marshal(map[string]string{
			"deliveryGrant": grant,
			"jobId":         jobID,
			"proof":         proof,
		})
		if bodyErr != nil {
			return materializationStatus{}, fmt.Errorf(
				"encode materialization status request: %w",
				bodyErr,
			)
		}
		request, requestErr := http.NewRequestWithContext(
			ctx,
			http.MethodPost,
			endpoint,
			bytes.NewReader(body),
		)
		if requestErr != nil {
			return materializationStatus{}, fmt.Errorf(
				"create materialization status request: %w",
				requestErr,
			)
		}
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("DPoP", proof)
		response, err = client.Do(request)
		if err != nil {
			return materializationStatus{}, fmt.Errorf("read materialization status: %w", err)
		}
		if !renewableAuthorizationStatus(response.StatusCode) || attempt == 1 {
			break
		}
		_ = response.Body.Close()
		grant, err = grantSource.Renew(ctx, grant)
		if err != nil {
			return materializationStatus{}, fmt.Errorf(
				"renew materialization authorization: %w",
				err,
			)
		}
	}
	if response == nil {
		return materializationStatus{}, fmt.Errorf("materialization status returned no response")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return materializationStatus{}, fmt.Errorf(
			"materialization status returned HTTP %d",
			response.StatusCode,
		)
	}
	decoder := json.NewDecoder(io.LimitReader(response.Body, 2*1024*1024+1))
	decoder.DisallowUnknownFields()
	var status materializationStatus
	if err := decoder.Decode(&status); err != nil {
		return materializationStatus{}, fmt.Errorf("decode materialization status: %w", err)
	}
	return status, nil
}

func downloadRendition(
	ctx context.Context,
	client *http.Client,
	endpoint string,
	jobID string,
	encodedReceipt string,
	downloadRoot string,
	grantSource GrantSource,
	privateKey *ecdsa.PrivateKey,
	receipt packagecontract.MaterializationReceipt,
	idleTimeout time.Duration,
) (DownloadedRendition, error) {
	grant, err := grantSource.Current(ctx)
	if err != nil {
		return DownloadedRendition{}, fmt.Errorf("read rendition authorization: %w", err)
	}
	body, err := json.Marshal(map[string]string{"receipt": encodedReceipt})
	if err != nil {
		return DownloadedRendition{}, fmt.Errorf("encode rendition request: %w", err)
	}
	destination := filepath.Join(
		downloadRoot,
		"renditions",
		jobID,
		receipt.ReceiptID+".zip",
	)
	if err := os.MkdirAll(filepath.Dir(destination), 0o700); err != nil {
		return DownloadedRendition{}, fmt.Errorf("create rendition download directory: %w", err)
	}
	temporary, err := os.CreateTemp(filepath.Dir(destination), ".rendition-*.partial")
	if err != nil {
		return DownloadedRendition{}, fmt.Errorf("create rendition temporary file: %w", err)
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	hasher := sha256.New()
	var written int64
	for attempt := 0; attempt < maxRenditionDownloadAttempts &&
		written < receipt.Rendition.ObjectBytes; attempt++ {
		offset := written
		response, nextGrant, requestErr := requestRenditionRange(
			ctx,
			client,
			endpoint,
			body,
			grant,
			grantSource,
			privateKey,
			offset,
			receipt.Rendition.ObjectBytes,
		)
		grant = nextGrant
		if requestErr != nil {
			_ = temporary.Close()
			return DownloadedRendition{}, requestErr
		}
		idleReader := newIdleBodyReader(response.Body, idleTimeout)
		copied, copyErr := io.Copy(
			io.MultiWriter(temporary, hasher),
			io.LimitReader(
				idleReader,
				receipt.Rendition.ObjectBytes-offset+1,
			),
		)
		idleReader.Stop()
		_ = response.Body.Close()
		written += copied
		if written > receipt.Rendition.ObjectBytes {
			_ = temporary.Close()
			return DownloadedRendition{}, fmt.Errorf(
				"protected rendition exceeded its signed length",
			)
		}
		if written == receipt.Rendition.ObjectBytes {
			break
		}
		if ctx.Err() != nil {
			_ = temporary.Close()
			return DownloadedRendition{}, fmt.Errorf(
				"read protected rendition: %w",
				ctx.Err(),
			)
		}
		if copyErr != nil && !isResumableRenditionReadError(copyErr) {
			_ = temporary.Close()
			return DownloadedRendition{}, fmt.Errorf(
				"read protected rendition: %w",
				copyErr,
			)
		}
		if copied == 0 {
			_ = temporary.Close()
			if copyErr == nil {
				copyErr = io.ErrUnexpectedEOF
			}
			return DownloadedRendition{}, fmt.Errorf(
				"read protected rendition without progress: %w",
				copyErr,
			)
		}
	}
	if written != receipt.Rendition.ObjectBytes ||
		!bytes.Equal(hasher.Sum(nil), receipt.Rendition.ObjectSHA256[:]) {
		_ = temporary.Close()
		return DownloadedRendition{}, fmt.Errorf("protected rendition failed signed verification")
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return DownloadedRendition{}, fmt.Errorf("synchronize protected rendition: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return DownloadedRendition{}, fmt.Errorf("close protected rendition: %w", err)
	}
	if err := os.Link(temporaryPath, destination); err != nil {
		if !errors.Is(err, os.ErrExist) {
			return DownloadedRendition{}, fmt.Errorf("publish protected rendition: %w", err)
		}
		existing, readErr := os.ReadFile(destination)
		if readErr != nil {
			return DownloadedRendition{}, fmt.Errorf("read existing protected rendition: %w", readErr)
		}
		existingDigest := sha256.Sum256(existing)
		if int64(len(existing)) != receipt.Rendition.ObjectBytes ||
			!bytes.Equal(existingDigest[:], receipt.Rendition.ObjectSHA256[:]) {
			return DownloadedRendition{}, fmt.Errorf("existing protected rendition conflicts")
		}
	}
	return DownloadedRendition{
		Bytes:         written,
		Path:          destination,
		SHA256:        hex.EncodeToString(receipt.Rendition.ObjectSHA256[:]),
		SignedReceipt: encodedReceipt,
	}, nil
}

func isResumableRenditionReadError(err error) bool {
	if errors.Is(err, errRenditionIdleTimeout) ||
		errors.Is(err, io.EOF) ||
		errors.Is(err, io.ErrUnexpectedEOF) {
		return true
	}
	var networkError net.Error
	return errors.As(err, &networkError)
}

func requestRenditionRange(
	ctx context.Context,
	client *http.Client,
	endpoint string,
	body []byte,
	grant string,
	grantSource GrantSource,
	privateKey *ecdsa.PrivateKey,
	offset int64,
	total int64,
) (*http.Response, string, error) {
	for authorizationAttempt := 0; authorizationAttempt < 2; authorizationAttempt++ {
		proof, err := dpop.CreateProof(
			privateKey,
			http.MethodPost,
			endpoint,
			grant,
			time.Now(),
		)
		if err != nil {
			return nil, grant, fmt.Errorf("create rendition delivery proof: %w", err)
		}
		request, err := http.NewRequestWithContext(
			ctx,
			http.MethodPost,
			endpoint,
			bytes.NewReader(body),
		)
		if err != nil {
			return nil, grant, fmt.Errorf("create rendition request: %w", err)
		}
		request.Header.Set("Authorization", "DPoP "+grant)
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("DPoP", proof)
		if offset > 0 {
			request.Header.Set("Range", fmt.Sprintf("bytes=%d-", offset))
		}
		response, err := client.Do(request)
		if err != nil {
			return nil, grant, fmt.Errorf("download protected rendition: %w", err)
		}
		if renewableAuthorizationStatus(response.StatusCode) &&
			authorizationAttempt == 0 {
			_ = response.Body.Close()
			grant, err = grantSource.Renew(ctx, grant)
			if err != nil {
				return nil, grant, fmt.Errorf("renew rendition authorization: %w", err)
			}
			continue
		}
		expectedStatus := http.StatusOK
		expectedLength := total
		if offset > 0 {
			expectedStatus = http.StatusPartialContent
			expectedLength = total - offset
		}
		if response.StatusCode != expectedStatus {
			_ = response.Body.Close()
			return nil, grant, fmt.Errorf(
				"protected rendition returned HTTP %d",
				response.StatusCode,
			)
		}
		if response.ContentLength != expectedLength {
			_ = response.Body.Close()
			return nil, grant, fmt.Errorf(
				"protected rendition range length is invalid",
			)
		}
		if offset > 0 {
			expectedRange := fmt.Sprintf("bytes %d-%d/%d", offset, total-1, total)
			if response.Header.Get("Content-Range") != expectedRange {
				_ = response.Body.Close()
				return nil, grant, fmt.Errorf(
					"protected rendition range binding is invalid",
				)
			}
		}
		return response, grant, nil
	}
	return nil, grant, fmt.Errorf("protected rendition authorization retry failed")
}

type idleBodyReader struct {
	body     io.ReadCloser
	duration time.Duration
	mu       sync.Mutex
	stopped  bool
	timedOut bool
	timer    *time.Timer
}

func newIdleBodyReader(body io.ReadCloser, duration time.Duration) *idleBodyReader {
	reader := &idleBodyReader{body: body, duration: duration}
	reader.timer = time.AfterFunc(duration, func() {
		reader.mu.Lock()
		defer reader.mu.Unlock()
		if reader.stopped {
			return
		}
		reader.timedOut = true
		_ = reader.body.Close()
	})
	return reader
}

func (reader *idleBodyReader) Read(buffer []byte) (int, error) {
	count, err := reader.body.Read(buffer)
	reader.mu.Lock()
	if count > 0 && !reader.timedOut && !reader.stopped {
		reader.timer.Reset(reader.duration)
	}
	timedOut := reader.timedOut
	reader.mu.Unlock()
	if timedOut {
		return count, errRenditionIdleTimeout
	}
	return count, err
}

func (reader *idleBodyReader) Stop() {
	reader.mu.Lock()
	defer reader.mu.Unlock()
	reader.stopped = true
	reader.timer.Stop()
}

func MergeProtectedRendition(
	stagingTree string,
	manifest Manifest,
	renditionPath string,
	receipt packagecontract.MaterializationReceipt,
) ([]StagedFile, error) {
	if manifest.ProtectionPolicyID != activeProtectionPolicyID {
		return nil, fmt.Errorf("unsupported protection policy %s", manifest.ProtectionPolicyID)
	}
	stagingTree, err := requireAbsolutePath(stagingTree, "staging tree")
	if err != nil {
		return nil, err
	}
	if !filepath.IsAbs(renditionPath) {
		return nil, fmt.Errorf("protected rendition path must be absolute")
	}
	protectedFiles := make(map[string]File)
	for _, file := range manifest.Files {
		if file.Classification == "protected" {
			protectedFiles[file.NormalizedPath] = file
		}
	}
	if len(receipt.OutputFiles) > len(protectedFiles) {
		return nil, fmt.Errorf("protected rendition output count exceeds the manifest")
	}
	expected := make(map[string]packagecontract.MaterializedFile, len(protectedFiles))
	for _, file := range receipt.OutputFiles {
		if _, ok := protectedFiles[file.NormalizedPath]; !ok {
			return nil, fmt.Errorf("protected rendition contains an unexpected output path")
		}
		if _, duplicate := expected[file.NormalizedPath]; duplicate {
			return nil, fmt.Errorf("protected rendition contains a duplicate output path")
		}
		expected[file.NormalizedPath] = file
	}
	for path, file := range protectedFiles {
		if _, coupled := expected[path]; coupled {
			continue
		}
		digest, decodeErr := hex.DecodeString(file.SHA256)
		if decodeErr != nil || len(digest) != sha256.Size {
			return nil, fmt.Errorf("protected rendition source digest is invalid")
		}
		var sourceDigest [sha256.Size]byte
		copy(sourceDigest[:], digest)
		expected[path] = packagecontract.MaterializedFile{
			Bytes:          file.Bytes,
			NormalizedPath: path,
			SHA256:         sourceDigest,
		}
	}
	archive, err := zip.OpenReader(renditionPath)
	if err != nil {
		return nil, fmt.Errorf("open protected rendition ZIP: %w", err)
	}
	defer archive.Close()
	if len(archive.File) != len(expected) {
		return nil, fmt.Errorf("protected rendition ZIP entry count is invalid")
	}
	stageRoot, err := os.OpenRoot(stagingTree)
	if err != nil {
		return nil, fmt.Errorf("open staging tree for protected rendition: %w", err)
	}
	defer stageRoot.Close()
	results := make([]StagedFile, 0, len(archive.File))
	seen := make(map[string]struct{}, len(archive.File))
	for _, entry := range archive.File {
		if entry.FileInfo().IsDir() ||
			!entry.Mode().IsRegular() ||
			packagecontract.ValidateNormalizedPath(entry.Name) != nil {
			return nil, fmt.Errorf("protected rendition ZIP entry is invalid")
		}
		expectedFile, ok := expected[entry.Name]
		if !ok {
			return nil, fmt.Errorf("protected rendition ZIP entry is not signed")
		}
		if _, duplicate := seen[entry.Name]; duplicate ||
			entry.UncompressedSize64 != uint64(expectedFile.Bytes) {
			return nil, fmt.Errorf("protected rendition ZIP entry metadata is invalid")
		}
		seen[entry.Name] = struct{}{}
		source, err := entry.Open()
		if err != nil {
			return nil, fmt.Errorf("open protected rendition entry: %w", err)
		}
		relativePath := filepath.FromSlash(entry.Name)
		parent := filepath.Dir(relativePath)
		if parent != "." {
			if err := stageRoot.MkdirAll(parent, 0o700); err != nil {
				_ = source.Close()
				return nil, fmt.Errorf("create protected staging directory: %w", err)
			}
		}
		output, err := stageRoot.OpenFile(
			relativePath,
			os.O_WRONLY|os.O_CREATE|os.O_EXCL,
			0o600,
		)
		if err != nil {
			_ = source.Close()
			return nil, fmt.Errorf("create protected staging file: %w", err)
		}
		hasher := sha256.New()
		written, copyErr := io.Copy(
			io.MultiWriter(output, hasher),
			io.LimitReader(source, expectedFile.Bytes+1),
		)
		closeSourceErr := source.Close()
		syncErr := output.Sync()
		closeOutputErr := output.Close()
		if copyErr != nil ||
			closeSourceErr != nil ||
			syncErr != nil ||
			closeOutputErr != nil ||
			written != expectedFile.Bytes ||
			!bytes.Equal(hasher.Sum(nil), expectedFile.SHA256[:]) {
			_ = stageRoot.Remove(relativePath)
			return nil, fmt.Errorf("protected rendition entry failed verification")
		}
		results = append(results, StagedFile{
			Bytes:          expectedFile.Bytes,
			NormalizedPath: expectedFile.NormalizedPath,
			SHA256:         hex.EncodeToString(expectedFile.SHA256[:]),
		})
	}
	if len(seen) != len(expected) {
		return nil, fmt.Errorf("protected rendition ZIP is incomplete")
	}
	return results, nil
}

func endpointURL(origin string, pathname string) (string, error) {
	parsed, err := url.Parse(origin)
	if err != nil || !parsed.IsAbs() || parsed.Path != "" ||
		parsed.RawQuery != "" || parsed.Fragment != "" || parsed.User != nil ||
		!strings.HasPrefix(pathname, "/") {
		return "", fmt.Errorf("protected delivery origin is invalid")
	}
	parsed.Path = pathname
	return parsed.String(), nil
}
