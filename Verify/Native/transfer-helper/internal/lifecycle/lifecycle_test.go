package lifecycle

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/yucp/transfer-helper/internal/delivery"
	"github.com/yucp/transfer-helper/internal/deviceidentity"
	"github.com/yucp/transfer-helper/internal/packagecontract"
	"github.com/yucp/transfer-helper/internal/trust"
)

func TestProtectedMaterializationProgressAdvancesRemainingProtectedBytes(t *testing.T) {
	progress := delivery.ProtectedRenditionProgress{
		CompletedLogicalBytes: 1_024,
		Stage:                 "source_assembly",
		Status:                "progress",
		TotalLogicalBytes:     4_096,
	}
	completed := protectedMaterializationCompletedBytes(90, 100, 90, progress)
	if completed != 92 {
		t.Fatalf("completed bytes = %d; want 92", completed)
	}
	progress.CompletedLogicalBytes = 512
	if regressed := protectedMaterializationCompletedBytes(90, 100, completed, progress); regressed != 92 {
		t.Fatalf("regressed bytes = %d; want 92", regressed)
	}
	progress.Stage = "tree_extraction"
	progress.Status = "started"
	if extracted := protectedMaterializationCompletedBytes(90, 100, completed, progress); extracted != 97 {
		t.Fatalf("post-assembly bytes = %d; want 97", extracted)
	}
	progress.Stage = "codec"
	progress.CompletedFiles = 2
	progress.TotalFiles = 4
	if coupled := protectedMaterializationCompletedBytes(90, 100, completed, progress); coupled != 98 {
		t.Fatalf("codec bytes = %d; want 98", coupled)
	}
	progress.Stage = "rendition_verify"
	progress.Status = "completed"
	if verified := protectedMaterializationCompletedBytes(90, 100, completed, progress); verified != 99 {
		t.Fatalf("verified bytes = %d; want 99", verified)
	}
}

func TestTelemetryLifecycleFailureMessageDoesNotIncludeOperationalErrorText(t *testing.T) {
	err := errors.New(`open C:\Users\buyer\project\token-secret: access denied`)
	if message := telemetryFailureMessage(err); message != "package lifecycle failed" {
		t.Fatalf("telemetryFailureMessage() = %q", message)
	}
}

func TestReportProgressSafelyAllowsNilReporter(t *testing.T) {
	if err := reportProgressSafely(nil, "download", 1, 2, 1, 2); err != nil {
		t.Fatalf("reportProgressSafely() error = %v", err)
	}
}

func TestValidateUnityProjectPathsRejectsTheWindowsLimit(t *testing.T) {
	normalizedPath := "Packages/com.example.product/Resources/long-file-name.png"
	projectPath := `C:\` + strings.Repeat(
		"p",
		260-len(`C:\`)-1-len(normalizedPath),
	)

	err := validateUnityProjectPaths(
		"windows",
		projectPath,
		[]delivery.File{{NormalizedPath: normalizedPath}},
	)
	if err == nil {
		t.Fatal("validateUnityProjectPaths() accepted a 260-character Windows path")
	}
	if ErrorCode(err) != UnityWindowsPathLimitErrorCode {
		t.Fatalf("ErrorCode() = %q, error = %v", ErrorCode(err), err)
	}

	shorterProjectPath := projectPath[:len(projectPath)-1]
	if err := validateUnityProjectPaths(
		"windows",
		shorterProjectPath,
		[]delivery.File{{NormalizedPath: normalizedPath}},
	); err != nil {
		t.Fatalf("validateUnityProjectPaths() rejected a 259-character path: %v", err)
	}
	if err := validateUnityProjectPaths(
		"linux",
		projectPath,
		[]delivery.File{{NormalizedPath: normalizedPath}},
	); err != nil {
		t.Fatalf("validateUnityProjectPaths() rejected a Linux path: %v", err)
	}
}

func TestNewAuthorizedRequestRejectsMissingInternalBindings(t *testing.T) {
	valid := OperationInput{
		AliasID:                    "alias-1",
		ExpectedCurrentReleaseRoot: strings.Repeat("00", 32),
		IdempotencyKey:             "preflight-alias-1",
		Operation:                  "preflight",
		ProjectIdentity:            strings.Repeat("22", 32),
		ProjectPath:                t.TempDir(),
		RunID:                      "run-preflight-alias-1",
		StateRoot:                  t.TempDir(),
		TargetReleaseRoot:          strings.Repeat("11", 32),
		Traceparent:                "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
	}
	tests := []struct {
		name   string
		mutate func(*OperationInput)
	}{
		{
			name: "idempotency key",
			mutate: func(input *OperationInput) {
				input.IdempotencyKey = ""
			},
		},
		{
			name: "trace context",
			mutate: func(input *OperationInput) {
				input.Traceparent =
					"00-00000000000000000000000000000000-0123456789abcdef-01"
			},
		},
		{
			name: "preflight approval",
			mutate: func(input *OperationInput) {
				input.ApprovedActiveContentDigest = strings.Repeat("33", 32)
				input.ApprovedPolicyVersion = "policy-v1"
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			input := valid
			test.mutate(&input)
			if _, err := NewAuthorizedRequest(
				input,
				"signed-install-session",
				"signed-delivery-grant",
			); err == nil {
				t.Fatal("NewAuthorizedRequest() accepted an invalid internal binding")
			}
		})
	}
}

func TestExecutePreflightThenStagesVerifiedCommonTree(t *testing.T) {
	content := []byte("complete lifecycle\n")
	fileDigest := sha256.Sum256(content)
	chunkIDBytes := sha256.Sum256([]byte("creator-common-domain"))
	chunkID := hex.EncodeToString(chunkIDBytes[:])
	var manifestBytes []byte
	var chunkReads int
	var manifestReads int
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/v2/delivery/version-1/manifest":
			manifestReads++
			if request.Header.Get("Authorization") == "" || request.Header.Get("DPoP") == "" {
				http.Error(response, "forbidden", http.StatusForbidden)
				return
			}
			_, _ = response.Write(manifestBytes)
		case "/v2/delivery/version-1/chunks/" + chunkID:
			chunkReads++
			if request.Header.Get("Authorization") == "" || request.Header.Get("DPoP") == "" {
				http.Error(response, "forbidden", http.StatusForbidden)
				return
			}
			_, _ = response.Write(content)
		default:
			http.NotFound(response, request)
		}
	}))
	defer server.Close()

	manifestBytes, releaseRoot, bindingRoot := lifecycleManifest(
		t,
		server.URL,
		content,
		fileDigest,
		chunkID,
	)
	manifestDigest := sha256.Sum256(manifestBytes)
	stateRoot := filepath.Join(t.TempDir(), "state")
	identity, err := deviceidentity.LoadOrCreate(stateRoot)
	if err != nil {
		t.Fatalf("LoadOrCreate() error = %v", err)
	}
	deviceDigest, err := hex.DecodeString(identity.Thumbprint)
	if err != nil {
		t.Fatalf("decode device thumbprint: %v", err)
	}
	seed := sha256.Sum256([]byte("lifecycle install signing key"))
	privateKey := ed25519.NewKeyFromSeed(seed[:])
	keyID := []byte("install-test-key")
	now := time.Now().Unix()
	signSession := func(operation string) []byte {
		return signLifecycleContract(
			t,
			privateKey,
			keyID,
			packagecontract.InstallSessionPurpose,
			map[any]any{
				int64(0):  int64(2),
				int64(1):  packagecontract.InstallSessionTokenType,
				int64(2):  server.URL,
				int64(3):  server.URL,
				int64(4):  string(keyID),
				int64(5):  "creator-1",
				int64(6):  "buyer-1",
				int64(7):  "product-1",
				int64(8):  "1.0.0",
				int64(9):  "alias-1",
				int64(10): releaseRoot[:],
				int64(11): bindingRoot[:],
				int64(12): deviceDigest,
				int64(13): []any{server.URL},
				int64(14): []any{server.URL},
				int64(15): []any{map[any]any{
					int64(0): "logical-tree-manifest-v4",
					int64(1): server.URL + "/v2/delivery/version-1/manifest",
					int64(2): manifestDigest[:],
				}},
				int64(16): now,
				int64(17): now,
				int64(18): now + 300,
				int64(19): "session-1",
				int64(20): int64(300),
				int64(21): operation,
			},
		)
	}
	session := signSession("preflight")
	signGrant := func(scope string) []byte {
		return signLifecycleContract(t, privateKey, keyID, packagecontract.DeliveryGrantPurpose, map[any]any{
			int64(0):  int64(2),
			int64(1):  "grant-1",
			int64(2):  server.URL,
			int64(3):  server.URL,
			int64(4):  "creator-1",
			int64(5):  "buyer-1",
			int64(6):  "product-1",
			int64(7):  releaseRoot[:],
			int64(8):  bindingRoot[:],
			int64(9):  deviceDigest,
			int64(10): now,
			int64(11): now,
			int64(12): now + 300,
			int64(13): []any{scope},
			int64(14): "session-1",
		})
	}
	grant := signGrant("package:version-1:read")
	authority := trust.Authority{
		KeyID:     keyID,
		PublicKey: privateKey.Public().(ed25519.PublicKey),
	}
	trustDocument := trust.Document{
		MaterializationReceipt: trust.Authority{
			KeyID:     []byte("receipt-test-key"),
			PublicKey: privateKey.Public().(ed25519.PublicKey),
		},
		PackageInstall: authority,
	}
	baseInput := OperationInput{
		AliasID:                    "alias-1",
		ExpectedCurrentReleaseRoot: hex.EncodeToString(make([]byte, 32)),
		IdempotencyKey:             "lifecycle-alias-1",
		ProjectIdentity:            hex.EncodeToString(make([]byte, 32)),
		ProjectPath:                t.TempDir(),
		StateRoot:                  stateRoot,
		TargetReleaseRoot:          hex.EncodeToString(releaseRoot[:]),
		Traceparent:                "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
	}
	preflightInput := baseInput
	preflightInput.Operation = "preflight"
	preflightInput.RunID = "run-preflight"
	preflightRequest, err := NewAuthorizedRequest(
		preflightInput,
		base64.RawURLEncoding.EncodeToString(session),
		base64.RawURLEncoding.EncodeToString(grant),
	)
	if err != nil {
		t.Fatalf("NewAuthorizedRequest(preflight) error = %v", err)
	}
	preflight, err := Execute(
		context.Background(),
		preflightRequest,
		identity,
		trustDocument,
		nil,
	)
	if err != nil {
		t.Fatalf("Execute(preflight) error = %v", err)
	}
	if preflight.ActiveContentDigest != hex.EncodeToString(make([]byte, 32)) ||
		preflight.ActivePolicyVersion != "active-content-policy-v1" ||
		preflight.TraceID != baseInput.Traceparent[3:35] ||
		preflight.StagingTree == "" ||
		preflight.JournalState != "preflight-review-ready" ||
		len(preflight.Files) != 1 ||
		chunkReads != 1 {
		t.Fatalf("Execute(preflight) = %#v, chunk reads = %d", preflight, chunkReads)
	}
	preflightStaged, err := os.ReadFile(
		filepath.Join(preflight.StagingTree, "Assets", "Product", "file.txt"),
	)
	if err != nil || string(preflightStaged) != string(content) {
		t.Fatalf(
			"read preflight staged lifecycle file: %v, content = %q",
			err,
			preflightStaged,
		)
	}

	installInput := baseInput
	installInput.Operation = "install"
	installInput.RunID = "run-install"
	installInput.ApprovedActiveContentDigest = preflight.ActiveContentDigest
	installInput.ApprovedPolicyVersion = preflight.ActivePolicyVersion
	installRequest, err := NewAuthorizedRequest(
		installInput,
		base64.RawURLEncoding.EncodeToString(signSession("install")),
		base64.RawURLEncoding.EncodeToString(grant),
	)
	if err != nil {
		t.Fatalf("NewAuthorizedRequest(install) error = %v", err)
	}
	var progressEvents []struct {
		phase     string
		completed int64
		total     int64
	}
	installed, err := Execute(
		context.Background(),
		installRequest,
		identity,
		trustDocument,
		func(phase string, completedBytes int64, totalBytes int64, _ int64, _ int64) error {
			progressEvents = append(progressEvents, struct {
				phase     string
				completed int64
				total     int64
			}{
				phase:     phase,
				completed: completedBytes,
				total:     totalBytes,
			})
			return nil
		},
	)
	if err != nil {
		t.Fatalf("Execute(install) error = %v", err)
	}
	staged, err := os.ReadFile(
		filepath.Join(installed.StagingTree, "Assets", "Product", "file.txt"),
	)
	if err != nil {
		t.Fatalf("read staged lifecycle file: %v", err)
	}
	if string(staged) != string(content) || chunkReads != 1 || len(installed.Files) != 1 {
		t.Fatalf(
			"staged = %q, chunk reads = %d, result = %#v",
			staged,
			chunkReads,
			installed,
		)
	}
	var sawLiveBytes bool
	phaseRank := map[string]int{
		"preparing":   0,
		"downloading": 1,
		"verifying":   2,
		"assembling":  3,
		"finalizing":  4,
	}
	previousRank := -1
	for _, event := range progressEvents {
		rank, known := phaseRank[event.phase]
		if !known || rank < previousRank {
			t.Fatalf("progress phases are not monotonic: %#v", progressEvents)
		}
		previousRank = rank
		if event.phase == "downloading" &&
			event.completed == int64(len(content)) &&
			event.total == int64(len(content)) {
			sawLiveBytes = true
		}
	}
	if !sawLiveBytes ||
		progressEvents[len(progressEvents)-1].phase != "finalizing" {
		t.Fatalf("progress events = %#v", progressEvents)
	}

	for _, operation := range []string{"update", "repair", "rollback"} {
		input := baseInput
		input.Operation = operation
		input.RunID = "run-" + operation
		input.ApprovedActiveContentDigest = preflight.ActiveContentDigest
		input.ApprovedPolicyVersion = preflight.ActivePolicyVersion
		request, requestErr := NewAuthorizedRequest(
			input,
			base64.RawURLEncoding.EncodeToString(signSession(operation)),
			base64.RawURLEncoding.EncodeToString(grant),
		)
		if requestErr != nil {
			t.Fatalf("NewAuthorizedRequest(%s) error = %v", operation, requestErr)
		}
		result, executeErr := Execute(
			context.Background(),
			request,
			identity,
			trustDocument,
			nil,
		)
		if executeErr != nil {
			t.Fatalf("Execute(%s) error = %v", operation, executeErr)
		}
		if result.Operation != operation ||
			result.JournalState != "verified-staging-ready" ||
			len(result.Files) != 1 {
			t.Fatalf("Execute(%s) = %#v", operation, result)
		}
	}

	uninstallInput := baseInput
	uninstallInput.Operation = "uninstall"
	uninstallInput.RunID = "run-uninstall"
	uninstallInput.ApprovedActiveContentDigest = preflight.ActiveContentDigest
	uninstallInput.ApprovedPolicyVersion = preflight.ActivePolicyVersion
	uninstallInput.ExpectedCurrentReleaseRoot = uninstallInput.TargetReleaseRoot
	uninstallRequest, err := NewAuthorizedRequest(
		uninstallInput,
		base64.RawURLEncoding.EncodeToString(signSession("uninstall")),
		base64.RawURLEncoding.EncodeToString(signGrant("package:version-1:uninstall")),
	)
	if err != nil {
		t.Fatalf("NewAuthorizedRequest(uninstall) error = %v", err)
	}
	chunkReadsBeforeUninstall := chunkReads
	manifestReadsBeforeUninstall := manifestReads
	uninstalled, err := Execute(
		context.Background(),
		uninstallRequest,
		identity,
		trustDocument,
		nil,
	)
	if err != nil {
		t.Fatalf("Execute(uninstall) error = %v", err)
	}
	if manifestReads != manifestReadsBeforeUninstall ||
		chunkReads != chunkReadsBeforeUninstall ||
		uninstalled.JournalState != "authorized" ||
		uninstalled.StagingTree != "" ||
		len(uninstalled.Files) != 0 {
		t.Fatalf(
			"Execute(uninstall) = %#v, manifest reads changed from %d to %d, chunk reads changed from %d to %d",
			uninstalled,
			manifestReadsBeforeUninstall,
			manifestReads,
			chunkReadsBeforeUninstall,
			chunkReads,
		)
	}
}

func TestExecuteUninstallsSupersededReleaseWithoutPayloadRead(t *testing.T) {
	var payloadReads atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(
		response http.ResponseWriter,
		_ *http.Request,
	) {
		payloadReads.Add(1)
		http.Error(response, "payload access is forbidden", http.StatusForbidden)
	}))
	defer server.Close()
	stateRoot := filepath.Join(t.TempDir(), "state")
	identity, err := deviceidentity.LoadOrCreate(stateRoot)
	if err != nil {
		t.Fatalf("LoadOrCreate() error = %v", err)
	}
	deviceDigest, err := hex.DecodeString(identity.Thumbprint)
	if err != nil {
		t.Fatalf("decode device thumbprint: %v", err)
	}
	releaseRoot := sha256.Sum256([]byte("superseded release"))
	bindingRoot := sha256.Sum256([]byte("superseded binding"))
	manifestDigest := sha256.Sum256([]byte("deleted manifest"))
	seed := sha256.Sum256([]byte("superseded uninstall signing key"))
	privateKey := ed25519.NewKeyFromSeed(seed[:])
	keyID := []byte("install-test-key")
	now := time.Now().Unix()
	session := signLifecycleContract(
		t,
		privateKey,
		keyID,
		packagecontract.InstallSessionPurpose,
		map[any]any{
			int64(0):  int64(2),
			int64(1):  packagecontract.InstallSessionTokenType,
			int64(2):  server.URL,
			int64(3):  server.URL,
			int64(4):  string(keyID),
			int64(5):  "creator-1",
			int64(6):  "buyer-1",
			int64(7):  "product-1",
			int64(8):  "1.0.0",
			int64(9):  "alias-1",
			int64(10): releaseRoot[:],
			int64(11): bindingRoot[:],
			int64(12): deviceDigest,
			int64(13): []any{server.URL},
			int64(14): []any{server.URL},
			int64(15): []any{map[any]any{
				int64(0): "logical-tree-manifest-v4",
				int64(1): server.URL + "/v2/delivery/version-superseded/manifest",
				int64(2): manifestDigest[:],
			}},
			int64(16): now,
			int64(17): now,
			int64(18): now + 300,
			int64(19): "session-superseded",
			int64(20): int64(300),
			int64(21): "uninstall",
		},
	)
	grant := signLifecycleContract(
		t,
		privateKey,
		keyID,
		packagecontract.DeliveryGrantPurpose,
		map[any]any{
			int64(0):  int64(2),
			int64(1):  "grant-superseded",
			int64(2):  server.URL,
			int64(3):  server.URL,
			int64(4):  "creator-1",
			int64(5):  "buyer-1",
			int64(6):  "product-1",
			int64(7):  releaseRoot[:],
			int64(8):  bindingRoot[:],
			int64(9):  deviceDigest,
			int64(10): now,
			int64(11): now,
			int64(12): now + 300,
			int64(13): []any{"package:version-superseded:uninstall"},
			int64(14): "session-superseded",
		},
	)
	releaseRootHex := hex.EncodeToString(releaseRoot[:])
	request, err := NewAuthorizedRequest(
		OperationInput{
			AliasID:                     "alias-1",
			ApprovedActiveContentDigest: hex.EncodeToString(make([]byte, 32)),
			ApprovedPolicyVersion:       "active-content-policy-v1",
			ExpectedCurrentReleaseRoot:  releaseRootHex,
			IdempotencyKey:              "uninstall-superseded",
			Operation:                   "uninstall",
			ProjectIdentity:             hex.EncodeToString(make([]byte, 32)),
			ProjectPath:                 t.TempDir(),
			RunID:                       "run-uninstall-superseded",
			StateRoot:                   stateRoot,
			TargetReleaseRoot:           releaseRootHex,
			Traceparent: "00-0123456789abcdef0123456789abcdef-" +
				"0123456789abcdef-01",
		},
		base64.RawURLEncoding.EncodeToString(session),
		base64.RawURLEncoding.EncodeToString(grant),
	)
	if err != nil {
		t.Fatalf("NewAuthorizedRequest() error = %v", err)
	}

	result, err := Execute(
		context.Background(),
		request,
		identity,
		trust.Document{
			PackageInstall: trust.Authority{
				KeyID:     keyID,
				PublicKey: privateKey.Public().(ed25519.PublicKey),
			},
		},
		nil,
	)

	if err != nil {
		t.Fatalf("Execute() error = %v", err)
	}
	if payloadReads.Load() != 0 ||
		result.JournalState != "authorized" ||
		result.VersionID != "version-superseded" {
		t.Fatalf("Execute() = %#v, payload reads = %d", result, payloadReads.Load())
	}
}

func lifecycleManifest(
	t *testing.T,
	origin string,
	content []byte,
	fileDigest [32]byte,
	chunkID string,
) ([]byte, [32]byte, [32]byte) {
	t.Helper()
	fileMap := map[any]any{
		int64(0): "Assets/Product/file.txt",
		int64(1): int64(len(content)),
		int64(2): fileDigest[:],
		int64(3): "common",
		int64(4): "",
	}
	commonPayload := mustLifecycleCanonical(t, map[any]any{
		int64(0): int64(4),
		int64(1): []any{fileMap},
	})
	commonRoot, err := packagecontract.DomainHash("yucp:common-source-tree:v4", commonPayload)
	if err != nil {
		t.Fatalf("DomainHash(common) error = %v", err)
	}
	protectedPayload := mustLifecycleCanonical(t, map[any]any{
		int64(0): int64(4),
		int64(1): []any{},
	})
	protectedRoot, err := packagecontract.DomainHash(
		"yucp:protected-source-tree:v4",
		protectedPayload,
	)
	if err != nil {
		t.Fatalf("DomainHash(protected) error = %v", err)
	}
	releasePayload := mustLifecycleCanonical(t, map[any]any{
		int64(0): int64(4),
		int64(1): "logical-release-v4",
		int64(2): "product-1",
		int64(3): "1.0.0",
		int64(4): "version-1",
		int64(5): []any{fileMap},
		int64(6): commonRoot[:],
		int64(7): protectedRoot[:],
	})
	releaseRoot, err := packagecontract.DomainHash("yucp:logical-release:v4", releasePayload)
	if err != nil {
		t.Fatalf("DomainHash(release) error = %v", err)
	}
	manifestValue := map[string]any{
		"activeContentDigest": hex.EncodeToString(make([]byte, 32)),
		"activePolicyVersion": "active-content-policy-v1",
		"bootstrapMedia": []any{map[string]any{
			"kind":    "product-link",
			"label":   "Store",
			"ordinal": 0,
			"url":     "https://store.example.test/product",
		}},
		"chunkAvgKib":                256,
		"commonRoot":                 hex.EncodeToString(commonRoot[:]),
		"normalizationPolicyVersion": "package-normalization-policy-v2",
		"files": []any{map[string]any{
			"bytes":          len(content),
			"chunks":         []any{map[string]any{"id": chunkID, "sha256": hex.EncodeToString(fileDigest[:]), "size": len(content)}},
			"classification": "common",
			"normalizedPath": "Assets/Product/file.txt",
			"sha256":         hex.EncodeToString(fileDigest[:]),
		}},
		"packageId":              "product-1",
		"protectedSourceRoot":    hex.EncodeToString(protectedRoot[:]),
		"protectionPolicyDigest": hex.EncodeToString(make([]byte, 32)),
		"protectionPolicyId":     "supported-visual-assets-v2",
		"releaseRoot":            hex.EncodeToString(releaseRoot[:]),
		"schemaVersion":          4,
		"storageFormatVersion":   "desync-uncompressed-sha256-v1",
		"version":                "1.0.0",
		"versionId":              "version-1",
	}
	manifest, err := json.Marshal(manifestValue)
	if err != nil {
		t.Fatalf("Marshal(manifest) error = %v", err)
	}
	manifestDigest := sha256.Sum256(manifest)
	bindingPayload := mustLifecycleCanonical(t, map[any]any{
		int64(0): int64(4),
		int64(1): releaseRoot[:],
		int64(2): manifestDigest[:],
		int64(3): commonRoot[:],
		int64(4): protectedRoot[:],
	})
	bindingRoot, err := packagecontract.DomainHash("yucp:delivery-binding:v3", bindingPayload)
	if err != nil {
		t.Fatalf("DomainHash(binding) error = %v", err)
	}
	_ = origin
	return manifest, releaseRoot, bindingRoot
}

func signLifecycleContract(
	t *testing.T,
	privateKey ed25519.PrivateKey,
	keyID []byte,
	purpose string,
	payload any,
) []byte {
	t.Helper()
	payloadBytes := mustLifecycleCanonical(t, payload)
	protected := mustLifecycleCanonical(t, map[any]any{
		int64(1):    int64(-8),
		int64(2):    []any{int64(1001)},
		int64(4):    keyID,
		int64(1001): purpose,
	})
	signatureStructure := mustLifecycleCanonical(t, []any{
		"Signature1",
		protected,
		[]byte{},
		payloadBytes,
	})
	return mustLifecycleCanonical(t, []any{
		protected,
		map[any]any{},
		payloadBytes,
		ed25519.Sign(privateKey, signatureStructure),
	})
}

func mustLifecycleCanonical(t *testing.T, value any) []byte {
	t.Helper()
	data, err := packagecontract.EncodeCanonical(value)
	if err != nil {
		t.Fatalf("EncodeCanonical() error = %v", err)
	}
	return data
}

// protectedLifecycleManifest builds a manifest with one common and one
// protected file plus the roots the session and grant must bind.
func protectedLifecycleManifest(
	t *testing.T,
	commonContent []byte,
	commonDigest [32]byte,
	commonChunkID string,
	protectedSource []byte,
	protectedSourceDigest [32]byte,
) ([]byte, [32]byte, [32]byte) {
	t.Helper()
	commonFileMap := map[any]any{
		int64(0): "Assets/Product/file.txt",
		int64(1): int64(len(commonContent)),
		int64(2): commonDigest[:],
		int64(3): "common",
		int64(4): "",
	}
	protectedFileMap := map[any]any{
		int64(0): "Assets/Product/protected.png",
		int64(1): int64(len(protectedSource)),
		int64(2): protectedSourceDigest[:],
		int64(3): "protected",
		int64(4): "png-dct-qim-v2",
	}
	commonRoot, err := packagecontract.DomainHash(
		"yucp:common-source-tree:v4",
		mustLifecycleCanonical(t, map[any]any{
			int64(0): int64(4),
			int64(1): []any{commonFileMap},
		}),
	)
	if err != nil {
		t.Fatalf("DomainHash(common) error = %v", err)
	}
	protectedRoot, err := packagecontract.DomainHash(
		"yucp:protected-source-tree:v4",
		mustLifecycleCanonical(t, map[any]any{
			int64(0): int64(4),
			int64(1): []any{protectedFileMap},
		}),
	)
	if err != nil {
		t.Fatalf("DomainHash(protected) error = %v", err)
	}
	releaseRoot, err := packagecontract.DomainHash(
		"yucp:logical-release:v4",
		mustLifecycleCanonical(t, map[any]any{
			int64(0): int64(4),
			int64(1): "logical-release-v4",
			int64(2): "product-1",
			int64(3): "1.0.0",
			int64(4): "version-1",
			int64(5): []any{commonFileMap, protectedFileMap},
			int64(6): commonRoot[:],
			int64(7): protectedRoot[:],
		}),
	)
	if err != nil {
		t.Fatalf("DomainHash(release) error = %v", err)
	}
	protectedChunkID := sha256.Sum256([]byte("protected-source-chunk"))
	manifestValue := map[string]any{
		"activeContentDigest":        hex.EncodeToString(make([]byte, 32)),
		"activePolicyVersion":        "active-content-policy-v1",
		"chunkAvgKib":                256,
		"commonRoot":                 hex.EncodeToString(commonRoot[:]),
		"normalizationPolicyVersion": "package-normalization-policy-v2",
		"files": []any{
			map[string]any{
				"bytes": len(commonContent),
				"chunks": []any{map[string]any{
					"id":     commonChunkID,
					"sha256": hex.EncodeToString(commonDigest[:]),
					"size":   len(commonContent),
				}},
				"classification": "common",
				"normalizedPath": "Assets/Product/file.txt",
				"sha256":         hex.EncodeToString(commonDigest[:]),
			},
			map[string]any{
				"bytes": len(protectedSource),
				"chunks": []any{map[string]any{
					"id":     hex.EncodeToString(protectedChunkID[:]),
					"sha256": hex.EncodeToString(protectedSourceDigest[:]),
					"size":   len(protectedSource),
				}},
				"classification":   "protected",
				"materializerType": "png-dct-qim-v2",
				"normalizedPath":   "Assets/Product/protected.png",
				"sha256":           hex.EncodeToString(protectedSourceDigest[:]),
			},
		},
		"packageId":              "product-1",
		"protectedSourceRoot":    hex.EncodeToString(protectedRoot[:]),
		"protectionPolicyDigest": hex.EncodeToString(make([]byte, 32)),
		"protectionPolicyId":     "supported-visual-assets-v2",
		"releaseRoot":            hex.EncodeToString(releaseRoot[:]),
		"schemaVersion":          4,
		"storageFormatVersion":   "desync-uncompressed-sha256-v1",
		"version":                "1.0.0",
		"versionId":              "version-1",
	}
	manifest, err := json.Marshal(manifestValue)
	if err != nil {
		t.Fatalf("Marshal(manifest) error = %v", err)
	}
	manifestDigest := sha256.Sum256(manifest)
	bindingRoot, err := packagecontract.DomainHash(
		"yucp:delivery-binding:v3",
		mustLifecycleCanonical(t, map[any]any{
			int64(0): int64(4),
			int64(1): releaseRoot[:],
			int64(2): manifestDigest[:],
			int64(3): commonRoot[:],
			int64(4): protectedRoot[:],
		}),
	)
	if err != nil {
		t.Fatalf("DomainHash(binding) error = %v", err)
	}
	return manifest, releaseRoot, bindingRoot
}

func lifecycleOutputTreeRoot(path string, digest [32]byte, size uint64) [32]byte {
	hasher := sha256.New()
	_, _ = hasher.Write([]byte("yucp:output-tree:v2"))
	for _, field := range [][]byte{
		[]byte(path),
		digest[:],
		binary.BigEndian.AppendUint64(nil, size),
	} {
		_, _ = hasher.Write(binary.BigEndian.AppendUint64(nil, uint64(len(field))))
		_, _ = hasher.Write(field)
	}
	var result [32]byte
	copy(result[:], hasher.Sum(nil))
	return result
}

func TestExecuteRoutesProtectedDeliveryByReceiptVersion(t *testing.T) {
	for _, test := range []struct {
		name    string
		purpose string
	}{
		{name: "v3 coupled per-file", purpose: packagecontract.MaterializationReceiptPurposeV3},
		{name: "v2 rendition zip", purpose: packagecontract.MaterializationReceiptPurpose},
	} {
		t.Run(test.name, func(t *testing.T) {
			commonContent := []byte("common lifecycle\n")
			commonDigest := sha256.Sum256(commonContent)
			commonChunkIDBytes := sha256.Sum256([]byte("lifecycle-common-chunk"))
			commonChunkID := hex.EncodeToString(commonChunkIDBytes[:])
			protectedSource := []byte("protected source content, never delivered\n")
			protectedSourceDigest := sha256.Sum256(protectedSource)
			materialized := []byte("materialized protected output\n")
			materializedDigest := sha256.Sum256(materialized)
			materializedHex := hex.EncodeToString(materializedDigest[:])
			archive := lifecycleZip(t, "Assets/Product/protected.png", materialized)
			archiveDigest := sha256.Sum256(archive)
			treeRoot := lifecycleOutputTreeRoot(
				"Assets/Product/protected.png",
				materializedDigest,
				uint64(len(materialized)),
			)
			seed := sha256.Sum256([]byte("lifecycle route signing key"))
			privateKey := ed25519.NewKeyFromSeed(seed[:])
			keyID := []byte("install-test-key")
			now := time.Now().Unix()
			var manifestBytes []byte
			var releaseRoot, bindingRoot [32]byte
			var encodedReceipt string
			var zipHits, coupledHits, statusHits atomic.Int64
			server := httptest.NewServer(http.HandlerFunc(func(
				response http.ResponseWriter,
				request *http.Request,
			) {
				if request.Header.Get("DPoP") == "" {
					http.Error(response, "missing proof", http.StatusForbidden)
					return
				}
				switch request.URL.Path {
				case "/v2/delivery/version-1/manifest":
					_, _ = response.Write(manifestBytes)
				case "/v2/delivery/version-1/chunks/" + commonChunkID:
					_, _ = response.Write(commonContent)
				case "/api/v2/package-installs/materialization-status":
					statusHits.Add(1)
					response.Header().Set("Content-Type", "application/json")
					_ = json.NewEncoder(response).Encode(map[string]any{
						"receipt":   encodedReceipt,
						"receiptId": "receipt-1",
						"status":    "succeeded",
					})
				case "/v2/renditions/job-1":
					zipHits.Add(1)
					response.Header().Set("Content-Type", "application/zip")
					_, _ = response.Write(archive)
				case "/v2/coupled/job-1/" + materializedHex:
					coupledHits.Add(1)
					if !strings.HasPrefix(request.Header.Get("Authorization"), "DPoP ") {
						http.Error(response, "unauthorized", http.StatusUnauthorized)
						return
					}
					_, _ = response.Write(materialized)
				default:
					http.NotFound(response, request)
				}
			}))
			defer server.Close()
			manifestBytes, releaseRoot, bindingRoot = protectedLifecycleManifest(
				t,
				commonContent,
				commonDigest,
				commonChunkID,
				protectedSource,
				protectedSourceDigest,
			)
			manifestDigest := sha256.Sum256(manifestBytes)
			receiptClaims := map[any]any{
				int64(0): int64(2),
				int64(1): "receipt-1",
				int64(2): "capability-1",
				int64(3): "creator-1",
				int64(4): "buyer-pseudonym-1",
				int64(5): "hmac-sha256-v1",
				int64(6): "product-1",
				int64(7): releaseRoot[:],
				int64(8): bytes.Repeat([]byte{0x22}, 32),
				int64(9): treeRoot[:],
				int64(10): []any{map[any]any{
					int64(0): "Assets/Product/protected.png",
					int64(1): materializedDigest[:],
					int64(2): int64(len(materialized)),
					int64(3): "attribution-1",
				}},
				int64(11): "grant-1",
				int64(12): "job-1",
				int64(13): int64(1),
				int64(15): "png-dct-qim-v2",
				int64(16): "coupling-server-v2",
				int64(17): "codec-1",
				int64(18): int64(1),
				int64(19): "helper-1",
				int64(20): "runtime-1",
				int64(21): []any{"Assets/Product/protected.png"},
				int64(22): now,
				int64(23): now + 3600,
				int64(24): "materializer-1",
				int64(25): "trace-1",
			}
			if test.purpose == packagecontract.MaterializationReceiptPurpose {
				receiptClaims[int64(14)] = map[any]any{
					int64(0): "job-1.zip",
					int64(1): archiveDigest[:],
					int64(2): int64(len(archive)),
				}
			}
			encodedReceipt = base64.RawURLEncoding.EncodeToString(signLifecycleContract(
				t,
				privateKey,
				keyID,
				test.purpose,
				receiptClaims,
			))
			stateRoot := filepath.Join(t.TempDir(), "state")
			identity, err := deviceidentity.LoadOrCreate(stateRoot)
			if err != nil {
				t.Fatalf("LoadOrCreate() error = %v", err)
			}
			deviceDigest, err := hex.DecodeString(identity.Thumbprint)
			if err != nil {
				t.Fatalf("decode device thumbprint: %v", err)
			}
			session := signLifecycleContract(
				t,
				privateKey,
				keyID,
				packagecontract.InstallSessionPurpose,
				map[any]any{
					int64(0):  int64(2),
					int64(1):  packagecontract.InstallSessionTokenType,
					int64(2):  server.URL,
					int64(3):  server.URL,
					int64(4):  string(keyID),
					int64(5):  "creator-1",
					int64(6):  "buyer-1",
					int64(7):  "product-1",
					int64(8):  "1.0.0",
					int64(9):  "alias-1",
					int64(10): releaseRoot[:],
					int64(11): bindingRoot[:],
					int64(12): deviceDigest,
					int64(13): []any{server.URL},
					int64(14): []any{server.URL},
					int64(15): []any{map[any]any{
						int64(0): "logical-tree-manifest-v4",
						int64(1): server.URL + "/v2/delivery/version-1/manifest",
						int64(2): manifestDigest[:],
					}},
					int64(16): now,
					int64(17): now,
					int64(18): now + 300,
					int64(19): "session-1",
					int64(20): int64(300),
					int64(21): "install",
				},
			)
			grant := signLifecycleContract(
				t,
				privateKey,
				keyID,
				packagecontract.DeliveryGrantPurpose,
				map[any]any{
					int64(0):  int64(2),
					int64(1):  "grant-1",
					int64(2):  server.URL,
					int64(3):  server.URL,
					int64(4):  "creator-1",
					int64(5):  "buyer-1",
					int64(6):  "product-1",
					int64(7):  releaseRoot[:],
					int64(8):  bindingRoot[:],
					int64(9):  deviceDigest,
					int64(10): now,
					int64(11): now,
					int64(12): now + 300,
					int64(13): []any{"materialization:job-1:read", "package:version-1:read"},
					int64(14): "session-1",
				},
			)
			trustDocument := trust.Document{
				MaterializationReceipt: trust.Authority{
					KeyID:     keyID,
					PublicKey: privateKey.Public().(ed25519.PublicKey),
				},
				PackageInstall: trust.Authority{
					KeyID:     keyID,
					PublicKey: privateKey.Public().(ed25519.PublicKey),
				},
			}
			request, err := NewAuthorizedRequest(
				OperationInput{
					AliasID:                     "alias-1",
					ApprovedActiveContentDigest: hex.EncodeToString(make([]byte, 32)),
					ApprovedPolicyVersion:       "active-content-policy-v1",
					ExpectedCurrentReleaseRoot:  hex.EncodeToString(make([]byte, 32)),
					IdempotencyKey:              "route-alias-1",
					Operation:                   "install",
					ProjectIdentity:             hex.EncodeToString(make([]byte, 32)),
					ProjectPath:                 t.TempDir(),
					RunID:                       "run-route",
					StateRoot:                   stateRoot,
					TargetReleaseRoot:           hex.EncodeToString(releaseRoot[:]),
					Traceparent: "00-0123456789abcdef0123456789abcdef-" +
						"0123456789abcdef-01",
				},
				base64.RawURLEncoding.EncodeToString(session),
				base64.RawURLEncoding.EncodeToString(grant),
			)
			if err != nil {
				t.Fatalf("NewAuthorizedRequest() error = %v", err)
			}
			var progressEvents []struct {
				phase     string
				completed int64
				total     int64
			}
			result, err := Execute(
				context.Background(),
				request,
				identity,
				trustDocument,
				func(phase string, completedBytes int64, totalBytes int64, _ int64, _ int64) error {
					progressEvents = append(progressEvents, struct {
						phase     string
						completed int64
						total     int64
					}{phase, completedBytes, totalBytes})
					return nil
				},
			)
			if err != nil {
				t.Fatalf("Execute() error = %v", err)
			}
			staged, err := os.ReadFile(filepath.Join(
				result.StagingTree,
				"Assets",
				"Product",
				"protected.png",
			))
			if err != nil || !bytes.Equal(staged, materialized) {
				t.Fatalf("staged protected file = %q, %v", staged, err)
			}
			if result.ReceiptID != "receipt-1" ||
				result.JournalState != "verified-staging-ready" ||
				len(result.Files) != 2 ||
				statusHits.Load() != 1 {
				t.Fatalf("Execute() = %#v, status hits = %d", result, statusHits.Load())
			}
			if test.purpose == packagecontract.MaterializationReceiptPurposeV3 {
				if zipHits.Load() != 0 || coupledHits.Load() != 1 {
					t.Fatalf(
						"v3 route hits: zip = %d, coupled = %d; want 0, 1",
						zipHits.Load(),
						coupledHits.Load(),
					)
				}
				cachePath := filepath.Join(
					stateRoot,
					"coupled-cache",
					materializedHex[:4],
					materializedHex,
				)
				if _, err := os.Stat(cachePath); err != nil {
					t.Fatalf("coupled cache entry missing: %v", err)
				}
				coupledTotal := int64(len(commonContent) + len(materialized))
				sawRealBytes := false
				for _, event := range progressEvents {
					if event.phase == "downloading" &&
						event.completed == coupledTotal &&
						event.total == coupledTotal {
						sawRealBytes = true
					}
				}
				if !sawRealBytes {
					t.Fatalf(
						"progress lacks real coupled byte totals %d: %#v",
						coupledTotal,
						progressEvents,
					)
				}
			} else {
				if zipHits.Load() != 1 || coupledHits.Load() != 0 {
					t.Fatalf(
						"v2 route hits: zip = %d, coupled = %d; want 1, 0",
						zipHits.Load(),
						coupledHits.Load(),
					)
				}
			}
		})
	}
}

func lifecycleZip(t *testing.T, name string, data []byte) []byte {
	t.Helper()
	var output bytes.Buffer
	writer := zip.NewWriter(&output)
	entry, err := writer.Create(name)
	if err != nil {
		t.Fatalf("Create(zip entry) error = %v", err)
	}
	if _, err := entry.Write(data); err != nil {
		t.Fatalf("Write(zip entry) error = %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("Close(zip) error = %v", err)
	}
	return output.Bytes()
}

func TestCleanupAfterInstallDeletesRenditionAndPrunesChunkCache(t *testing.T) {
	stateRoot := t.TempDir()
	jobID := "job-cleanup-test"
	renditionDir := filepath.Join(stateRoot, "renditions", jobID)
	if err := os.MkdirAll(renditionDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(
		filepath.Join(renditionDir, "receipt-1.zip"),
		[]byte("rendition"),
		0o600,
	); err != nil {
		t.Fatal(err)
	}
	receiptPath := filepath.Join(stateRoot, "receipts", "receipt-1.cose.base64url")
	if err := os.MkdirAll(filepath.Dir(receiptPath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(receiptPath, []byte("receipt\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	cacheRoot := filepath.Join(stateRoot, "chunk-cache")
	writeChunk := func(id string, age time.Duration) string {
		path := filepath.Join(cacheRoot, id[:4], id)
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, make([]byte, 100), 0o600); err != nil {
			t.Fatal(err)
		}
		stamp := time.Now().Add(-age)
		if err := os.Chtimes(path, stamp, stamp); err != nil {
			t.Fatal(err)
		}
		return path
	}
	oldReferenced := writeChunk(strings.Repeat("aa", 32), 72*time.Hour)
	oldUnreferenced := writeChunk(strings.Repeat("bb", 32), 48*time.Hour)
	newUnreferenced := writeChunk(strings.Repeat("cc", 32), time.Minute)
	manifest := delivery.Manifest{
		Files: []delivery.File{
			{
				Chunks: []delivery.Chunk{{ID: strings.Repeat("aa", 32)}},
			},
		},
	}
	coupledCacheRoot := filepath.Join(stateRoot, "coupled-cache")
	writeCoupled := func(id string, size int, age time.Duration) string {
		path := filepath.Join(coupledCacheRoot, id[:4], id)
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, make([]byte, size), 0o600); err != nil {
			t.Fatal(err)
		}
		stamp := time.Now().Add(-age)
		if err := os.Chtimes(path, stamp, stamp); err != nil {
			t.Fatal(err)
		}
		return path
	}
	var receiptDigest [32]byte
	copy(receiptDigest[:], bytes.Repeat([]byte{0xdd}, 32))
	coupledReferenced := writeCoupled(strings.Repeat("dd", 32), 200, 72*time.Hour)
	coupledUnreferenced := writeCoupled(strings.Repeat("ee", 32), 200, 48*time.Hour)
	receipt := packagecontract.MaterializationReceipt{
		OutputFiles: []packagecontract.MaterializedFile{{
			Bytes:          200,
			NormalizedPath: "Assets/Product/protected.png",
			SHA256:         receiptDigest,
		}},
	}

	cleanupAfterInstall(stateRoot, jobID, manifest, receipt)
	for _, path := range []string{coupledReferenced, coupledUnreferenced} {
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("coupled entry under the size bound was deleted: %v", err)
		}
	}
	pruneChunkCache(coupledCacheRoot, 250, map[string]struct{}{
		strings.Repeat("dd", 32): {},
	})
	if _, err := os.Stat(coupledReferenced); err != nil {
		t.Fatalf("receipt-referenced coupled entry was deleted: %v", err)
	}
	if _, err := os.Stat(coupledUnreferenced); !os.IsNotExist(err) {
		t.Fatalf("unreferenced coupled entry survived pruning: %v", err)
	}
	for _, path := range []string{oldReferenced, oldUnreferenced, newUnreferenced} {
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("chunk under the size bound was deleted: %v", err)
		}
	}
	if _, err := os.Stat(renditionDir); !os.IsNotExist(err) {
		t.Fatalf("rendition directory survived cleanup: %v", err)
	}
	if _, err := os.Stat(receiptPath); err != nil {
		t.Fatalf("receipt must be kept: %v", err)
	}

	pruneChunkCache(cacheRoot, 250, map[string]struct{}{
		strings.Repeat("aa", 32): {},
	})
	if _, err := os.Stat(oldReferenced); err != nil {
		t.Fatalf("referenced chunk was deleted: %v", err)
	}
	if _, err := os.Stat(oldUnreferenced); !os.IsNotExist(err) {
		t.Fatalf("oldest unreferenced chunk survived pruning: %v", err)
	}
	if _, err := os.Stat(newUnreferenced); err != nil {
		t.Fatalf("recent chunk was deleted despite the cache fitting the bound: %v", err)
	}
}
