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
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/yucp/transfer-helper/internal/dpop"
	"github.com/yucp/transfer-helper/internal/packagecontract"
	"github.com/yucp/transfer-helper/internal/trust"
)

type ProtectedRenditionConfig struct {
	DeliveryGrant    string
	DownloadRoot     string
	Grant            packagecontract.DeliveryGrant
	PollInterval     time.Duration
	PrivateKey       *ecdsa.PrivateKey
	ReceiptAuthority trust.Authority
	Session          packagecontract.InstallSession
}

type DownloadedRendition struct {
	Bytes         int64
	Path          string
	SignedReceipt string
	SHA256        string
}

type materializationStatus struct {
	ErrorCode     string `json:"errorCode"`
	QueuePosition int    `json:"queuePosition"`
	Receipt       string `json:"receipt"`
	ReceiptID     string `json:"receiptId"`
	State         string `json:"state"`
	Status        string `json:"status"`
}

func FetchProtectedRendition(
	ctx context.Context,
	cfg ProtectedRenditionConfig,
) (DownloadedRendition, packagecontract.MaterializationReceipt, error) {
	if ctx == nil || cfg.PrivateKey == nil || cfg.DeliveryGrant == "" {
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
	client := &http.Client{
		Timeout: 5 * time.Minute,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	var encodedReceipt string
	for {
		status, statusErr := readMaterializationStatus(
			ctx,
			client,
			statusURL,
			jobID,
			cfg.DeliveryGrant,
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
		cfg.DeliveryGrant,
		cfg.PrivateKey,
		receipt,
	)
	if err != nil {
		return DownloadedRendition{}, packagecontract.MaterializationReceipt{}, err
	}
	return downloaded, receipt, nil
}

func readMaterializationStatus(
	ctx context.Context,
	client *http.Client,
	endpoint string,
	jobID string,
	grant string,
	privateKey *ecdsa.PrivateKey,
) (materializationStatus, error) {
	proof, err := dpop.CreateProof(privateKey, http.MethodPost, endpoint, grant, time.Now())
	if err != nil {
		return materializationStatus{}, fmt.Errorf("create materialization status proof: %w", err)
	}
	body, err := json.Marshal(map[string]string{
		"deliveryGrant": grant,
		"jobId":         jobID,
		"proof":         proof,
	})
	if err != nil {
		return materializationStatus{}, fmt.Errorf("encode materialization status request: %w", err)
	}
	request, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		endpoint,
		bytes.NewReader(body),
	)
	if err != nil {
		return materializationStatus{}, fmt.Errorf("create materialization status request: %w", err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("DPoP", proof)
	response, err := client.Do(request)
	if err != nil {
		return materializationStatus{}, fmt.Errorf("read materialization status: %w", err)
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
	grant string,
	privateKey *ecdsa.PrivateKey,
	receipt packagecontract.MaterializationReceipt,
) (DownloadedRendition, error) {
	proof, err := dpop.CreateProof(privateKey, http.MethodPost, endpoint, grant, time.Now())
	if err != nil {
		return DownloadedRendition{}, fmt.Errorf("create rendition delivery proof: %w", err)
	}
	body, err := json.Marshal(map[string]string{"receipt": encodedReceipt})
	if err != nil {
		return DownloadedRendition{}, fmt.Errorf("encode rendition request: %w", err)
	}
	request, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		endpoint,
		bytes.NewReader(body),
	)
	if err != nil {
		return DownloadedRendition{}, fmt.Errorf("create rendition request: %w", err)
	}
	request.Header.Set("Authorization", "DPoP "+grant)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("DPoP", proof)
	response, err := client.Do(request)
	if err != nil {
		return DownloadedRendition{}, fmt.Errorf("download protected rendition: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return DownloadedRendition{}, fmt.Errorf(
			"protected rendition returned HTTP %d",
			response.StatusCode,
		)
	}
	if response.ContentLength > receipt.Rendition.ObjectBytes {
		return DownloadedRendition{}, fmt.Errorf("protected rendition exceeded its signed length")
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
	written, copyErr := io.Copy(
		io.MultiWriter(temporary, hasher),
		io.LimitReader(response.Body, receipt.Rendition.ObjectBytes+1),
	)
	if copyErr != nil {
		_ = temporary.Close()
		return DownloadedRendition{}, fmt.Errorf("read protected rendition: %w", copyErr)
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

func MergeProtectedRendition(
	stagingTree string,
	manifest Manifest,
	renditionPath string,
	receipt packagecontract.MaterializationReceipt,
) ([]StagedFile, error) {
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
	bestEffort := manifest.ProtectionPolicyID == "supported-visual-assets-v2"
	if !bestEffort && len(protectedFiles) != len(receipt.OutputFiles) {
		return nil, fmt.Errorf("protected rendition output count does not match the manifest")
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
		if !bestEffort {
			return nil, fmt.Errorf("protected rendition is missing a required output path")
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
