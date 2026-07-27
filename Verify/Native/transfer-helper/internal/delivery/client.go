package delivery

import (
	"context"
	"crypto/ecdsa"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/yucp/transfer-helper/internal/dpop"
	"github.com/yucp/transfer-helper/internal/packagecontract"
)

const parallelChunkDownloads = 4

type StageCommonConfig struct {
	CacheRoot     string
	DeliveryGrant string
	Destination   string
	Manifest      Manifest
	ManifestURL   string
	PrivateKey    *ecdsa.PrivateKey
	Progress      func(completedBytes int64, totalBytes int64) error
}

type StagedFile struct {
	Bytes          int64
	NormalizedPath string
	SHA256         string
}

type StageCommonResult struct {
	Files        []StagedFile
	LogicalBytes int64
	LogicalFiles int
}

func FetchManifest(
	ctx context.Context,
	session packagecontract.InstallSession,
	grant packagecontract.DeliveryGrant,
	encodedGrant string,
	privateKey *ecdsa.PrivateKey,
) (Manifest, error) {
	versionID := grant.PackageVersionID()
	if versionID == "" {
		return Manifest{}, fmt.Errorf("delivery grant has no package read scope")
	}
	target := session.Bootstrap.URL
	proof, err := dpop.CreateProof(
		privateKey,
		http.MethodGet,
		target,
		encodedGrant,
		time.Now(),
	)
	if err != nil {
		return Manifest{}, fmt.Errorf("create manifest delivery proof: %w", err)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return Manifest{}, fmt.Errorf("create manifest delivery request: %w", err)
	}
	request.Header.Set("Authorization", "DPoP "+encodedGrant)
	request.Header.Set("DPoP", proof)
	client := &http.Client{
		Timeout: 30 * time.Second,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	response, err := client.Do(request)
	if err != nil {
		return Manifest{}, fmt.Errorf("download delivery manifest: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		storageFetches, parseErr := strconv.Atoi(
			response.Header.Get("X-Delivery-Storage-Fetches"),
		)
		if parseErr == nil && storageFetches >= 0 && storageFetches <= 2 {
			return Manifest{}, fmt.Errorf(
				"delivery manifest returned HTTP %d after %d storage reads",
				response.StatusCode,
				storageFetches,
			)
		}
		return Manifest{}, fmt.Errorf(
			"delivery manifest returned HTTP %d",
			response.StatusCode,
		)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, maxManifestBytes+1))
	if err != nil {
		return Manifest{}, fmt.Errorf("read delivery manifest: %w", err)
	}
	return ParseManifest(data, ManifestBinding{
		BindingRoot:    session.BindingRoot,
		ManifestSHA256: session.Bootstrap.SHA256,
		ProductID:      session.ProductID,
		ReleaseRoot:    session.ReleaseRoot,
		VersionID:      versionID,
	})
}

func StageCommonTree(ctx context.Context, cfg StageCommonConfig) (StageCommonResult, error) {
	if ctx == nil {
		return StageCommonResult{}, fmt.Errorf("delivery context is required")
	}
	if cfg.PrivateKey == nil || cfg.DeliveryGrant == "" {
		return StageCommonResult{}, fmt.Errorf("delivery proof credentials are required")
	}
	cacheRoot, err := requireAbsolutePath(cfg.CacheRoot, "chunk cache root")
	if err != nil {
		return StageCommonResult{}, err
	}
	destination, err := requireAbsolutePath(cfg.Destination, "staging destination")
	if err != nil {
		return StageCommonResult{}, err
	}
	if _, err := os.Lstat(destination); err == nil {
		return StageCommonResult{}, fmt.Errorf("staging destination already exists")
	} else if !errors.Is(err, os.ErrNotExist) {
		return StageCommonResult{}, fmt.Errorf("inspect staging destination: %w", err)
	}
	chunkBaseURL, err := deliveryChunkBaseURL(cfg.ManifestURL)
	if err != nil {
		return StageCommonResult{}, err
	}
	if err := os.MkdirAll(cacheRoot, 0o700); err != nil {
		return StageCommonResult{}, fmt.Errorf("create chunk cache root: %w", err)
	}
	commonFiles := make([]File, 0, len(cfg.Manifest.Files))
	uniqueChunks := make(map[string]Chunk)
	for index, file := range cfg.Manifest.Files {
		if err := packagecontract.ValidateNormalizedPath(file.NormalizedPath); err != nil {
			return StageCommonResult{}, fmt.Errorf("delivery file %d path: %w", index, err)
		}
		if file.Classification != "common" {
			continue
		}
		if err := validateFile(file, index); err != nil {
			return StageCommonResult{}, err
		}
		commonFiles = append(commonFiles, file)
		for _, chunk := range file.Chunks {
			if existing, ok := uniqueChunks[chunk.ID]; ok &&
				(existing.SHA256 != chunk.SHA256 || existing.Size != chunk.Size) {
				return StageCommonResult{}, fmt.Errorf("delivery manifest has conflicting chunk recipes")
			}
			uniqueChunks[chunk.ID] = chunk
		}
	}
	if err := downloadChunks(ctx, chunkDownloadConfig{
		BaseURL:       chunkBaseURL,
		CacheRoot:     cacheRoot,
		Chunks:        uniqueChunks,
		DeliveryGrant: cfg.DeliveryGrant,
		PrivateKey:    cfg.PrivateKey,
	}); err != nil {
		return StageCommonResult{}, err
	}
	return reconstructCommonTree(
		ctx,
		cacheRoot,
		destination,
		commonFiles,
		cfg.Progress,
	)
}

type chunkDownloadConfig struct {
	BaseURL       string
	CacheRoot     string
	Chunks        map[string]Chunk
	DeliveryGrant string
	PrivateKey    *ecdsa.PrivateKey
}

func downloadChunks(ctx context.Context, cfg chunkDownloadConfig) error {
	jobs := make(chan Chunk)
	workerContext, cancel := context.WithCancel(ctx)
	defer cancel()
	var workers sync.WaitGroup
	var firstError error
	var errorLock sync.Mutex
	client := &http.Client{
		Timeout: 30 * time.Second,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	worker := func() {
		defer workers.Done()
		for chunk := range jobs {
			if workerContext.Err() != nil {
				return
			}
			if err := ensureCachedChunk(workerContext, client, cfg, chunk); err != nil {
				errorLock.Lock()
				if firstError == nil {
					firstError = err
					cancel()
				}
				errorLock.Unlock()
				return
			}
		}
	}
	count := parallelChunkDownloads
	if len(cfg.Chunks) < count {
		count = len(cfg.Chunks)
	}
	for range count {
		workers.Add(1)
		go worker()
	}
	for _, chunk := range cfg.Chunks {
		select {
		case jobs <- chunk:
		case <-workerContext.Done():
			break
		}
		if workerContext.Err() != nil {
			break
		}
	}
	close(jobs)
	workers.Wait()
	if firstError != nil {
		return firstError
	}
	return ctx.Err()
}

func ensureCachedChunk(
	ctx context.Context,
	client *http.Client,
	cfg chunkDownloadConfig,
	chunk Chunk,
) error {
	cachePath := cachedChunkPath(cfg.CacheRoot, chunk.ID)
	if data, err := os.ReadFile(cachePath); err == nil {
		if verifyChunk(data, chunk) == nil {
			return nil
		}
		if removeErr := os.Remove(cachePath); removeErr != nil {
			return fmt.Errorf("remove corrupt cached chunk %s: %w", chunk.ID, removeErr)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("read cached chunk %s: %w", chunk.ID, err)
	}
	target := cfg.BaseURL + chunk.ID
	proof, err := dpop.CreateProof(
		cfg.PrivateKey,
		http.MethodGet,
		target,
		cfg.DeliveryGrant,
		time.Now(),
	)
	if err != nil {
		return fmt.Errorf("create chunk delivery proof: %w", err)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return fmt.Errorf("create chunk delivery request: %w", err)
	}
	request.Header.Set("Authorization", "DPoP "+cfg.DeliveryGrant)
	request.Header.Set("DPoP", proof)
	response, err := client.Do(request)
	if err != nil {
		return fmt.Errorf("download common chunk %s: %w", chunk.ID, err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf(
			"download common chunk %s returned HTTP %d",
			chunk.ID,
			response.StatusCode,
		)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, chunk.Size+1))
	if err != nil {
		return fmt.Errorf("read common chunk %s: %w", chunk.ID, err)
	}
	if err := verifyChunk(data, chunk); err != nil {
		return err
	}
	if err := publishCachedChunk(cachePath, data); err != nil {
		return err
	}
	existing, err := os.ReadFile(cachePath)
	if err != nil {
		return fmt.Errorf("read published common chunk %s: %w", chunk.ID, err)
	}
	return verifyChunk(existing, chunk)
}

func reconstructCommonTree(
	ctx context.Context,
	cacheRoot string,
	destination string,
	files []File,
	reportProgress func(completedBytes int64, totalBytes int64) error,
) (StageCommonResult, error) {
	parent := filepath.Dir(destination)
	if err := os.MkdirAll(parent, 0o700); err != nil {
		return StageCommonResult{}, fmt.Errorf("create staging parent: %w", err)
	}
	temporary, err := os.MkdirTemp(parent, "."+filepath.Base(destination)+".partial-")
	if err != nil {
		return StageCommonResult{}, fmt.Errorf("create staging tree: %w", err)
	}
	published := false
	defer func() {
		if !published {
			_ = os.RemoveAll(temporary)
		}
	}()
	stageRoot, err := os.OpenRoot(temporary)
	if err != nil {
		return StageCommonResult{}, fmt.Errorf("open staging tree: %w", err)
	}
	result := StageCommonResult{
		Files:        make([]StagedFile, 0, len(files)),
		LogicalFiles: len(files),
	}
	var totalBytes int64
	for _, file := range files {
		totalBytes += file.Bytes
		if totalBytes < 0 {
			_ = stageRoot.Close()
			return StageCommonResult{}, fmt.Errorf("common logical byte count overflow")
		}
	}
	for _, file := range files {
		if err := ctx.Err(); err != nil {
			_ = stageRoot.Close()
			return StageCommonResult{}, fmt.Errorf("stage common files: %w", err)
		}
		if err := writeCommonFile(stageRoot, cacheRoot, file); err != nil {
			_ = stageRoot.Close()
			return StageCommonResult{}, err
		}
		result.LogicalBytes += file.Bytes
		result.Files = append(result.Files, StagedFile{
			Bytes:          file.Bytes,
			NormalizedPath: file.NormalizedPath,
			SHA256:         file.SHA256,
		})
		if reportProgress != nil {
			if err := reportProgress(result.LogicalBytes, totalBytes); err != nil {
				_ = stageRoot.Close()
				return StageCommonResult{}, fmt.Errorf(
					"report common staging progress: %w",
					err,
				)
			}
		}
	}
	if err := stageRoot.Close(); err != nil {
		return StageCommonResult{}, fmt.Errorf("close staging tree: %w", err)
	}
	if err := os.Rename(temporary, destination); err != nil {
		return StageCommonResult{}, fmt.Errorf("publish staging tree atomically: %w", err)
	}
	published = true
	return result, nil
}

func writeCommonFile(stageRoot *os.Root, cacheRoot string, file File) error {
	relativePath := filepath.FromSlash(file.NormalizedPath)
	parent := filepath.Dir(relativePath)
	if parent != "." {
		if err := stageRoot.MkdirAll(parent, 0o700); err != nil {
			return fmt.Errorf("create staging directory for %q: %w", file.NormalizedPath, err)
		}
	}
	output, err := stageRoot.OpenFile(relativePath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return fmt.Errorf("create staging file %q: %w", file.NormalizedPath, err)
	}
	keep := false
	defer func() {
		_ = output.Close()
		if !keep {
			_ = stageRoot.Remove(relativePath)
		}
	}()
	hasher := sha256.New()
	writer := io.MultiWriter(output, hasher)
	var written int64
	for _, chunk := range file.Chunks {
		source, err := os.Open(cachedChunkPath(cacheRoot, chunk.ID))
		if err != nil {
			return fmt.Errorf("open cached chunk %s: %w", chunk.ID, err)
		}
		count, copyErr := io.Copy(writer, source)
		closeErr := source.Close()
		if copyErr != nil {
			return fmt.Errorf("copy cached chunk %s: %w", chunk.ID, copyErr)
		}
		if closeErr != nil {
			return fmt.Errorf("close cached chunk %s: %w", chunk.ID, closeErr)
		}
		written += count
	}
	if written != file.Bytes || hex.EncodeToString(hasher.Sum(nil)) != file.SHA256 {
		return fmt.Errorf("staged file %q failed SHA-256 verification", file.NormalizedPath)
	}
	if err := output.Sync(); err != nil {
		return fmt.Errorf("synchronize staging file %q: %w", file.NormalizedPath, err)
	}
	if err := output.Close(); err != nil {
		return fmt.Errorf("close staging file %q: %w", file.NormalizedPath, err)
	}
	keep = true
	return nil
}

func deliveryChunkBaseURL(manifestURL string) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(manifestURL))
	if err != nil || !parsed.IsAbs() || !strings.HasSuffix(parsed.Path, "/manifest") ||
		parsed.RawQuery != "" || parsed.Fragment != "" || parsed.User != nil {
		return "", fmt.Errorf("delivery manifest URL is invalid")
	}
	parsed.Path = strings.TrimSuffix(parsed.Path, "manifest") + "chunks/"
	return parsed.String(), nil
}

func cachedChunkPath(cacheRoot string, chunkID string) string {
	return filepath.Join(cacheRoot, chunkID[:4], chunkID)
}

func verifyChunk(data []byte, chunk Chunk) error {
	digest := sha256.Sum256(data)
	if int64(len(data)) != chunk.Size || hex.EncodeToString(digest[:]) != chunk.SHA256 {
		return fmt.Errorf("common chunk %s failed verification", chunk.ID)
	}
	return nil
}

func publishCachedChunk(destination string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(destination), 0o700); err != nil {
		return fmt.Errorf("create common chunk cache directory: %w", err)
	}
	temporary, err := os.CreateTemp(filepath.Dir(destination), ".chunk-*.partial")
	if err != nil {
		return fmt.Errorf("create common chunk temporary file: %w", err)
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o600); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("set common chunk permissions: %w", err)
	}
	if _, err := temporary.Write(data); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("write common chunk: %w", err)
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("synchronize common chunk: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("close common chunk: %w", err)
	}
	if err := os.Link(temporaryPath, destination); err != nil && !errors.Is(err, os.ErrExist) {
		return fmt.Errorf("publish common chunk: %w", err)
	}
	return nil
}

func requireAbsolutePath(raw string, name string) (string, error) {
	if strings.TrimSpace(raw) == "" || !filepath.IsAbs(raw) {
		return "", fmt.Errorf("%s must be absolute", name)
	}
	resolved, err := filepath.Abs(raw)
	if err != nil {
		return "", fmt.Errorf("resolve %s: %w", name, err)
	}
	return resolved, nil
}
