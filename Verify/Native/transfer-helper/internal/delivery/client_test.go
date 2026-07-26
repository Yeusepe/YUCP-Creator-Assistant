package delivery

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/yucp/transfer-helper/internal/packagecontract"
)

func TestFetchManifestReportsPreStorageAuthorizationFailure(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("X-Delivery-Storage-Fetches", "0")
		http.Error(response, "forbidden", http.StatusForbidden)
	}))
	defer server.Close()
	privateKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("GenerateKey() error = %v", err)
	}
	_, err = FetchManifest(
		context.Background(),
		packagecontract.InstallSession{
			Bootstrap: packagecontract.InstallBootstrap{
				URL: server.URL + "/v2/delivery/version-1/manifest",
			},
		},
		packagecontract.DeliveryGrant{
			Scopes: []string{"package:version-1:read"},
		},
		"grant-1",
		privateKey,
	)
	if err == nil ||
		!strings.Contains(err.Error(), "HTTP 403 after 0 storage reads") {
		t.Fatalf("FetchManifest() error = %v", err)
	}
}

func TestStageCommonTreeDownloadsVerifiesAndReusesChunkCache(t *testing.T) {
	content := []byte("downloaded common file\n")
	digest := sha256.Sum256(content)
	chunkIdentity := sha256.Sum256([]byte("common-domain"))
	chunkID := hex.EncodeToString(chunkIdentity[:])
	var reads atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/v2/delivery/version-1/chunks/"+chunkID ||
			request.Header.Get("Authorization") != "DPoP grant-1" ||
			request.Header.Get("DPoP") == "" {
			http.Error(response, "forbidden", http.StatusForbidden)
			return
		}
		reads.Add(1)
		response.Header().Set("Content-Length", "23")
		_, _ = response.Write(content)
	}))
	defer server.Close()
	privateKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("GenerateKey() error = %v", err)
	}
	manifest := Manifest{
		Files: []File{{
			Bytes:          int64(len(content)),
			Chunks:         []Chunk{{ID: chunkID, SHA256: hex.EncodeToString(digest[:]), Size: int64(len(content))}},
			Classification: "common",
			NormalizedPath: "Assets/Product/file.txt",
			SHA256:         hex.EncodeToString(digest[:]),
		}},
		VersionID: "version-1",
	}
	cacheRoot := filepath.Join(t.TempDir(), "cache")
	firstDestination := filepath.Join(t.TempDir(), "first")
	first, err := StageCommonTree(context.Background(), StageCommonConfig{
		CacheRoot:     cacheRoot,
		Destination:   firstDestination,
		DeliveryGrant: "grant-1",
		Manifest:      manifest,
		ManifestURL:   server.URL + "/v2/delivery/version-1/manifest",
		PrivateKey:    privateKey,
	})
	if err != nil {
		t.Fatalf("StageCommonTree() first call error = %v", err)
	}
	if first.LogicalFiles != 1 || first.LogicalBytes != int64(len(content)) {
		t.Fatalf("StageCommonTree() first result = %#v", first)
	}
	staged, err := os.ReadFile(filepath.Join(firstDestination, "Assets", "Product", "file.txt"))
	if err != nil {
		t.Fatalf("read staged common file: %v", err)
	}
	if string(staged) != string(content) {
		t.Fatalf("staged content = %q, want %q", staged, content)
	}

	server.Close()
	secondDestination := filepath.Join(t.TempDir(), "second")
	if _, err := StageCommonTree(context.Background(), StageCommonConfig{
		CacheRoot:     cacheRoot,
		Destination:   secondDestination,
		DeliveryGrant: "grant-1",
		Manifest:      manifest,
		ManifestURL:   server.URL + "/v2/delivery/version-1/manifest",
		PrivateKey:    privateKey,
	}); err != nil {
		t.Fatalf("StageCommonTree() cache call error = %v", err)
	}
	if reads.Load() != 1 {
		t.Fatalf("origin chunk reads = %d, want 1", reads.Load())
	}
}

func TestStageCommonTreeRejectsProjectPathEscape(t *testing.T) {
	if _, err := StageCommonTree(context.Background(), StageCommonConfig{
		CacheRoot:     t.TempDir(),
		Destination:   filepath.Join(t.TempDir(), "stage"),
		DeliveryGrant: "grant",
		Manifest: Manifest{Files: []File{{
			Classification: "common",
			NormalizedPath: "../escape",
		}}},
		ManifestURL: "http://127.0.0.1:1/v2/delivery/version/manifest",
		PrivateKey:  &ecdsa.PrivateKey{},
	}); err == nil {
		t.Fatal("StageCommonTree() accepted a path escape")
	}
}
