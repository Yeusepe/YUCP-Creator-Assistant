package delivery

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/yucp/transfer-helper/internal/packagecontract"
)

func coupledTestConfig(
	t *testing.T,
	audience string,
	grants GrantSource,
	files []packagecontract.MaterializedFile,
) (CoupledFetchConfig, string, string) {
	t.Helper()
	privateKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("GenerateKey() error = %v", err)
	}
	stagingTree := filepath.Join(t.TempDir(), "staging")
	if err := os.MkdirAll(stagingTree, 0o700); err != nil {
		t.Fatalf("create staging tree: %v", err)
	}
	stageRoot, err := os.OpenRoot(stagingTree)
	if err != nil {
		t.Fatalf("OpenRoot() error = %v", err)
	}
	t.Cleanup(func() { _ = stageRoot.Close() })
	cacheRoot := filepath.Join(t.TempDir(), "coupled-cache")
	return CoupledFetchConfig{
		Audience:    audience,
		CacheRoot:   cacheRoot,
		GrantSource: grants,
		JobID:       "job-1",
		PrivateKey:  privateKey,
		Receipt:     packagecontract.MaterializationReceipt{OutputFiles: files},
		StageRoot:   stageRoot,
	}, stagingTree, cacheRoot
}

func TestFetchCoupledFilesDownloadsVerifiesAndReusesCache(t *testing.T) {
	first := []byte("coupled file one\n")
	second := []byte("coupled file two\n")
	firstDigest := sha256.Sum256(first)
	secondDigest := sha256.Sum256(second)
	bodies := map[string][]byte{
		hex.EncodeToString(firstDigest[:]):  first,
		hex.EncodeToString(secondDigest[:]): second,
	}
	var requests atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(
		writer http.ResponseWriter,
		request *http.Request,
	) {
		requests.Add(1)
		if request.Method != http.MethodGet ||
			!strings.HasPrefix(request.Header.Get("Authorization"), "DPoP ") ||
			request.Header.Get("DPoP") == "" {
			http.Error(writer, "unauthorized", http.StatusUnauthorized)
			return
		}
		digestHex := strings.TrimPrefix(request.URL.Path, "/v2/coupled/job-1/")
		body, ok := bodies[digestHex]
		if !ok {
			http.NotFound(writer, request)
			return
		}
		writer.Header().Set("Content-Length", fmt.Sprint(len(body)))
		_, _ = writer.Write(body)
	}))
	defer server.Close()
	files := []packagecontract.MaterializedFile{
		{
			Bytes:          int64(len(first)),
			NormalizedPath: "Assets/Product/one.png",
			SHA256:         firstDigest,
		},
		{
			Bytes:          int64(len(second)),
			NormalizedPath: "Assets/Product/sub/two.png",
			SHA256:         secondDigest,
		},
	}
	cfg, stagingTree, cacheRoot := coupledTestConfig(
		t,
		server.URL,
		&testGrantSource{current: "grant-1"},
		files,
	)
	var progress [][2]int64
	cfg.Progress = func(completedBytes int64, totalBytes int64) error {
		progress = append(progress, [2]int64{completedBytes, totalBytes})
		return nil
	}

	staged, err := FetchCoupledFiles(context.Background(), cfg)
	if err != nil {
		t.Fatalf("FetchCoupledFiles() error = %v", err)
	}
	if len(staged) != 2 ||
		staged[0].SHA256 != hex.EncodeToString(firstDigest[:]) ||
		staged[1].NormalizedPath != "Assets/Product/sub/two.png" {
		t.Fatalf("FetchCoupledFiles() = %#v", staged)
	}
	for path, want := range map[string][]byte{
		filepath.Join(stagingTree, "Assets", "Product", "one.png"):        first,
		filepath.Join(stagingTree, "Assets", "Product", "sub", "two.png"): second,
	} {
		got, readErr := os.ReadFile(path)
		if readErr != nil || !bytes.Equal(got, want) {
			t.Fatalf("staged file %s = %q, %v", path, got, readErr)
		}
	}
	total := int64(len(first) + len(second))
	if len(progress) == 0 ||
		progress[len(progress)-1] != [2]int64{total, total} {
		t.Fatalf("progress = %#v; want final %d/%d", progress, total, total)
	}
	if requests.Load() != 2 {
		t.Fatalf("request count = %d, want 2", requests.Load())
	}

	repeat, _, _ := coupledTestConfig(
		t,
		server.URL,
		&testGrantSource{current: "grant-1"},
		files,
	)
	repeat.CacheRoot = cacheRoot
	if _, err := FetchCoupledFiles(context.Background(), repeat); err != nil {
		t.Fatalf("FetchCoupledFiles(cached) error = %v", err)
	}
	if requests.Load() != 2 {
		t.Fatalf("cached rerun fetched from the network: %d requests", requests.Load())
	}
}

func TestFetchCoupledFilesResumesFromVerifiedOffsetAfterIdleTimeout(t *testing.T) {
	content := bytes.Repeat([]byte("coupled-resume-data"), 4_096)
	digest := sha256.Sum256(content)
	const firstSegmentBytes = 32 * 1024
	var requests atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(
		writer http.ResponseWriter,
		request *http.Request,
	) {
		requests.Add(1)
		switch request.Header.Get("Range") {
		case "":
			writer.Header().Set("Content-Length", fmt.Sprint(len(content)))
			writer.WriteHeader(http.StatusOK)
			_, _ = writer.Write(content[:firstSegmentBytes])
			if flusher, ok := writer.(http.Flusher); ok {
				flusher.Flush()
			}
			<-request.Context().Done()
		case fmt.Sprintf("bytes=%d-", firstSegmentBytes):
			writer.Header().Set(
				"Content-Range",
				fmt.Sprintf(
					"bytes %d-%d/%d",
					firstSegmentBytes,
					len(content)-1,
					len(content),
				),
			)
			writer.Header().Set(
				"Content-Length",
				fmt.Sprint(len(content)-firstSegmentBytes),
			)
			writer.WriteHeader(http.StatusPartialContent)
			_, _ = writer.Write(content[firstSegmentBytes:])
		default:
			http.Error(writer, "unexpected range", http.StatusRequestedRangeNotSatisfiable)
		}
	}))
	defer server.Close()
	cfg, stagingTree, _ := coupledTestConfig(
		t,
		server.URL,
		&testGrantSource{current: "grant-resume"},
		[]packagecontract.MaterializedFile{{
			Bytes:          int64(len(content)),
			NormalizedPath: "Assets/Product/large.png",
			SHA256:         digest,
		}},
	)
	cfg.IdleTimeout = 25 * time.Millisecond

	if _, err := FetchCoupledFiles(context.Background(), cfg); err != nil {
		t.Fatalf("FetchCoupledFiles() error = %v", err)
	}
	staged, err := os.ReadFile(filepath.Join(stagingTree, "Assets", "Product", "large.png"))
	if err != nil {
		t.Fatalf("read staged coupled file: %v", err)
	}
	if !bytes.Equal(staged, content) || requests.Load() != 2 {
		t.Fatalf("resumed coupled mismatch or request count = %d", requests.Load())
	}
}

func TestFetchCoupledFilesFailsFatallyAndRemovesPartialOnDigestMismatch(t *testing.T) {
	content := []byte("expected coupled bytes\n")
	digest := sha256.Sum256(content)
	server := httptest.NewServer(http.HandlerFunc(func(
		writer http.ResponseWriter,
		_ *http.Request,
	) {
		corrupted := bytes.ToUpper(content)
		writer.Header().Set("Content-Length", fmt.Sprint(len(corrupted)))
		_, _ = writer.Write(corrupted)
	}))
	defer server.Close()
	cfg, stagingTree, cacheRoot := coupledTestConfig(
		t,
		server.URL,
		&testGrantSource{current: "grant-1"},
		[]packagecontract.MaterializedFile{{
			Bytes:          int64(len(content)),
			NormalizedPath: "Assets/Product/protected.png",
			SHA256:         digest,
		}},
	)

	_, err := FetchCoupledFiles(context.Background(), cfg)
	if err == nil || !strings.Contains(err.Error(), "failed signed verification") {
		t.Fatalf("FetchCoupledFiles() error = %v", err)
	}
	if _, statErr := os.Stat(
		filepath.Join(stagingTree, "Assets", "Product", "protected.png"),
	); !os.IsNotExist(statErr) {
		t.Fatalf("staged partial survived a digest mismatch: %v", statErr)
	}
	digestHex := hex.EncodeToString(digest[:])
	if _, statErr := os.Stat(
		filepath.Join(cacheRoot, digestHex[:4], digestHex),
	); !os.IsNotExist(statErr) {
		t.Fatalf("cache entry published for a corrupt coupled file: %v", statErr)
	}
	partials, globErr := filepath.Glob(filepath.Join(cacheRoot, "*", "*.partial"))
	if globErr != nil || len(partials) != 0 {
		t.Fatalf("partial cache files survived: %v, %v", partials, globErr)
	}
}

func TestFetchCoupledFilesRenewsGrantOnceOnUnauthorized(t *testing.T) {
	content := []byte("renewed coupled bytes\n")
	digest := sha256.Sum256(content)
	var requests atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(
		writer http.ResponseWriter,
		request *http.Request,
	) {
		requests.Add(1)
		if request.Header.Get("Authorization") != "DPoP grant-renewed" {
			writer.WriteHeader(http.StatusUnauthorized)
			return
		}
		writer.Header().Set("Content-Length", fmt.Sprint(len(content)))
		_, _ = writer.Write(content)
	}))
	defer server.Close()
	grants := &testGrantSource{current: "grant-expired", renewed: "grant-renewed"}
	cfg, stagingTree, _ := coupledTestConfig(
		t,
		server.URL,
		grants,
		[]packagecontract.MaterializedFile{{
			Bytes:          int64(len(content)),
			NormalizedPath: "Assets/Product/protected.png",
			SHA256:         digest,
		}},
	)

	if _, err := FetchCoupledFiles(context.Background(), cfg); err != nil {
		t.Fatalf("FetchCoupledFiles() error = %v", err)
	}
	staged, err := os.ReadFile(filepath.Join(stagingTree, "Assets", "Product", "protected.png"))
	if err != nil || !bytes.Equal(staged, content) {
		t.Fatalf("staged coupled file = %q, %v", staged, err)
	}
	if grants.renews.Load() != 1 || requests.Load() != 2 {
		t.Fatalf(
			"renewals = %d, requests = %d; want 1, 2",
			grants.renews.Load(),
			requests.Load(),
		)
	}
}

func TestFetchCoupledFilesRefetchesCorruptCacheEntryOnce(t *testing.T) {
	content := []byte("refetched coupled bytes\n")
	digest := sha256.Sum256(content)
	var requests atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(
		writer http.ResponseWriter,
		_ *http.Request,
	) {
		requests.Add(1)
		writer.Header().Set("Content-Length", fmt.Sprint(len(content)))
		_, _ = writer.Write(content)
	}))
	defer server.Close()
	cfg, stagingTree, cacheRoot := coupledTestConfig(
		t,
		server.URL,
		&testGrantSource{current: "grant-1"},
		[]packagecontract.MaterializedFile{{
			Bytes:          int64(len(content)),
			NormalizedPath: "Assets/Product/protected.png",
			SHA256:         digest,
		}},
	)
	digestHex := hex.EncodeToString(digest[:])
	corruptPath := filepath.Join(cacheRoot, digestHex[:4], digestHex)
	if err := os.MkdirAll(filepath.Dir(corruptPath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(corruptPath, bytes.ToUpper(content), 0o600); err != nil {
		t.Fatal(err)
	}

	if _, err := FetchCoupledFiles(context.Background(), cfg); err != nil {
		t.Fatalf("FetchCoupledFiles() error = %v", err)
	}
	staged, err := os.ReadFile(filepath.Join(stagingTree, "Assets", "Product", "protected.png"))
	if err != nil || !bytes.Equal(staged, content) {
		t.Fatalf("staged coupled file = %q, %v", staged, err)
	}
	if requests.Load() != 1 {
		t.Fatalf("request count = %d, want 1", requests.Load())
	}
	published, err := os.ReadFile(corruptPath)
	if err != nil || !bytes.Equal(published, content) {
		t.Fatalf("cache entry after refetch = %q, %v", published, err)
	}
}

func TestValidateCoupledReceiptRequiresExactProtectedCoverage(t *testing.T) {
	manifest := Manifest{
		ProtectionPolicyID: activeProtectionPolicyID,
		Files: []File{
			{Classification: "common", NormalizedPath: "Assets/Product/common.txt"},
			{Classification: "protected", NormalizedPath: "Assets/Product/a.png"},
			{Classification: "protected", NormalizedPath: "Assets/Product/b.png"},
		},
	}
	exact := packagecontract.MaterializationReceipt{
		OutputFiles: []packagecontract.MaterializedFile{
			{NormalizedPath: "Assets/Product/a.png"},
			{NormalizedPath: "Assets/Product/b.png"},
		},
	}
	if err := ValidateCoupledReceipt(manifest, exact); err != nil {
		t.Fatalf("ValidateCoupledReceipt(exact) error = %v", err)
	}
	partial := packagecontract.MaterializationReceipt{
		OutputFiles: exact.OutputFiles[:1],
	}
	if err := ValidateCoupledReceipt(manifest, partial); err == nil {
		t.Fatal("ValidateCoupledReceipt() accepted a partial receipt")
	}
	unexpected := packagecontract.MaterializationReceipt{
		OutputFiles: []packagecontract.MaterializedFile{
			{NormalizedPath: "Assets/Product/a.png"},
			{NormalizedPath: "Assets/Product/common.txt"},
		},
	}
	if err := ValidateCoupledReceipt(manifest, unexpected); err == nil {
		t.Fatal("ValidateCoupledReceipt() accepted an unexpected output path")
	}
	if err := ValidateCoupledReceipt(
		Manifest{ProtectionPolicyID: "supported-visual-assets-v1"},
		packagecontract.MaterializationReceipt{},
	); err == nil {
		t.Fatal("ValidateCoupledReceipt() accepted a removed protection policy")
	}
}
