package lifecycle

import (
	"context"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
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
	SchemaVersion                     = 4
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
	if request.Operation != "preflight" &&
		(request.ApprovedActiveContentDigest != manifest.ActiveContentDigest ||
			request.ApprovedPolicyVersion != manifest.ActivePolicyVersion) {
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
	protectedCount := 0
	var commonBytes int64
	for _, file := range manifest.Files {
		if file.Classification == "protected" {
			protectedCount++
		} else {
			commonBytes += file.Bytes
		}
	}
	renditionConfig := delivery.ProtectedRenditionConfig{
		DownloadRoot:     request.StateRoot,
		Grant:            grant,
		GrantSource:      source,
		PrivateKey:       identity.PrivateKey,
		ReceiptAuthority: trustDocument.MaterializationReceipt,
		Session:          session,
	}
	// downloadTotal is the manifest byte total until a v3 coupled receipt
	// arrives; the coupled outputs then replace the manifest's protected
	// byte estimate with the receipt's signed totals.
	downloadTotal := totalBytes
	var encodedReceipt string
	var receipt packagecontract.MaterializationReceipt
	var coupledFiles []delivery.StagedFile
	stageConfig := delivery.StageCommonConfig{
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
	}
	if protectedCount > 0 {
		materializationCompletedBytes := commonBytes
		awaitConfig := renditionConfig
		// The receipt version is unknown while the job is still pending, so
		// the v2 stage-ratio estimate covers the wait for both versions;
		// coupled v3 downloads then report real byte counts.
		awaitConfig.Progress = func(progress delivery.ProtectedRenditionProgress) error {
			materializationCompletedBytes = protectedMaterializationCompletedBytes(
				commonBytes,
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
		}
		stageConfig.Populate = func(
			hookCtx context.Context,
			stageRoot *os.Root,
		) error {
			awaited, awaitedReceipt, awaitErr := delivery.AwaitMaterializationReceipt(
				hookCtx,
				awaitConfig,
			)
			if awaitErr != nil {
				return awaitErr
			}
			encodedReceipt = awaited
			receipt = awaitedReceipt
			if receipt.HasRendition() {
				return nil
			}
			if validateErr := delivery.ValidateCoupledReceipt(
				manifest,
				receipt,
			); validateErr != nil {
				return validateErr
			}
			var coupledTotal int64
			for _, file := range receipt.OutputFiles {
				coupledTotal += file.Bytes
			}
			downloadTotal = commonBytes + coupledTotal
			files, coupledErr := delivery.FetchCoupledFiles(hookCtx, delivery.CoupledFetchConfig{
				Audience:    session.Audience,
				CacheRoot:   filepath.Join(request.StateRoot, "coupled-cache"),
				GrantSource: source,
				JobID:       grant.MaterializationJobID(),
				PrivateKey:  identity.PrivateKey,
				Progress: func(completedBytes int64, _ int64) error {
					return report(
						reportProgress,
						"downloading",
						commonBytes+completedBytes,
						downloadTotal,
					)
				},
				Receipt:   receipt,
				StageRoot: stageRoot,
			})
			if coupledErr != nil {
				return coupledErr
			}
			coupledFiles = files
			return nil
		}
	}
	staged, err := delivery.StageCommonTree(ctx, stageConfig)
	if err != nil {
		return Result{}, err
	}
	allFiles := append([]delivery.StagedFile(nil), staged.Files...)
	if protectedCount > 0 {
		if receipt.HasRendition() {
			rendition, renditionErr := delivery.DownloadProtectedRendition(
				ctx,
				renditionConfig,
				encodedReceipt,
				receipt,
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
			allFiles = append(allFiles, protectedFiles...)
		} else {
			allFiles = append(allFiles, coupledFiles...)
		}
		receiptPath, persistErr := persistReceipt(
			request.StateRoot,
			receipt.ReceiptID,
			encodedReceipt,
		)
		if persistErr != nil {
			return Result{}, persistErr
		}
		baseResult.ReceiptID = receipt.ReceiptID
		baseResult.ReceiptPath = receiptPath
	}
	totalBytes = downloadTotal
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
	if request.Operation == "preflight" {
		baseResult.JournalState = "preflight-review-ready"
	} else {
		baseResult.JournalState = "verified-staging-ready"
	}
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
	cleanupAfterInstall(request.StateRoot, grant.MaterializationJobID(), manifest, receipt)
	return baseResult, nil
}

const (
	chunkCacheMaximumBytes   = 2 << 30
	coupledCacheMaximumBytes = 2 << 30
)

// Cleanup is best-effort after the verified staging tree is durable.
func cleanupAfterInstall(
	stateRoot string,
	jobID string,
	manifest delivery.Manifest,
	receipt packagecontract.MaterializationReceipt,
) {
	if safeIdentifier.MatchString(jobID) {
		_ = os.RemoveAll(filepath.Join(stateRoot, "renditions", jobID))
	}
	referenced := make(map[string]struct{})
	for _, file := range manifest.Files {
		for _, chunk := range file.Chunks {
			referenced[chunk.ID] = struct{}{}
		}
	}
	pruneChunkCache(
		filepath.Join(stateRoot, "chunk-cache"),
		chunkCacheMaximumBytes,
		referenced,
	)
	referencedCoupled := make(map[string]struct{}, len(receipt.OutputFiles))
	for _, file := range receipt.OutputFiles {
		referencedCoupled[hex.EncodeToString(file.SHA256[:])] = struct{}{}
	}
	pruneChunkCache(
		filepath.Join(stateRoot, "coupled-cache"),
		coupledCacheMaximumBytes,
		referencedCoupled,
	)
}

type cachedChunkFile struct {
	modTime time.Time
	path    string
	size    int64
}

// Preserve the completed install's chunks while evicting the oldest others.
func pruneChunkCache(cacheRoot string, maximumBytes int64, referenced map[string]struct{}) {
	var files []cachedChunkFile
	var totalBytes int64
	_ = filepath.WalkDir(cacheRoot, func(path string, entry fs.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return nil
		}
		info, infoErr := entry.Info()
		if infoErr != nil {
			return nil
		}
		totalBytes += info.Size()
		if _, keep := referenced[entry.Name()]; keep {
			return nil
		}
		files = append(files, cachedChunkFile{
			modTime: info.ModTime(),
			path:    path,
			size:    info.Size(),
		})
		return nil
	})
	if totalBytes <= maximumBytes {
		return
	}
	sort.Slice(files, func(left int, right int) bool {
		return files[left].modTime.Before(files[right].modTime)
	})
	for _, file := range files {
		if totalBytes <= maximumBytes {
			return
		}
		if os.Remove(file.path) == nil {
			totalBytes -= file.size
		}
	}
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
	ratio := protectedMaterializationStageRatio(progress)
	candidate := stagedBytes +
		int64(math.Round(float64(totalBytes-stagedBytes)*ratio))
	if candidate < currentBytes {
		return currentBytes
	}
	if candidate >= totalBytes {
		return totalBytes - 1
	}
	return candidate
}

func protectedMaterializationStageRatio(progress delivery.ProtectedRenditionProgress) float64 {
	const (
		sourceAssemblyShare = 0.70
		codecShare          = 0.25
		archiveShare        = 0.02
		verificationShare   = 0.02
	)
	switch progress.Stage {
	case "source_assembly":
		var sourceRatio float64
		if progress.TotalLogicalBytes > 0 {
			sourceRatio = math.Min(
				1,
				float64(progress.CompletedLogicalBytes)/
					float64(progress.TotalLogicalBytes),
			)
		} else if progress.Status == "completed" {
			sourceRatio = 1
		}
		return sourceAssemblyShare * sourceRatio
	case "tree_extraction", "key_derivation":
		return sourceAssemblyShare
	case "codec":
		var codecRatio float64
		if progress.TotalFiles > 0 {
			codecRatio = math.Min(
				1,
				float64(progress.CompletedFiles)/float64(progress.TotalFiles),
			)
		} else if progress.Status == "completed" {
			codecRatio = 1
		}
		return sourceAssemblyShare + codecShare*codecRatio
	case "archive_build":
		ratio := sourceAssemblyShare + codecShare
		if progress.Status == "completed" {
			ratio += archiveShare
		}
		return ratio
	case "rendition_verify":
		ratio := sourceAssemblyShare + codecShare + archiveShare
		if progress.Status == "completed" {
			ratio += verificationShare
		}
		return ratio
	case "rendition_upload_ticket", "rendition_upload", "completion":
		return sourceAssemblyShare + codecShare + archiveShare + verificationShare
	default:
		return 0
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
