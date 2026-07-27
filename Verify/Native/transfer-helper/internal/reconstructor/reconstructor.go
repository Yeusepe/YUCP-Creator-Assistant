package reconstructor

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/yucp/transfer-helper/internal/packagecontract"
)

const DesyncUncompressedSHA256V1 = "desync-uncompressed-sha256-v1"

type Config struct {
	ChunkCacheRoot  string
	Destination     string
	EncodingProfile string
	ExpectedKeyID   []byte
	PublicKey       ed25519.PublicKey
	SignedShard     []byte
}

type Result struct {
	ChunkObjects    int
	ChunkReferences int
	FileCount       int
	LogicalBytes    int64
	Path            string
	ReleaseRoot     string
}

func Reconstruct(ctx context.Context, cfg Config) (Result, error) {
	if ctx == nil {
		return Result{}, fmt.Errorf("reconstruction context is required")
	}
	if cfg.EncodingProfile != DesyncUncompressedSHA256V1 {
		return Result{}, fmt.Errorf("unsupported package encoding profile %q", cfg.EncodingProfile)
	}
	payload, err := packagecontract.VerifySign1(
		cfg.SignedShard,
		cfg.PublicKey,
		cfg.ExpectedKeyID,
		packagecontract.FileTableShardPurpose,
	)
	if err != nil {
		return Result{}, fmt.Errorf("verify signed file-table shard: %w", err)
	}
	shard, err := packagecontract.ParseFileTableShard(payload)
	if err != nil {
		return Result{}, fmt.Errorf("parse signed file-table shard: %w", err)
	}
	for _, file := range shard.Files {
		if file.Classification != packagecontract.ClassificationCommon {
			return Result{}, fmt.Errorf(
				"file %q is protected source content and cannot be reconstructed on a buyer device",
				file.Path,
			)
		}
	}

	cachePath, err := filepath.Abs(strings.TrimSpace(cfg.ChunkCacheRoot))
	if err != nil || strings.TrimSpace(cfg.ChunkCacheRoot) == "" {
		return Result{}, fmt.Errorf("chunk cache root must be a valid path")
	}
	cacheRoot, err := os.OpenRoot(cachePath)
	if err != nil {
		return Result{}, fmt.Errorf("open chunk cache root: %w", err)
	}
	defer cacheRoot.Close()

	destination, err := filepath.Abs(strings.TrimSpace(cfg.Destination))
	if err != nil || strings.TrimSpace(cfg.Destination) == "" {
		return Result{}, fmt.Errorf("staging destination must be a valid path")
	}
	if _, err := os.Lstat(destination); err == nil {
		return Result{}, fmt.Errorf("staging destination already exists")
	} else if !errors.Is(err, os.ErrNotExist) {
		return Result{}, fmt.Errorf("inspect staging destination: %w", err)
	}
	parent := filepath.Dir(destination)
	if err := os.MkdirAll(parent, 0o700); err != nil {
		return Result{}, fmt.Errorf("create staging parent: %w", err)
	}
	tempPath, err := os.MkdirTemp(parent, "."+filepath.Base(destination)+".partial-")
	if err != nil {
		return Result{}, fmt.Errorf("create reconstruction staging tree: %w", err)
	}
	published := false
	defer func() {
		if !published {
			_ = os.RemoveAll(tempPath)
		}
	}()
	stageRoot, err := os.OpenRoot(tempPath)
	if err != nil {
		return Result{}, fmt.Errorf("open reconstruction staging tree: %w", err)
	}

	result := Result{
		FileCount:   len(shard.Files),
		Path:        destination,
		ReleaseRoot: hex.EncodeToString(shard.ReleaseRoot[:]),
	}
	uniqueChunks := make(map[[32]byte]struct{})
	for _, file := range shard.Files {
		if err := ctx.Err(); err != nil {
			_ = stageRoot.Close()
			return Result{}, fmt.Errorf("reconstruction canceled: %w", err)
		}
		if err := reconstructFile(ctx, cacheRoot, stageRoot, file); err != nil {
			_ = stageRoot.Close()
			return Result{}, err
		}
		result.LogicalBytes += file.Length
		result.ChunkReferences += len(file.Chunks)
		for _, chunk := range file.Chunks {
			uniqueChunks[chunk.EncodedObjectDigest] = struct{}{}
		}
	}
	result.ChunkObjects = len(uniqueChunks)
	if err := stageRoot.Close(); err != nil {
		return Result{}, fmt.Errorf("close reconstruction staging tree: %w", err)
	}
	if _, err := os.Lstat(destination); err == nil {
		return Result{}, fmt.Errorf("staging destination appeared during reconstruction")
	} else if !errors.Is(err, os.ErrNotExist) {
		return Result{}, fmt.Errorf("reinspect staging destination: %w", err)
	}
	if err := publishStagingTree(tempPath, destination, parent); err != nil {
		return Result{}, err
	}
	published = true
	return result, nil
}

func reconstructFile(
	ctx context.Context,
	cacheRoot *os.Root,
	stageRoot *os.Root,
	recipe packagecontract.FileRecipe,
) error {
	relativePath := filepath.FromSlash(recipe.Path)
	parent := filepath.Dir(relativePath)
	if parent != "." {
		if err := stageRoot.MkdirAll(parent, 0o700); err != nil {
			return fmt.Errorf("create staging directory for %q: %w", recipe.Path, err)
		}
	}
	output, err := stageRoot.OpenFile(relativePath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return fmt.Errorf("create staging file %q: %w", recipe.Path, err)
	}
	keep := false
	defer func() {
		_ = output.Close()
		if !keep {
			_ = stageRoot.Remove(relativePath)
		}
	}()

	fileHasher, err := packagecontract.NewSingleFieldHasher("yucp:file:v2", uint64(recipe.Length))
	if err != nil {
		return fmt.Errorf("create file verifier for %q: %w", recipe.Path, err)
	}
	var written int64
	for index, chunk := range recipe.Chunks {
		if err := ctx.Err(); err != nil {
			return fmt.Errorf("reconstruction canceled: %w", err)
		}
		if chunk.EncodedLength != chunk.LogicalLength {
			return fmt.Errorf(
				"file %q chunk %d is not valid for encoding profile %s",
				recipe.Path,
				index,
				DesyncUncompressedSHA256V1,
			)
		}
		count, err := copyVerifiedIdentityChunk(cacheRoot, output, fileHasher, chunk)
		if err != nil {
			return fmt.Errorf("reconstruct file %q chunk %d: %w", recipe.Path, index, err)
		}
		written += count
	}
	if written != recipe.Length {
		return fmt.Errorf("file %q reconstructed %d bytes, expected %d", recipe.Path, written, recipe.Length)
	}
	if !bytes.Equal(fileHasher.Sum(nil), recipe.Digest[:]) {
		return fmt.Errorf("file %q failed its domain-separated digest", recipe.Path)
	}
	if err := output.Chmod(0o644); err != nil {
		return fmt.Errorf("set staging file permissions for %q: %w", recipe.Path, err)
	}
	if err := output.Sync(); err != nil {
		return fmt.Errorf("synchronize staging file %q: %w", recipe.Path, err)
	}
	if err := output.Close(); err != nil {
		return fmt.Errorf("close staging file %q: %w", recipe.Path, err)
	}
	keep = true
	return nil
}

func copyVerifiedIdentityChunk(
	cacheRoot *os.Root,
	output io.Writer,
	fileHasher io.Writer,
	recipe packagecontract.ChunkRecipe,
) (int64, error) {
	objectID := hex.EncodeToString(recipe.EncodedObjectDigest[:])
	cacheName := filepath.Join(objectID[:4], objectID)
	source, err := cacheRoot.Open(cacheName)
	if err != nil {
		return 0, fmt.Errorf("open cached object %s: %w", objectID, err)
	}
	defer source.Close()
	info, err := source.Stat()
	if err != nil {
		return 0, fmt.Errorf("inspect cached object %s: %w", objectID, err)
	}
	if !info.Mode().IsRegular() || info.Size() != recipe.EncodedLength {
		return 0, fmt.Errorf("cached object %s has an invalid type or length", objectID)
	}
	encodedHasher := sha256.New()
	logicalHasher, err := packagecontract.NewSingleFieldHasher(
		"yucp:chunk:v2",
		uint64(recipe.LogicalLength),
	)
	if err != nil {
		return 0, fmt.Errorf("create logical chunk verifier: %w", err)
	}
	writer := io.MultiWriter(output, fileHasher, encodedHasher, logicalHasher)
	written, err := io.Copy(writer, source)
	if err != nil {
		return 0, fmt.Errorf("read cached object %s: %w", objectID, err)
	}
	if written != recipe.EncodedLength {
		return 0, fmt.Errorf("cached object %s changed length during reconstruction", objectID)
	}
	if !bytes.Equal(encodedHasher.Sum(nil), recipe.EncodedObjectDigest[:]) {
		return 0, fmt.Errorf("cached object %s failed its SHA-256 digest", objectID)
	}
	if !bytes.Equal(logicalHasher.Sum(nil), recipe.LogicalDigest[:]) {
		return 0, fmt.Errorf("cached object %s failed its logical digest", objectID)
	}
	return written, nil
}
