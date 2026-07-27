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

type testGrantSource struct {
	current string
	renewed string
	renews  atomic.Int64
}

func (source *testGrantSource) Current(context.Context) (string, error) {
	return source.current, nil
}

func (source *testGrantSource) Renew(_ context.Context, rejected string) (string, error) {
	if rejected != source.current {
		return source.current, nil
	}
	source.renews.Add(1)
	source.current = source.renewed
	return source.current, nil
}

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
		&testGrantSource{current: "grant-1", renewed: "grant-2"},
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
	grants := &testGrantSource{current: "grant-1"}
	firstDestination := filepath.Join(t.TempDir(), "first")
	first, err := StageCommonTree(context.Background(), StageCommonConfig{
		CacheRoot:   cacheRoot,
		Destination: firstDestination,
		GrantSource: grants,
		Manifest:    manifest,
		ManifestURL: server.URL + "/v2/delivery/version-1/manifest",
		PrivateKey:  privateKey,
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
		CacheRoot:   cacheRoot,
		Destination: secondDestination,
		GrantSource: grants,
		Manifest:    manifest,
		ManifestURL: server.URL + "/v2/delivery/version-1/manifest",
		PrivateKey:  privateKey,
	}); err != nil {
		t.Fatalf("StageCommonTree() cache call error = %v", err)
	}
	if reads.Load() != 1 {
		t.Fatalf("origin chunk reads = %d, want 1", reads.Load())
	}
}

func TestStageCommonTreeRenewsWithoutDiscardingVerifiedChunkCache(t *testing.T) {
	firstContent := []byte("first cached chunk\n")
	secondContent := []byte("second renewed chunk\n")
	firstDigest := sha256.Sum256(firstContent)
	secondDigest := sha256.Sum256(secondContent)
	firstIdentity := sha256.Sum256([]byte("first-cache-domain"))
	secondIdentity := sha256.Sum256([]byte("second-cache-domain"))
	firstID := hex.EncodeToString(firstIdentity[:])
	secondID := hex.EncodeToString(secondIdentity[:])
	var firstReads atomic.Int64
	var secondReads atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/v2/delivery/version-1/chunks/" + firstID:
			firstReads.Add(1)
			_, _ = response.Write(firstContent)
		case "/v2/delivery/version-1/chunks/" + secondID:
			secondReads.Add(1)
			if request.Header.Get("Authorization") != "DPoP grant-renewed" {
				response.WriteHeader(http.StatusForbidden)
				return
			}
			_, _ = response.Write(secondContent)
		default:
			http.NotFound(response, request)
		}
	}))
	defer server.Close()
	privateKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("GenerateKey() error = %v", err)
	}
	cacheRoot := filepath.Join(t.TempDir(), "cache")
	grants := &testGrantSource{current: "grant-old", renewed: "grant-renewed"}
	firstFile := File{
		Bytes: int64(len(firstContent)),
		Chunks: []Chunk{{
			ID: firstID, SHA256: hex.EncodeToString(firstDigest[:]), Size: int64(len(firstContent)),
		}},
		Classification: "common",
		NormalizedPath: "Assets/Product/first.txt",
		SHA256:         hex.EncodeToString(firstDigest[:]),
	}
	if _, err := StageCommonTree(context.Background(), StageCommonConfig{
		CacheRoot:   cacheRoot,
		Destination: filepath.Join(t.TempDir(), "first"),
		GrantSource: grants,
		Manifest:    Manifest{Files: []File{firstFile}, VersionID: "version-1"},
		ManifestURL: server.URL + "/v2/delivery/version-1/manifest",
		PrivateKey:  privateKey,
	}); err != nil {
		t.Fatalf("StageCommonTree() initial cache fill error = %v", err)
	}
	secondFile := File{
		Bytes: int64(len(secondContent)),
		Chunks: []Chunk{{
			ID: secondID, SHA256: hex.EncodeToString(secondDigest[:]), Size: int64(len(secondContent)),
		}},
		Classification: "common",
		NormalizedPath: "Assets/Product/second.txt",
		SHA256:         hex.EncodeToString(secondDigest[:]),
	}
	if _, err := StageCommonTree(context.Background(), StageCommonConfig{
		CacheRoot:   cacheRoot,
		Destination: filepath.Join(t.TempDir(), "renewed"),
		GrantSource: grants,
		Manifest:    Manifest{Files: []File{firstFile, secondFile}, VersionID: "version-1"},
		ManifestURL: server.URL + "/v2/delivery/version-1/manifest",
		PrivateKey:  privateKey,
	}); err != nil {
		t.Fatalf("StageCommonTree() renewed transfer error = %v", err)
	}
	if grants.renews.Load() != 1 || firstReads.Load() != 1 || secondReads.Load() != 2 {
		t.Fatalf(
			"renewal/cache counts = renewals %d, first %d, second %d; want 1, 1, 2",
			grants.renews.Load(),
			firstReads.Load(),
			secondReads.Load(),
		)
	}
}

func TestStageCommonTreeRejectsProjectPathEscape(t *testing.T) {
	if _, err := StageCommonTree(context.Background(), StageCommonConfig{
		CacheRoot:   t.TempDir(),
		Destination: filepath.Join(t.TempDir(), "stage"),
		GrantSource: &testGrantSource{current: "grant"},
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
