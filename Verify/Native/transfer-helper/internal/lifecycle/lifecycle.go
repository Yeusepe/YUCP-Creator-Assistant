package lifecycle

import (
	"context"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/yucp/transfer-helper/internal/delivery"
	"github.com/yucp/transfer-helper/internal/deviceidentity"
	"github.com/yucp/transfer-helper/internal/packagecontract"
	"github.com/yucp/transfer-helper/internal/trust"
)

const (
	SchemaVersion                     = 3
	UnityWindowsPathLimitErrorCode    = "UNITY_WINDOWS_PATH_LIMIT"
	unityWindowsMaximumPathCharacters = 260
)

var (
	safeIdentifier = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)
	traceparent    = regexp.MustCompile(
		`^00-([0-9a-f]{32})-([0-9a-f]{16})-(00|01)$`,
	)
)

type stableError struct {
	code    string
	message string
}

func (err stableError) Error() string {
	return err.message
}

func (err stableError) StableCode() string {
	return err.code
}

func ErrorCode(err error) string {
	var coded interface {
		StableCode() string
	}
	if errors.As(err, &coded) {
		return coded.StableCode()
	}
	return ""
}

type OperationInput struct {
	AliasID                     string
	ApprovedActiveContentDigest string
	ApprovedPolicyVersion       string
	ExpectedCurrentReleaseRoot  string
	IdempotencyKey              string
	Operation                   string
	ProjectIdentity             string
	ProjectPath                 string
	RunID                       string
	StateRoot                   string
	TargetReleaseRoot           string
	Traceparent                 string
}

type AuthorizedRequest struct {
	OperationInput

	deliveryGrant  string
	installSession string
}

func NewAuthorizedRequest(
	input OperationInput,
	installSession string,
	deliveryGrant string,
) (AuthorizedRequest, error) {
	request := AuthorizedRequest{
		OperationInput: input,
		deliveryGrant:  deliveryGrant,
		installSession: installSession,
	}
	if err := validateRequest(request); err != nil {
		return AuthorizedRequest{}, err
	}
	return request, nil
}

type ResultFile struct {
	Bytes          int64  `json:"bytes"`
	NormalizedPath string `json:"normalizedPath"`
	SHA256         string `json:"sha256"`
}

type Result struct {
	ActiveContentDigest string       `json:"activeContentDigest"`
	ActivePolicyVersion string       `json:"activePolicyVersion"`
	ErrorCode           string       `json:"errorCode"`
	ErrorMessage        string       `json:"errorMessage"`
	ExitCode            int          `json:"exitCode"`
	Files               []ResultFile `json:"files"`
	JournalState        string       `json:"journalState"`
	LogicalBytes        int64        `json:"logicalBytes"`
	LogicalFiles        int          `json:"logicalFiles"`
	Operation           string       `json:"operation"`
	ReceiptID           string       `json:"receiptId,omitempty"`
	ReceiptPath         string       `json:"receiptPath,omitempty"`
	RunID               string       `json:"runId"`
	SchemaVersion       int          `json:"schemaVersion"`
	StagingTree         string       `json:"stagingTree"`
	Status              string       `json:"status"`
	TargetReleaseRoot   string       `json:"targetReleaseRoot"`
	TraceID             string       `json:"traceId"`
	VersionID           string       `json:"versionId"`
}

type ProgressReporter func(
	phase string,
	completedBytes int64,
	totalBytes int64,
) error

func Execute(
	ctx context.Context,
	request AuthorizedRequest,
	identity deviceidentity.Identity,
	trustDocument trust.Document,
	reportProgress ProgressReporter,
) (Result, error) {
	if err := validateRequest(request); err != nil {
		return Result{}, err
	}
	targetReleaseRoot, _ := hex.DecodeString(request.TargetReleaseRoot)
	deviceThumbprint, _ := hex.DecodeString(identity.Thumbprint)
	sessionEnvelope, err := decodeToken(request.installSession, "install session")
	if err != nil {
		return Result{}, err
	}
	sessionPayload, err := packagecontract.VerifySign1(
		sessionEnvelope,
		trustDocument.PackageInstall.PublicKey,
		trustDocument.PackageInstall.KeyID,
		packagecontract.InstallSessionPurpose,
	)
	if err != nil {
		return Result{}, fmt.Errorf("verify install session: %w", err)
	}
	session, err := packagecontract.ParseInstallSession(sessionPayload)
	if err != nil {
		return Result{}, fmt.Errorf("parse install session: %w", err)
	}
	if session.KeyID != string(trustDocument.PackageInstall.KeyID) {
		return Result{}, fmt.Errorf("install session key identifier claim is invalid")
	}
	grantEnvelope, err := decodeToken(request.deliveryGrant, "delivery grant")
	if err != nil {
		return Result{}, err
	}
	grantPayload, err := packagecontract.VerifySign1(
		grantEnvelope,
		trustDocument.PackageInstall.PublicKey,
		trustDocument.PackageInstall.KeyID,
		packagecontract.DeliveryGrantPurpose,
	)
	if err != nil {
		return Result{}, fmt.Errorf("verify delivery grant: %w", err)
	}
	grant, err := packagecontract.ParseDeliveryGrant(grantPayload)
	if err != nil {
		return Result{}, fmt.Errorf("parse delivery grant: %w", err)
	}
	if err := packagecontract.ValidateInstallAuthorization(
		session,
		grant,
		packagecontract.InstallAuthorizationContext{
			AliasID:             request.AliasID,
			DeviceKeyThumbprint: deviceThumbprint,
			ExpectedReleaseRoot: targetReleaseRoot,
			Now:                 time.Now(),
			Operation:           request.Operation,
		},
	); err != nil {
		return Result{}, err
	}
	manifest, err := delivery.FetchManifest(
		ctx,
		session,
		grant,
		request.deliveryGrant,
		identity.PrivateKey,
	)
	if err != nil {
		return Result{}, err
	}
	var totalBytes int64
	for _, file := range manifest.Files {
		totalBytes += file.Bytes
		if totalBytes < 0 {
			return Result{}, fmt.Errorf("package logical byte count overflow")
		}
	}
	if err := validateUnityProjectPaths(runtime.GOOS, request.ProjectPath, manifest.Files); err != nil {
		return Result{}, err
	}
	baseResult := Result{
		ActiveContentDigest: manifest.ActiveContentDigest,
		ActivePolicyVersion: manifest.ActivePolicyVersion,
		Files:               []ResultFile{},
		Operation:           request.Operation,
		RunID:               request.RunID,
		SchemaVersion:       SchemaVersion,
		Status:              "succeeded",
		TargetReleaseRoot:   request.TargetReleaseRoot,
		TraceID:             request.Traceparent[3:35],
		VersionID:           manifest.VersionID,
	}
	if request.Operation == "preflight" {
		if err := report(
			reportProgress,
			"verifying",
			0,
			totalBytes,
		); err != nil {
			return Result{}, err
		}
		baseResult.JournalState = "preflight-complete"
		if err := report(
			reportProgress,
			"finalizing",
			totalBytes,
			totalBytes,
		); err != nil {
			return Result{}, err
		}
		return baseResult, nil
	}
	if request.ApprovedActiveContentDigest != manifest.ActiveContentDigest ||
		request.ApprovedPolicyVersion != manifest.ActivePolicyVersion {
		return Result{}, fmt.Errorf("active-content approval is stale or does not match")
	}
	stagingTree := filepath.Join(request.StateRoot, "staging", request.RunID)
	if err := report(
		reportProgress,
		"downloading",
		0,
		totalBytes,
	); err != nil {
		return Result{}, err
	}
	staged, err := delivery.StageCommonTree(ctx, delivery.StageCommonConfig{
		CacheRoot:     filepath.Join(request.StateRoot, "chunk-cache"),
		DeliveryGrant: request.deliveryGrant,
		Destination:   stagingTree,
		Manifest:      manifest,
		ManifestURL:   session.Bootstrap.URL,
		PrivateKey:    identity.PrivateKey,
		Progress: func(completedBytes int64, _ int64) error {
			return report(
				reportProgress,
				"downloading",
				completedBytes,
				totalBytes,
			)
		},
	})
	if err != nil {
		return Result{}, err
	}
	allFiles := append([]delivery.StagedFile(nil), staged.Files...)
	protectedCount := 0
	for _, file := range manifest.Files {
		if file.Classification == "protected" {
			protectedCount++
		}
	}
	if protectedCount > 0 {
		rendition, receipt, renditionErr := delivery.FetchProtectedRendition(
			ctx,
			delivery.ProtectedRenditionConfig{
				DeliveryGrant:    request.deliveryGrant,
				DownloadRoot:     request.StateRoot,
				Grant:            grant,
				PrivateKey:       identity.PrivateKey,
				ReceiptAuthority: trustDocument.MaterializationReceipt,
				Session:          session,
			},
		)
		if renditionErr != nil {
			return Result{}, renditionErr
		}
		protectedFiles, mergeErr := delivery.MergeProtectedRendition(
			stagingTree,
			manifest,
			rendition.Path,
			receipt,
		)
		if mergeErr != nil {
			return Result{}, mergeErr
		}
		receiptPath, persistErr := persistReceipt(
			request.StateRoot,
			receipt.ReceiptID,
			rendition.SignedReceipt,
		)
		if persistErr != nil {
			return Result{}, persistErr
		}
		baseResult.ReceiptID = receipt.ReceiptID
		baseResult.ReceiptPath = receiptPath
		allFiles = append(allFiles, protectedFiles...)
	}
	if err := report(
		reportProgress,
		"downloading",
		totalBytes,
		totalBytes,
	); err != nil {
		return Result{}, err
	}
	if err := report(
		reportProgress,
		"verifying",
		totalBytes,
		totalBytes,
	); err != nil {
		return Result{}, err
	}
	sort.Slice(allFiles, func(left int, right int) bool {
		return allFiles[left].NormalizedPath < allFiles[right].NormalizedPath
	})
	baseResult.Files = make([]ResultFile, len(allFiles))
	baseResult.LogicalBytes = 0
	for index, file := range allFiles {
		baseResult.Files[index] = ResultFile{
			Bytes:          file.Bytes,
			NormalizedPath: file.NormalizedPath,
			SHA256:         file.SHA256,
		}
		baseResult.LogicalBytes += file.Bytes
	}
	baseResult.JournalState = "verified-staging-ready"
	baseResult.LogicalFiles = len(allFiles)
	baseResult.StagingTree = stagingTree
	if err := report(
		reportProgress,
		"assembling",
		totalBytes,
		totalBytes,
	); err != nil {
		return Result{}, err
	}
	if err := report(
		reportProgress,
		"finalizing",
		totalBytes,
		totalBytes,
	); err != nil {
		return Result{}, err
	}
	return baseResult, nil
}

func report(
	reporter ProgressReporter,
	phase string,
	completedBytes int64,
	totalBytes int64,
) error {
	if reporter == nil {
		return nil
	}
	if err := reporter(phase, completedBytes, totalBytes); err != nil {
		return fmt.Errorf("publish package lifecycle progress: %w", err)
	}
	return nil
}

func validateUnityProjectPaths(goos string, projectPath string, files []delivery.File) error {
	if goos != "windows" {
		return nil
	}
	projectRoot := strings.TrimRight(projectPath, `/\`)
	for _, file := range files {
		windowsPath := projectRoot + `\` + strings.ReplaceAll(file.NormalizedPath, "/", `\`)
		if len(utf16.Encode([]rune(windowsPath))) >= unityWindowsMaximumPathCharacters {
			return stableError{
				code: UnityWindowsPathLimitErrorCode,
				message: "The Unity project path is too long for this package on Windows. " +
					"Move the project to a shorter folder. Unsupported package path: " +
					file.NormalizedPath,
			}
		}
	}
	return nil
}

func persistReceipt(stateRoot string, receiptID string, encodedReceipt string) (string, error) {
	if !safeIdentifier.MatchString(receiptID) ||
		encodedReceipt == "" ||
		strings.Contains(encodedReceipt, "=") {
		return "", fmt.Errorf("materialization receipt persistence metadata is invalid")
	}
	destination := filepath.Join(stateRoot, "receipts", receiptID+".cose.base64url")
	if err := os.MkdirAll(filepath.Dir(destination), 0o700); err != nil {
		return "", fmt.Errorf("create materialization receipt directory: %w", err)
	}
	if existing, err := os.ReadFile(destination); err == nil {
		if string(existing) != encodedReceipt+"\n" {
			return "", fmt.Errorf("materialization receipt identifier conflicts")
		}
		return destination, nil
	} else if !os.IsNotExist(err) {
		return "", fmt.Errorf("read existing materialization receipt: %w", err)
	}
	temporary, err := os.CreateTemp(filepath.Dir(destination), ".receipt-*.partial")
	if err != nil {
		return "", fmt.Errorf("create materialization receipt temporary file: %w", err)
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o600); err != nil {
		_ = temporary.Close()
		return "", fmt.Errorf("set materialization receipt permissions: %w", err)
	}
	if _, err := temporary.WriteString(encodedReceipt + "\n"); err != nil {
		_ = temporary.Close()
		return "", fmt.Errorf("write materialization receipt: %w", err)
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return "", fmt.Errorf("synchronize materialization receipt: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return "", fmt.Errorf("close materialization receipt: %w", err)
	}
	if err := os.Link(temporaryPath, destination); err != nil {
		return "", fmt.Errorf("publish materialization receipt: %w", err)
	}
	return destination, nil
}

func validateRequest(request AuthorizedRequest) error {
	if !safeIdentifier.MatchString(request.RunID) ||
		!safeIdentifier.MatchString(request.AliasID) ||
		!safeIdentifier.MatchString(request.IdempotencyKey) ||
		(request.Operation != "preflight" &&
			request.Operation != "install" &&
			request.Operation != "recover" &&
			request.Operation != "update" &&
			request.Operation != "repair" &&
			request.Operation != "rollback" &&
			request.Operation != "uninstall") ||
		!filepath.IsAbs(request.ProjectPath) ||
		!filepath.IsAbs(request.StateRoot) ||
		strings.ContainsRune(request.ProjectPath, '\x00') ||
		strings.ContainsRune(request.StateRoot, '\x00') ||
		!isDigest(request.ExpectedCurrentReleaseRoot) ||
		!isDigest(request.TargetReleaseRoot) ||
		!isDigest(request.ProjectIdentity) ||
		!validTraceparent(request.Traceparent) ||
		request.installSession == "" ||
		request.deliveryGrant == "" {
		return fmt.Errorf("package lifecycle request is invalid")
	}
	hasApproval := request.ApprovedActiveContentDigest != "" ||
		request.ApprovedPolicyVersion != ""
	if request.Operation == "preflight" && hasApproval {
		return fmt.Errorf("package lifecycle preflight approval must be absent")
	}
	if request.Operation != "preflight" &&
		(!isDigest(request.ApprovedActiveContentDigest) ||
			strings.TrimSpace(request.ApprovedPolicyVersion) == "" ||
			len([]byte(request.ApprovedPolicyVersion)) > 128) {
		return fmt.Errorf("package lifecycle active-content approval is invalid")
	}
	return nil
}

func decodeToken(encoded string, name string) ([]byte, error) {
	if encoded == "" || strings.Contains(encoded, "=") || len(encoded) > 256*1024 {
		return nil, fmt.Errorf("%s must use bounded unpadded base64url", name)
	}
	value, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil {
		return nil, fmt.Errorf("decode %s: %w", name, err)
	}
	return value, nil
}

func isDigest(value string) bool {
	if len(value) != 64 || strings.ToLower(value) != value {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil
}

func validTraceparent(value string) bool {
	match := traceparent.FindStringSubmatch(value)
	return match != nil &&
		match[1] != "00000000000000000000000000000000" &&
		match[2] != "0000000000000000"
}
