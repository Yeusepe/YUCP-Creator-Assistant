package delivery

import (
	"bytes"
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
	"time"

	"github.com/yucp/transfer-helper/internal/packagecontract"
)

// CoupledFetchConfig drives per-file protected delivery for v3 receipts:
// each receipt output file is fetched from the coupled contract route,
// verified against its signed digest, cached content-addressed, and written
// into the pre-publish staging tree.
type CoupledFetchConfig struct {
	Audience    string
	CacheRoot   string
	GrantSource GrantSource
	IdleTimeout time.Duration
	JobID       string
	PrivateKey  *ecdsa.PrivateKey
	Progress    func(completedBytes int64, totalBytes int64) error
	Receipt     packagecontract.MaterializationReceipt
	StageRoot   *os.Root
}

// ValidateCoupledReceipt requires the v3 receipt to cover exactly the
// manifest's protected files: coupled delivery has no byte-exact passthrough
// channel (the v2 ZIP carried those), so a partial receipt would stage an
// incomplete tree.
func ValidateCoupledReceipt(
	manifest Manifest,
	receipt packagecontract.MaterializationReceipt,
) error {
	if manifest.ProtectionPolicyID != activeProtectionPolicyID {
		return fmt.Errorf("unsupported protection policy %s", manifest.ProtectionPolicyID)
	}
	protected := make(map[string]struct{})
	for _, file := range manifest.Files {
		if file.Classification == "protected" {
			protected[file.NormalizedPath] = struct{}{}
		}
	}
	// Receipt output paths are strictly ordered (no duplicates), so count
	// equality plus membership proves exact coverage.
	if len(receipt.OutputFiles) != len(protected) {
		return fmt.Errorf("coupled receipt does not cover the protected manifest files")
	}
	for _, file := range receipt.OutputFiles {
		if _, ok := protected[file.NormalizedPath]; !ok {
			return fmt.Errorf("coupled receipt contains an unexpected output path")
		}
	}
	return nil
}

// FetchCoupledFiles stages every receipt output file, serving repeat installs
// and unchanged updates from the local content-addressed coupled-file cache
// so they fetch nothing.
func FetchCoupledFiles(
	ctx context.Context,
	cfg CoupledFetchConfig,
) ([]StagedFile, error) {
	if ctx == nil || cfg.PrivateKey == nil || cfg.GrantSource == nil || cfg.StageRoot == nil {
		return nil, fmt.Errorf("coupled delivery credentials are required")
	}
	if cfg.JobID == "" {
		return nil, fmt.Errorf("coupled delivery job is required")
	}
	cacheRoot, err := requireAbsolutePath(cfg.CacheRoot, "coupled cache root")
	if err != nil {
		return nil, err
	}
	idleTimeout, err := protectedIdleTimeout(cfg.IdleTimeout)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(cacheRoot, 0o700); err != nil {
		return nil, fmt.Errorf("create coupled cache root: %w", err)
	}
	var totalBytes int64
	for _, file := range cfg.Receipt.OutputFiles {
		totalBytes += file.Bytes
		if totalBytes < 0 {
			return nil, fmt.Errorf("coupled logical byte count overflow")
		}
	}
	client := protectedDeliveryClient()
	results := make([]StagedFile, 0, len(cfg.Receipt.OutputFiles))
	var completedBytes int64
	for _, file := range cfg.Receipt.OutputFiles {
		digestHex := hex.EncodeToString(file.SHA256[:])
		cachePath := filepath.Join(cacheRoot, digestHex[:4], digestHex)
		endpoint, endpointErr := endpointURL(
			cfg.Audience,
			"/v2/coupled/"+url.PathEscape(cfg.JobID)+"/"+digestHex,
		)
		if endpointErr != nil {
			return nil, endpointErr
		}
		reportDownloaded := func(downloadedBytes int64) error {
			if cfg.Progress == nil {
				return nil
			}
			return cfg.Progress(completedBytes+downloadedBytes, totalBytes)
		}
		staged := false
		for attempt := 0; attempt < 2; attempt++ {
			if _, statErr := os.Lstat(cachePath); errors.Is(statErr, os.ErrNotExist) {
				if downloadErr := downloadCoupledFile(
					ctx,
					client,
					cfg,
					endpoint,
					cachePath,
					file,
					idleTimeout,
					reportDownloaded,
				); downloadErr != nil {
					return nil, downloadErr
				}
			} else if statErr != nil {
				return nil, fmt.Errorf("inspect cached coupled file: %w", statErr)
			}
			stageErr := stageCoupledFile(cfg.StageRoot, cachePath, file)
			if stageErr == nil {
				staged = true
				break
			}
			// The cached bytes no longer match the signed digest: drop the
			// entry and refetch once before failing the install.
			if removeErr := os.Remove(cachePath); removeErr != nil || attempt == 1 {
				return nil, stageErr
			}
		}
		if !staged {
			return nil, fmt.Errorf(
				"coupled file %s failed verification after refetch",
				file.NormalizedPath,
			)
		}
		// Cache pruning uses access recency.
		now := time.Now()
		_ = os.Chtimes(cachePath, now, now)
		completedBytes += file.Bytes
		if cfg.Progress != nil {
			if progressErr := cfg.Progress(completedBytes, totalBytes); progressErr != nil {
				return nil, fmt.Errorf("publish coupled delivery progress: %w", progressErr)
			}
		}
		results = append(results, StagedFile{
			Bytes:          file.Bytes,
			NormalizedPath: file.NormalizedPath,
			SHA256:         digestHex,
		})
	}
	return results, nil
}

// downloadCoupledFile streams one coupled output file into the cache using
// the same bounded resume loop and grant renewal as the rendition download.
func downloadCoupledFile(
	ctx context.Context,
	client *http.Client,
	cfg CoupledFetchConfig,
	endpoint string,
	cachePath string,
	file packagecontract.MaterializedFile,
	idleTimeout time.Duration,
	reportDownloaded func(downloadedBytes int64) error,
) error {
	grant, err := cfg.GrantSource.Current(ctx)
	if err != nil {
		return fmt.Errorf("read coupled delivery authorization: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(cachePath), 0o700); err != nil {
		return fmt.Errorf("create coupled cache directory: %w", err)
	}
	temporary, err := os.CreateTemp(filepath.Dir(cachePath), ".coupled-*.partial")
	if err != nil {
		return fmt.Errorf("create coupled temporary file: %w", err)
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o600); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("set coupled file permissions: %w", err)
	}
	hasher := sha256.New()
	var written int64
	for attempt := 0; attempt < maxRenditionDownloadAttempts &&
		written < file.Bytes; attempt++ {
		offset := written
		response, nextGrant, requestErr := requestRenditionRange(
			ctx,
			client,
			http.MethodGet,
			endpoint,
			nil,
			grant,
			cfg.GrantSource,
			cfg.PrivateKey,
			offset,
			file.Bytes,
		)
		grant = nextGrant
		if requestErr != nil {
			_ = temporary.Close()
			return requestErr
		}
		idleReader := newIdleBodyReader(response.Body, idleTimeout)
		copied, copyErr := io.Copy(
			io.MultiWriter(temporary, hasher),
			io.LimitReader(idleReader, file.Bytes-offset+1),
		)
		idleReader.Stop()
		_ = response.Body.Close()
		written += copied
		if reportErr := reportDownloaded(written); reportErr != nil {
			_ = temporary.Close()
			return fmt.Errorf("publish coupled delivery progress: %w", reportErr)
		}
		if written > file.Bytes {
			_ = temporary.Close()
			return fmt.Errorf("coupled file exceeded its signed length")
		}
		if written == file.Bytes {
			break
		}
		if ctx.Err() != nil {
			_ = temporary.Close()
			return fmt.Errorf("read coupled file: %w", ctx.Err())
		}
		if copyErr != nil && !isResumableRenditionReadError(copyErr) {
			_ = temporary.Close()
			return fmt.Errorf("read coupled file: %w", copyErr)
		}
		if copied == 0 {
			_ = temporary.Close()
			if copyErr == nil {
				copyErr = io.ErrUnexpectedEOF
			}
			return fmt.Errorf("read coupled file without progress: %w", copyErr)
		}
	}
	if written != file.Bytes || !bytes.Equal(hasher.Sum(nil), file.SHA256[:]) {
		_ = temporary.Close()
		return fmt.Errorf(
			"coupled file %s failed signed verification",
			file.NormalizedPath,
		)
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("synchronize coupled file: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("close coupled file: %w", err)
	}
	if err := os.Link(temporaryPath, cachePath); err != nil && !errors.Is(err, os.ErrExist) {
		return fmt.Errorf("publish coupled file: %w", err)
	}
	return nil
}

// stageCoupledFile copies a cached coupled file into the staging tree,
// re-verifying the signed digest and length while copying.
func stageCoupledFile(
	stageRoot *os.Root,
	cachePath string,
	file packagecontract.MaterializedFile,
) error {
	source, err := os.Open(cachePath)
	if err != nil {
		return fmt.Errorf("open cached coupled file: %w", err)
	}
	defer source.Close()
	relativePath := filepath.FromSlash(file.NormalizedPath)
	parent := filepath.Dir(relativePath)
	if parent != "." {
		if err := stageRoot.MkdirAll(parent, 0o700); err != nil {
			return fmt.Errorf("create coupled staging directory: %w", err)
		}
	}
	output, err := stageRoot.OpenFile(
		relativePath,
		os.O_WRONLY|os.O_CREATE|os.O_EXCL,
		0o600,
	)
	if err != nil {
		return fmt.Errorf("create coupled staging file: %w", err)
	}
	keep := false
	defer func() {
		_ = output.Close()
		if !keep {
			_ = stageRoot.Remove(relativePath)
		}
	}()
	hasher := sha256.New()
	written, copyErr := io.Copy(
		io.MultiWriter(output, hasher),
		io.LimitReader(source, file.Bytes+1),
	)
	if copyErr != nil ||
		written != file.Bytes ||
		!bytes.Equal(hasher.Sum(nil), file.SHA256[:]) {
		return fmt.Errorf(
			"cached coupled file %s failed verification",
			file.NormalizedPath,
		)
	}
	if err := output.Sync(); err != nil {
		return fmt.Errorf("synchronize coupled staging file: %w", err)
	}
	if err := output.Close(); err != nil {
		return fmt.Errorf("close coupled staging file: %w", err)
	}
	keep = true
	return nil
}
