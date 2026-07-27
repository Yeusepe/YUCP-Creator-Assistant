package reconstructor

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/yucp/transfer-helper/internal/packagecontract"
)

var (
	testKeyID      = []byte("package-test-root-1")
	testPrivateKey = ed25519.NewKeyFromSeed(bytesFromRange())
	testPublicKey  = testPrivateKey.Public().(ed25519.PublicKey)
)

func TestReconstructBuildsVerifiedTreeAndReusesCachedObjects(t *testing.T) {
	root := t.TempDir()
	cachePath := filepath.Join(root, "cache")
	first := []byte("shared shader bytes\n")
	second := []byte("material bytes\n")
	putChunk(t, cachePath, first)
	putChunk(t, cachePath, second)

	files := []testFile{
		{Path: "Assets/Product/material.mat", Chunks: [][]byte{second}},
		{Path: "Assets/Product/shader.shader", Chunks: [][]byte{first, first}},
	}
	signed := signedShard(t, files)
	destination := filepath.Join(root, "staging", "release")
	result, err := Reconstruct(context.Background(), Config{
		ChunkCacheRoot:  cachePath,
		Destination:     destination,
		EncodingProfile: DesyncUncompressedSHA256V1,
		ExpectedKeyID:   testKeyID,
		PublicKey:       testPublicKey,
		SignedShard:     signed,
	})
	if err != nil {
		t.Fatalf("Reconstruct() error = %v", err)
	}
	if result.FileCount != 2 || result.ChunkReferences != 3 || result.ChunkObjects != 2 {
		t.Fatalf("Reconstruct() result = %#v", result)
	}
	assertFileBytes(t, destination, files[0].Path, second)
	assertFileBytes(t, destination, files[1].Path, append(append([]byte{}, first...), first...))
}

func TestReconstructRejectsCorruptCacheWithoutPublishing(t *testing.T) {
	root := t.TempDir()
	cachePath := filepath.Join(root, "cache")
	chunk := []byte("verified bytes\n")
	objectPath := putChunk(t, cachePath, chunk)
	signed := signedShard(t, []testFile{{Path: "Assets/Product/file.txt", Chunks: [][]byte{chunk}}})
	corrupted := append([]byte(nil), chunk...)
	corrupted[0] ^= 0xff
	if err := os.WriteFile(objectPath, corrupted, 0o600); err != nil {
		t.Fatalf("corrupt cached object: %v", err)
	}
	destination := filepath.Join(root, "staging", "release")
	if _, err := Reconstruct(context.Background(), Config{
		ChunkCacheRoot:  cachePath,
		Destination:     destination,
		EncodingProfile: DesyncUncompressedSHA256V1,
		ExpectedKeyID:   testKeyID,
		PublicKey:       testPublicKey,
		SignedShard:     signed,
	}); err == nil || !strings.Contains(err.Error(), "SHA-256") {
		t.Fatalf("Reconstruct() corrupt-cache error = %v", err)
	}
	if _, err := os.Lstat(destination); !os.IsNotExist(err) {
		t.Fatalf("failed reconstruction published destination, stat error = %v", err)
	}
}

func TestParseFileTableRejectsTraversalBeforeReconstruction(t *testing.T) {
	payload := shardPayload(t, []testFile{{Path: "../escape.txt", Chunks: [][]byte{[]byte("escape")}}})
	if _, err := packagecontract.ParseFileTableShard(payload); err == nil {
		t.Fatal("ParseFileTableShard() accepted path traversal")
	}
}

func TestReconstructRejectsProtectedSource(t *testing.T) {
	root := t.TempDir()
	cachePath := filepath.Join(root, "cache")
	chunk := []byte("protected source\n")
	putChunk(t, cachePath, chunk)
	signed := signedShard(t, []testFile{{
		Path:           "Assets/Product/protected.png",
		Chunks:         [][]byte{chunk},
		Classification: packagecontract.ClassificationProtectedSource,
	}})
	destination := filepath.Join(root, "staging", "release")
	if _, err := Reconstruct(context.Background(), Config{
		ChunkCacheRoot:  cachePath,
		Destination:     destination,
		EncodingProfile: DesyncUncompressedSHA256V1,
		ExpectedKeyID:   testKeyID,
		PublicKey:       testPublicKey,
		SignedShard:     signed,
	}); err == nil || !strings.Contains(err.Error(), "protected source") {
		t.Fatalf("Reconstruct() protected-source error = %v", err)
	}
	if _, err := os.Lstat(destination); !os.IsNotExist(err) {
		t.Fatalf("protected reconstruction published destination, stat error = %v", err)
	}
}

type testFile struct {
	Chunks         [][]byte
	Classification packagecontract.Classification
	Path           string
}

func signedShard(t *testing.T, files []testFile) []byte {
	t.Helper()
	payload := shardPayload(t, files)
	protected := mustCanonical(t, map[any]any{
		int64(1):    int64(-8),
		int64(2):    []any{int64(1001)},
		int64(4):    append([]byte(nil), testKeyID...),
		int64(1001): packagecontract.FileTableShardPurpose,
	})
	signatureStructure := mustCanonical(t, []any{"Signature1", protected, []byte{}, payload})
	signature := ed25519.Sign(testPrivateKey, signatureStructure)
	return mustCanonical(t, []any{protected, map[any]any{}, payload, signature})
}

func shardPayload(t *testing.T, files []testFile) []byte {
	t.Helper()
	fileValues := make([]any, 0, len(files))
	for _, file := range files {
		combined := make([]byte, 0)
		chunkValues := make([]any, 0, len(file.Chunks))
		var offset int64
		for _, chunk := range file.Chunks {
			logicalDigest := mustDomainHash(t, "yucp:chunk:v2", chunk)
			encodedDigest := sha256.Sum256(chunk)
			chunkValues = append(chunkValues, map[any]any{
				int64(0): logicalDigest[:],
				int64(1): int64(len(chunk)),
				int64(2): offset,
				int64(3): int64(len(chunk)),
				int64(4): encodedDigest[:],
			})
			offset += int64(len(chunk))
			combined = append(combined, chunk...)
		}
		fileDigest := mustDomainHash(t, "yucp:file:v2", combined)
		fileValues = append(fileValues, map[any]any{
			int64(0): file.Path,
			int64(1): int64(len(combined)),
			int64(2): fileDigest[:],
			int64(3): int64(file.Classification),
			int64(4): chunkValues,
		})
	}
	return mustCanonical(t, map[any]any{
		int64(0): int64(2),
		int64(1): make([]byte, 32),
		int64(2): fileValues,
	})
}

func putChunk(t *testing.T, cachePath string, data []byte) string {
	t.Helper()
	digest := sha256.Sum256(data)
	objectID := hex.EncodeToString(digest[:])
	objectPath := filepath.Join(cachePath, objectID[:4], objectID)
	if err := os.MkdirAll(filepath.Dir(objectPath), 0o700); err != nil {
		t.Fatalf("create cache directory: %v", err)
	}
	if err := os.WriteFile(objectPath, data, 0o600); err != nil {
		t.Fatalf("write cache object: %v", err)
	}
	return objectPath
}

func mustDomainHash(t *testing.T, purpose string, data []byte) [32]byte {
	t.Helper()
	digest, err := packagecontract.DomainHash(purpose, data)
	if err != nil {
		t.Fatalf("DomainHash() error = %v", err)
	}
	return digest
}

func mustCanonical(t *testing.T, value any) []byte {
	t.Helper()
	data, err := packagecontract.EncodeCanonical(value)
	if err != nil {
		t.Fatalf("EncodeCanonical() error = %v", err)
	}
	return data
}

func assertFileBytes(t *testing.T, root string, relativePath string, expected []byte) {
	t.Helper()
	actual, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(relativePath)))
	if err != nil {
		t.Fatalf("read reconstructed file: %v", err)
	}
	if string(actual) != string(expected) {
		t.Fatalf("reconstructed bytes = %q, want %q", actual, expected)
	}
}

func bytesFromRange() []byte {
	seed := make([]byte, ed25519.SeedSize)
	for index := range seed {
		seed[index] = byte(index)
	}
	return seed
}
