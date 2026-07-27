package delivery

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/yucp/transfer-helper/internal/packagecontract"
	"github.com/yucp/transfer-helper/internal/trust"
)

func TestMaterializationPollingRenewsAnExpiredGrant(t *testing.T) {
	var requests atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(
		writer http.ResponseWriter,
		request *http.Request,
	) {
		requests.Add(1)
		if request.Header.Get("DPoP") == "" {
			http.Error(writer, "missing proof", http.StatusBadRequest)
			return
		}
		var body map[string]string
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			http.Error(writer, "invalid body", http.StatusBadRequest)
			return
		}
		if body["deliveryGrant"] != "grant-renewed" {
			writer.WriteHeader(http.StatusForbidden)
			return
		}
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{
			"queuePosition":1,
			"state":"QUEUED",
			"status":"pending"
		}`))
	}))
	defer server.Close()
	privateKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("GenerateKey() error = %v", err)
	}
	grants := &testGrantSource{current: "grant-expired", renewed: "grant-renewed"}

	status, err := readMaterializationStatus(
		context.Background(),
		server.Client(),
		server.URL,
		"job-1",
		grants,
		privateKey,
	)

	if err != nil {
		t.Fatalf("readMaterializationStatus() error = %v", err)
	}
	if status.Status != "pending" || grants.renews.Load() != 1 || requests.Load() != 2 {
		t.Fatalf(
			"status/renewal counts = %#v, %d, %d; want pending, 1, 2",
			status,
			grants.renews.Load(),
			requests.Load(),
		)
	}
}

func TestFetchAndMergeProtectedRenditionVerifiesReceiptAndZip(t *testing.T) {
	protected := []byte("personalized protected file\n")
	protectedDigest := sha256.Sum256(protected)
	archive := protectedArchive(t, "Assets/Product/protected.png", protected)
	archiveDigest := sha256.Sum256(archive)
	treeRoot := renditionOutputTreeRoot(
		"Assets/Product/protected.png",
		protectedDigest,
		uint64(len(protected)),
	)
	seed := sha256.Sum256([]byte("receipt signing key"))
	receiptPrivateKey := ed25519.NewKeyFromSeed(seed[:])
	receiptKeyID := []byte("receipt-test-key")
	now := time.Now().Unix()
	receiptPayload := mustRenditionCanonical(t, map[any]any{
		int64(0): int64(2),
		int64(1): "receipt-1",
		int64(2): "capability-1",
		int64(3): "creator-1",
		int64(4): "buyer-pseudonym-1",
		int64(5): "hmac-sha256-v1",
		int64(6): "product-1",
		int64(7): bytes.Repeat([]byte{0x11}, 32),
		int64(8): bytes.Repeat([]byte{0x22}, 32),
		int64(9): treeRoot[:],
		int64(10): []any{map[any]any{
			int64(0): "Assets/Product/protected.png",
			int64(1): protectedDigest[:],
			int64(2): int64(len(protected)),
			int64(3): "attribution-1",
		}},
		int64(11): "grant-1",
		int64(12): "job-1",
		int64(13): int64(1),
		int64(14): map[any]any{
			int64(0): "renditions",
			int64(1): "renditions-test",
			int64(2): "v2/renditions/job-1/output.zip",
			int64(3): "version-1",
			int64(4): "file-1",
			int64(5): archiveDigest[:],
			int64(6): int64(len(archive)),
		},
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
	})
	receiptEnvelope := signRenditionContract(
		t,
		receiptPrivateKey,
		receiptKeyID,
		packagecontract.MaterializationReceiptPurpose,
		receiptPayload,
	)
	encodedReceipt := base64.RawURLEncoding.EncodeToString(receiptEnvelope)
	var statusReads int
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Header.Get("DPoP") == "" {
			http.Error(response, "missing proof", http.StatusForbidden)
			return
		}
		switch request.URL.Path {
		case "/api/v2/package-installs/materialization-status":
			statusReads++
			response.Header().Set("Content-Type", "application/json")
			if statusReads == 1 {
				_, _ = response.Write([]byte(`{"queuePosition":1,"state":"VERIFYING","status":"pending"}`))
				return
			}
			_ = json.NewEncoder(response).Encode(map[string]any{
				"receipt":   encodedReceipt,
				"receiptId": "receipt-1",
				"status":    "succeeded",
			})
		case "/v2/renditions/job-1":
			response.Header().Set("Content-Type", "application/zip")
			_, _ = response.Write(archive)
		default:
			http.NotFound(response, request)
		}
	}))
	defer server.Close()
	deviceKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("GenerateKey() error = %v", err)
	}
	releaseRoot := [32]byte{}
	copy(releaseRoot[:], bytes.Repeat([]byte{0x11}, 32))
	session := packagecontract.InstallSession{
		Audience:    server.URL,
		CreatorID:   "creator-1",
		Issuer:      server.URL,
		ProductID:   "product-1",
		ReleaseRoot: releaseRoot,
	}
	grant := packagecontract.DeliveryGrant{
		GrantID: "grant-1",
		Scopes:  []string{"materialization:job-1:read"},
	}
	rendition, receipt, err := FetchProtectedRendition(
		context.Background(),
		ProtectedRenditionConfig{
			GrantSource:  &testGrantSource{current: "encoded-grant"},
			Grant:        grant,
			DownloadRoot: t.TempDir(),
			PrivateKey:   deviceKey,
			ReceiptAuthority: trust.Authority{
				KeyID:     receiptKeyID,
				PublicKey: receiptPrivateKey.Public().(ed25519.PublicKey),
			},
			Session:      session,
			PollInterval: time.Millisecond,
		},
	)
	if err != nil {
		t.Fatalf("FetchProtectedRendition() error = %v", err)
	}
	downloadedArchive, err := os.ReadFile(rendition.Path)
	if err != nil {
		t.Fatalf("read downloaded rendition: %v", err)
	}
	if statusReads != 2 ||
		!bytes.Equal(downloadedArchive, archive) ||
		receipt.ReceiptID != "receipt-1" {
		t.Fatalf("rendition result is invalid")
	}
	stagingTree := filepath.Join(t.TempDir(), "staging")
	if err := os.MkdirAll(stagingTree, 0o700); err != nil {
		t.Fatalf("create staging tree: %v", err)
	}
	files, err := MergeProtectedRendition(
		stagingTree,
		Manifest{
			ProtectionPolicyID: activeProtectionPolicyID,
			Files: []File{{
				Bytes:          100,
				Classification: "protected",
				Materializer:   "png",
				NormalizedPath: "Assets/Product/protected.png",
				SHA256:         hex.EncodeToString(bytes.Repeat([]byte{0x99}, 32)),
			}},
		},
		rendition.Path,
		receipt,
	)
	if err != nil {
		t.Fatalf("MergeProtectedRendition() error = %v", err)
	}
	merged, err := os.ReadFile(filepath.Join(stagingTree, "Assets", "Product", "protected.png"))
	if err != nil {
		t.Fatalf("read merged protected file: %v", err)
	}
	if !bytes.Equal(merged, protected) || len(files) != 1 {
		t.Fatalf("merged protected output is invalid")
	}
}

func TestMergeProtectedRenditionPreservesVerifiedBestEffortFiles(t *testing.T) {
	coupled := []byte("personalized protected file\n")
	uncarryable := []byte("byte-exact protected file\n")
	coupledDigest := sha256.Sum256(coupled)
	sourceCoupledDigest := sha256.Sum256([]byte("source coupled"))
	uncarryableDigest := sha256.Sum256(uncarryable)
	archive := protectedArchiveEntries(t, []protectedArchiveEntry{
		{
			data: coupled,
			name: "Assets/Product/coupled.png",
		},
		{
			data: uncarryable,
			name: "Assets/Product/uncarryable.png",
		},
	})
	renditionPath := filepath.Join(t.TempDir(), "rendition.zip")
	if err := os.WriteFile(renditionPath, archive, 0o600); err != nil {
		t.Fatalf("write rendition: %v", err)
	}
	stagingTree := filepath.Join(t.TempDir(), "staging")
	if err := os.MkdirAll(stagingTree, 0o700); err != nil {
		t.Fatalf("create staging tree: %v", err)
	}
	files, err := MergeProtectedRendition(
		stagingTree,
		Manifest{
			ProtectionPolicyID: activeProtectionPolicyID,
			Files: []File{
				{
					Bytes:          int64(len(coupled)),
					Classification: "protected",
					NormalizedPath: "Assets/Product/coupled.png",
					SHA256:         hex.EncodeToString(sourceCoupledDigest[:]),
				},
				{
					Bytes:          int64(len(uncarryable)),
					Classification: "protected",
					NormalizedPath: "Assets/Product/uncarryable.png",
					SHA256:         hex.EncodeToString(uncarryableDigest[:]),
				},
			},
		},
		renditionPath,
		packagecontract.MaterializationReceipt{
			OutputFiles: []packagecontract.MaterializedFile{
				{
					AttributionID:  "attribution-1",
					Bytes:          int64(len(coupled)),
					NormalizedPath: "Assets/Product/coupled.png",
					SHA256:         coupledDigest,
				},
			},
		},
	)
	if err != nil {
		t.Fatalf("MergeProtectedRendition() error = %v", err)
	}
	if len(files) != 2 {
		t.Fatalf("MergeProtectedRendition() staged %d files, want 2", len(files))
	}
	stagedUncarryable, err := os.ReadFile(
		filepath.Join(stagingTree, "Assets", "Product", "uncarryable.png"),
	)
	if err != nil {
		t.Fatalf("read byte-exact protected file: %v", err)
	}
	if !bytes.Equal(stagedUncarryable, uncarryable) {
		t.Fatalf("byte-exact protected file changed")
	}
}

func TestMergeProtectedRenditionRejectsRemovedProtectionPolicy(t *testing.T) {
	_, err := MergeProtectedRendition(
		t.TempDir(),
		Manifest{ProtectionPolicyID: "supported-visual-assets-v1"},
		filepath.Join(t.TempDir(), "missing.zip"),
		packagecontract.MaterializationReceipt{},
	)
	if err == nil || err.Error() != "unsupported protection policy supported-visual-assets-v1" {
		t.Fatalf("MergeProtectedRendition() error = %v", err)
	}
}

type protectedArchiveEntry struct {
	data []byte
	name string
}

func protectedArchive(t *testing.T, name string, data []byte) []byte {
	return protectedArchiveEntries(t, []protectedArchiveEntry{{data: data, name: name}})
}

func protectedArchiveEntries(t *testing.T, entries []protectedArchiveEntry) []byte {
	t.Helper()
	var output bytes.Buffer
	writer := zip.NewWriter(&output)
	for _, value := range entries {
		entry, err := writer.Create(value.name)
		if err != nil {
			t.Fatalf("Create(zip entry) error = %v", err)
		}
		if _, err := entry.Write(value.data); err != nil {
			t.Fatalf("Write(zip entry) error = %v", err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("Close(zip) error = %v", err)
	}
	return output.Bytes()
}

func renditionOutputTreeRoot(path string, digest [32]byte, size uint64) [32]byte {
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

func signRenditionContract(
	t *testing.T,
	privateKey ed25519.PrivateKey,
	keyID []byte,
	purpose string,
	payload []byte,
) []byte {
	t.Helper()
	protected := mustRenditionCanonical(t, map[any]any{
		int64(1):    int64(-8),
		int64(2):    []any{int64(1001)},
		int64(4):    keyID,
		int64(1001): purpose,
	})
	signatureStructure := mustRenditionCanonical(t, []any{
		"Signature1",
		protected,
		[]byte{},
		payload,
	})
	return mustRenditionCanonical(t, []any{
		protected,
		map[any]any{},
		payload,
		ed25519.Sign(privateKey, signatureStructure),
	})
}

func mustRenditionCanonical(t *testing.T, value any) []byte {
	t.Helper()
	data, err := packagecontract.EncodeCanonical(value)
	if err != nil {
		t.Fatalf("EncodeCanonical() error = %v", err)
	}
	return data
}
