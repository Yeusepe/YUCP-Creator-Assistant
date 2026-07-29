package lifecycle

import (
	"context"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"sync"
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
	renew          func(
		ctx context.Context,
		deliveryGrant string,
		installSession string,
	) (string, string, error)
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

func (request AuthorizedRequest) WithRenewal(
	renew func(
		ctx context.Context,
		deliveryGrant string,
		installSession string,
	) (string, string, error),
) (AuthorizedRequest, error) {
	if renew == nil {
		return AuthorizedRequest{}, fmt.Errorf("package authorization renewal is required")
	}
	request.renew = renew
	return request, nil
}

type verifiedGrantSource struct {
	currentGrant   string
	currentSession string
	lock           sync.Mutex
	renew          func(context.Context, string, string) (string, string, error)
	verify         func(string, string, time.Time) error
}

func (source *verifiedGrantSource) Current(context.Context) (string, error) {
	source.lock.Lock()
	defer source.lock.Unlock()
	return source.currentGrant, nil
}

func (source *verifiedGrantSource) Renew(
	ctx context.Context,
	rejectedGrant string,
) (string, error) {
	source.lock.Lock()
	defer source.lock.Unlock()
	if rejectedGrant != source.currentGrant {
		return source.currentGrant, nil
	}
	if source.renew == nil {
		return "", stableError{
			code:    "INSTALL_SESSION_RENEWAL_FAILED",
			message: "Package authorization expired and could not be renewed.",
		}
	}
	installSession, deliveryGrant, err := source.renew(
		ctx,
		source.currentGrant,
		source.currentSession,
	)
	if err != nil {
		return "", err
	}
	if err := source.verify(installSession, deliveryGrant, time.Now()); err != nil {
		return "", stableError{
			code:    "INSTALL_SESSION_RENEWAL_INVALID",
			message: "The renewed package authorization is invalid.",
		}
	}
	source.currentGrant = deliveryGrant
	source.currentSession = installSession
	return source.currentGrant, nil
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
	session, grant, err := parseSignedAuthorization(
		request.installSession,
		request.deliveryGrant,
		trustDocument,
	)
	if err != nil {
		return Result{}, err
	}
	authorizationContext := packagecontract.InstallAuthorizationContext{
		AliasID:             request.AliasID,
		DeviceKeyThumbprint: deviceThumbprint,
		ExpectedReleaseRoot: targetReleaseRoot,
		Operation:           request.Operation,
	}
	source := &verifiedGrantSource{
		currentGrant:   request.deliveryGrant,
		currentSession: request.installSession,
		renew:          request.renew,
	}
	source.verify = func(encodedSession string, encodedGrant string, now time.Time) error {
		candidateSession, candidateGrant, verifyErr := parseSignedAuthorization(
			encodedSession,
			encodedGrant,
			trustDocument,
		)
		if verifyErr != nil {
			return verifyErr
		}
		context := authorizationContext
		context.Now = now
		if verifyErr := packagecontract.ValidateInstallAuthorization(
			candidateSession,
			candidateGrant,
			context,
		); verifyErr != nil {
			return verifyErr
		}
		if candidateSession.SessionID != session.SessionID ||
			candidateSession.ProductID != session.ProductID ||
			candidateSession.CreatorID != session.CreatorID ||
			candidateSession.Issuer != session.Issuer ||
			candidateSession.Audience != session.Audience ||
			candidateGrant.GrantID != grant.GrantID ||
			candidateGrant.BoundPackageVersionID() != grant.BoundPackageVersionID() ||
			candidateGrant.MaterializationJobID() != grant.MaterializationJobID() {
			return fmt.Errorf("renewed package authorization changed immutable bindings")
		}
		return nil
	}
	now := time.Now()
	authorizationContext.Now = now
	if now.Unix() >= session.ExpiresAt-30 || now.Unix() >= grant.ExpiresAt-30 {
		if _, err := source.Renew(ctx, request.deliveryGrant); err != nil {
			return Result{}, err
		}
		session, grant, err = parseSignedAuthorization(
			source.currentSession,
			source.currentGrant,
			trustDocument,
		)
		if err != nil {
			return Result{}, err
		}
	} else if err := packagecontract.ValidateInstallAuthorization(
		session,
		grant,
		authorizationContext,
	); err != nil {
		return Result{}, err
	}
	if request.Operation == "uninstall" {
		baseResult := Result{
			ActiveContentDigest: request.ApprovedActiveContentDigest,
			ActivePolicyVersion: request.ApprovedPolicyVersion,
			Files:               []ResultFile{},
			JournalState:        "authorized",
			Operation:           request.Operation,
			RunID:               request.RunID,
			SchemaVersion:       SchemaVersion,
			Status:              "succeeded",
			TargetReleaseRoot:   request.TargetReleaseRoot,
			TraceID:             request.Traceparent[3:35],
			VersionID:           grant.UninstallVersionID(),
		}
		if err := report(reportProgress, "verifying", 0, 0); err != nil {
			return Result{}, err
		}
		if err := report(reportProgress, "finalizing", 0, 0); err != nil {
			return Result{}, err
		}
		return baseResult, nil
	}
	manifest, err := delivery.FetchManifest(
		ctx,
		session,
		grant,
		source,
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
		CacheRoot:   filepath.Join(request.StateRoot, "chunk-cache"),
		Destination: stagingTree,
		GrantSource: source,
		Manifest:    manifest,
		ManifestURL: session.Bootstrap.URL,
		PrivateKey:  identity.PrivateKey,
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
		materializationCompletedBytes := staged.LogicalBytes
		rendition, receipt, renditionErr := delivery.FetchProtectedRendition(
			ctx,
			delivery.ProtectedRenditionConfig{
				DownloadRoot: request.StateRoot,
				Grant:        grant,
				GrantSource:  source,
				PrivateKey:   identity.PrivateKey,
				Progress: func(progress delivery.ProtectedRenditionProgress) error {
					materializationCompletedBytes = protectedMaterializationCompletedBytes(
						staged.LogicalBytes,
						totalBytes,
						materializationCompletedBytes,
						progress,
					)
					return report(
						reportProgress,
						"downloading",
						materializationCompletedBytes,
						totalBytes,
					)
				},
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

func protectedMaterializationCompletedBytes(
	stagedBytes int64,
	totalBytes int64,
	currentBytes int64,
	progress delivery.ProtectedRenditionProgress,
) int64 {
	if totalBytes <= stagedBytes {
		return totalBytes
	}
	if materializationSourceAssemblyCompleted(progress) {
		return totalBytes
	}
	candidate := stagedBytes
	if progress.TotalLogicalBytes > 0 {
		ratio := math.Min(
			1,
			float64(progress.CompletedLogicalBytes)/float64(progress.TotalLogicalBytes),
		)
		candidate += int64(math.Round(float64(totalBytes-stagedBytes) * ratio))
	}
	if candidate < currentBytes {
		return currentBytes
	}
	if candidate > totalBytes {
		return totalBytes
	}
	return candidate
}

func materializationSourceAssemblyCompleted(progress delivery.ProtectedRenditionProgress) bool {
	if progress.Stage == "source_assembly" && progress.Status == "completed" {
		return true
	}
	switch progress.Stage {
	case "tree_extraction", "key_derivation", "codec", "archive_build",
		"rendition_verify", "rendition_upload_ticket", "rendition_upload", "completion":
		return true
	default:
		return false
	}
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
	if request.Operation == "uninstall" &&
		request.ExpectedCurrentReleaseRoot != request.TargetReleaseRoot {
		return fmt.Errorf("package lifecycle uninstall release binding is invalid")
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

func parseSignedAuthorization(
	encodedSession string,
	encodedGrant string,
	trustDocument trust.Document,
) (packagecontract.InstallSession, packagecontract.DeliveryGrant, error) {
	sessionEnvelope, err := decodeToken(encodedSession, "install session")
	if err != nil {
		return packagecontract.InstallSession{}, packagecontract.DeliveryGrant{}, err
	}
	sessionPayload, err := packagecontract.VerifySign1(
		sessionEnvelope,
		trustDocument.PackageInstall.PublicKey,
		trustDocument.PackageInstall.KeyID,
		packagecontract.InstallSessionPurpose,
	)
	if err != nil {
		return packagecontract.InstallSession{}, packagecontract.DeliveryGrant{},
			fmt.Errorf("verify install session: %w", err)
	}
	session, err := packagecontract.ParseInstallSession(sessionPayload)
	if err != nil {
		return packagecontract.InstallSession{}, packagecontract.DeliveryGrant{},
			fmt.Errorf("parse install session: %w", err)
	}
	if session.KeyID != string(trustDocument.PackageInstall.KeyID) {
		return packagecontract.InstallSession{}, packagecontract.DeliveryGrant{},
			fmt.Errorf("install session key identifier claim is invalid")
	}
	grantEnvelope, err := decodeToken(encodedGrant, "delivery grant")
	if err != nil {
		return packagecontract.InstallSession{}, packagecontract.DeliveryGrant{}, err
	}
	grantPayload, err := packagecontract.VerifySign1(
		grantEnvelope,
		trustDocument.PackageInstall.PublicKey,
		trustDocument.PackageInstall.KeyID,
		packagecontract.DeliveryGrantPurpose,
	)
	if err != nil {
		return packagecontract.InstallSession{}, packagecontract.DeliveryGrant{},
			fmt.Errorf("verify delivery grant: %w", err)
	}
	grant, err := packagecontract.ParseDeliveryGrant(grantPayload)
	if err != nil {
		return packagecontract.InstallSession{}, packagecontract.DeliveryGrant{},
			fmt.Errorf("parse delivery grant: %w", err)
	}
	return session, grant, nil
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
