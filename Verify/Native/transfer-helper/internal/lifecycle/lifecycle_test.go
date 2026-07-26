package lifecycle

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/yucp/transfer-helper/internal/delivery"
	"github.com/yucp/transfer-helper/internal/deviceidentity"
	"github.com/yucp/transfer-helper/internal/packagecontract"
	"github.com/yucp/transfer-helper/internal/trust"
)

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

func TestExecutePreflightThenStagesVerifiedCommonTree(t *testing.T) {
	content := []byte("complete lifecycle\n")
	fileDigest := sha256.Sum256(content)
	chunkIDBytes := sha256.Sum256([]byte("creator-common-domain"))
	chunkID := hex.EncodeToString(chunkIDBytes[:])
	var manifestBytes []byte
	var chunkReads int
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/v2/delivery/version-1/manifest":
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
	grant := signLifecycleContract(t, privateKey, keyID, packagecontract.DeliveryGrantPurpose, map[any]any{
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
		int64(13): []any{"package:version-1:read"},
		int64(14): "session-1",
	})
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
	baseRequest := Request{
		AliasID:                    "alias-1",
		DeliveryGrant:              base64.RawURLEncoding.EncodeToString(grant),
		ExpectedCurrentReleaseRoot: hex.EncodeToString(make([]byte, 32)),
		InstallSession:             base64.RawURLEncoding.EncodeToString(session),
		ProjectPath:                t.TempDir(),
		SchemaVersion:              2,
		StateRoot:                  stateRoot,
		TargetReleaseRoot:          hex.EncodeToString(releaseRoot[:]),
	}
	preflightRequest := baseRequest
	preflightRequest.Operation = "preflight"
	preflightRequest.RunID = "run-preflight"
	preflight, err := Execute(context.Background(), preflightRequest, identity, trustDocument)
	if err != nil {
		t.Fatalf("Execute(preflight) error = %v", err)
	}
	if preflight.ActiveContentDigest != hex.EncodeToString(make([]byte, 32)) ||
		preflight.ActivePolicyVersion != "active-content-policy-v1" ||
		preflight.StagingTree != "" ||
		chunkReads != 0 {
		t.Fatalf("Execute(preflight) = %#v, chunk reads = %d", preflight, chunkReads)
	}

	installRequest := baseRequest
	installRequest.InstallSession = base64.RawURLEncoding.EncodeToString(
		signSession("install"),
	)
	installRequest.Operation = "install"
	installRequest.RunID = "run-install"
	installRequest.ApprovedActiveContentDigest = preflight.ActiveContentDigest
	installRequest.ApprovedPolicyVersion = preflight.ActivePolicyVersion
	installed, err := Execute(context.Background(), installRequest, identity, trustDocument)
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

	for _, operation := range []string{"update", "repair", "rollback"} {
		request := baseRequest
		request.InstallSession = base64.RawURLEncoding.EncodeToString(
			signSession(operation),
		)
		request.Operation = operation
		request.RunID = "run-" + operation
		request.ApprovedActiveContentDigest = preflight.ActiveContentDigest
		request.ApprovedPolicyVersion = preflight.ActivePolicyVersion
		result, executeErr := Execute(
			context.Background(),
			request,
			identity,
			trustDocument,
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
		"activeContentDigest":        hex.EncodeToString(make([]byte, 32)),
		"activePolicyVersion":        "active-content-policy-v1",
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
		"protectionPolicyId":     "policy-1",
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
