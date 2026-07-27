package tufclient

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"github.com/theupdateframework/go-tuf/v2/metadata/config"
	"github.com/theupdateframework/go-tuf/v2/metadata/updater"
)

const (
	defaultHTTPTimeout = 30 * time.Second
	maxHelperBytes     = 256 * 1024 * 1024
	maxRootBytes       = 512 * 1024
)

type Config struct {
	HTTPTimeout       time.Duration
	LocalMetadataDir  string
	RemoteMetadataURL string
	RemoteTargetsURL  string
	TrustedRoot       []byte
}

type InstallResult struct {
	ByteLength int64
	Cached     bool
	Path       string
	SHA256     string
	Target     string
}

func InstallTarget(cfg Config, targetName string, destination string) (InstallResult, error) {
	normalized, err := normalizeConfig(cfg)
	if err != nil {
		return InstallResult{}, err
	}
	targetName, err = normalizeTargetName(targetName)
	if err != nil {
		return InstallResult{}, err
	}
	destination, err = normalizeDestination(destination)
	if err != nil {
		return InstallResult{}, err
	}

	// go-tuf updater API: https://pkg.go.dev/github.com/theupdateframework/go-tuf/v2/metadata/updater
	tufConfig, err := config.New(normalized.RemoteMetadataURL, normalized.TrustedRoot)
	if err != nil {
		return InstallResult{}, fmt.Errorf("create TUF configuration: %w", err)
	}
	tufConfig.LocalMetadataDir = normalized.LocalMetadataDir
	tufConfig.LocalTargetsDir = filepath.Dir(destination)
	tufConfig.RemoteTargetsURL = normalized.RemoteTargetsURL
	tufConfig.MaxRootRotations = 32
	tufConfig.RootMaxLength = maxRootBytes
	tufConfig.TimestampMaxLength = 64 * 1024
	tufConfig.SnapshotMaxLength = 4 * 1024 * 1024
	tufConfig.TargetsMaxLength = 16 * 1024 * 1024
	tufConfig.PrefixTargetsWithHash = true
	tufConfig.DisableLocalCache = false
	tufConfig.UnsafeLocalMode = false

	httpClient := &http.Client{
		Timeout: normalized.HTTPTimeout,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	if err := tufConfig.SetDefaultFetcherHTTPClient(httpClient); err != nil {
		return InstallResult{}, fmt.Errorf("configure TUF HTTP client: %w", err)
	}

	client, err := updater.New(tufConfig)
	if err != nil {
		return InstallResult{}, fmt.Errorf("open trusted TUF metadata: %w", err)
	}
	if err := client.Refresh(); err != nil {
		return InstallResult{}, fmt.Errorf("refresh trusted TUF metadata: %w", err)
	}
	targetInfo, err := client.GetTargetInfo(targetName)
	if err != nil {
		return InstallResult{}, fmt.Errorf("resolve trusted TUF target %q: %w", targetName, err)
	}
	if targetInfo.Length < 1 || targetInfo.Length > maxHelperBytes {
		return InstallResult{}, fmt.Errorf(
			"trusted TUF target %q has unsupported length %d",
			targetName,
			targetInfo.Length,
		)
	}

	if existing, readErr := os.ReadFile(destination); readErr == nil {
		if verifyErr := targetInfo.VerifyLengthHashes(existing); verifyErr == nil {
			return buildResult(targetName, destination, existing, true), nil
		}
	} else if !errors.Is(readErr, os.ErrNotExist) {
		return InstallResult{}, fmt.Errorf("read existing helper target %q: %w", destination, readErr)
	}

	if err := os.MkdirAll(filepath.Dir(destination), 0o700); err != nil {
		return InstallResult{}, fmt.Errorf("create helper target directory: %w", err)
	}
	tempFile, err := os.CreateTemp(filepath.Dir(destination), ".yucp-helper-target-*")
	if err != nil {
		return InstallResult{}, fmt.Errorf("create helper target temporary file: %w", err)
	}
	tempPath := tempFile.Name()
	if err := tempFile.Close(); err != nil {
		_ = os.Remove(tempPath)
		return InstallResult{}, fmt.Errorf("close helper target temporary file: %w", err)
	}
	defer os.Remove(tempPath)

	_, downloaded, err := client.DownloadTarget(targetInfo, tempPath, normalized.RemoteTargetsURL)
	if err != nil {
		return InstallResult{}, fmt.Errorf("download trusted TUF target %q: %w", targetName, err)
	}
	if err := syncFile(tempPath); err != nil {
		return InstallResult{}, err
	}
	if err := os.Chmod(tempPath, 0o700); err != nil {
		return InstallResult{}, fmt.Errorf("set helper target permissions: %w", err)
	}
	if err := publishTargetAtomically(tempPath, destination); err != nil {
		existing, readErr := os.ReadFile(destination)
		if readErr != nil {
			return InstallResult{}, fmt.Errorf(
				"publish helper target atomically: %w",
				err,
			)
		}
		if verifyErr := targetInfo.VerifyLengthHashes(existing); verifyErr != nil {
			return InstallResult{}, fmt.Errorf(
				"publish helper target atomically: %v; published target verification: %w",
				err,
				verifyErr,
			)
		}
		return buildResult(targetName, destination, existing, true), nil
	}

	return buildResult(targetName, destination, downloaded, false), nil
}

func normalizeConfig(cfg Config) (Config, error) {
	if len(cfg.TrustedRoot) == 0 || len(cfg.TrustedRoot) > maxRootBytes {
		return Config{}, fmt.Errorf("trusted TUF root must contain 1 through %d bytes", maxRootBytes)
	}
	metadataURL, err := normalizeRemoteURL(cfg.RemoteMetadataURL)
	if err != nil {
		return Config{}, fmt.Errorf("remote TUF metadata URL: %w", err)
	}
	targetsURL, err := normalizeRemoteURL(cfg.RemoteTargetsURL)
	if err != nil {
		return Config{}, fmt.Errorf("remote TUF targets URL: %w", err)
	}
	metadataDir, err := filepath.Abs(strings.TrimSpace(cfg.LocalMetadataDir))
	if err != nil || strings.TrimSpace(cfg.LocalMetadataDir) == "" {
		return Config{}, fmt.Errorf("local TUF metadata directory must be a valid path")
	}
	timeout := cfg.HTTPTimeout
	if timeout <= 0 {
		timeout = defaultHTTPTimeout
	}
	if timeout > 5*time.Minute {
		return Config{}, fmt.Errorf("TUF HTTP timeout must not exceed five minutes")
	}
	return Config{
		HTTPTimeout:       timeout,
		LocalMetadataDir:  metadataDir,
		RemoteMetadataURL: metadataURL,
		RemoteTargetsURL:  targetsURL,
		TrustedRoot:       append([]byte(nil), cfg.TrustedRoot...),
	}, nil
}

func normalizeRemoteURL(raw string) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || !parsed.IsAbs() || parsed.Hostname() == "" {
		return "", fmt.Errorf("URL must be absolute")
	}
	if parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", fmt.Errorf("URL must not contain credentials, a query, or a fragment")
	}
	if parsed.Scheme != "https" && !(parsed.Scheme == "http" && isLoopbackHost(parsed.Hostname())) {
		return "", fmt.Errorf("URL must use HTTPS or loopback HTTP")
	}
	return strings.TrimRight(parsed.String(), "/"), nil
}

func isLoopbackHost(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	return net.ParseIP(host).IsLoopback()
}

func normalizeTargetName(raw string) (string, error) {
	normalized := strings.ReplaceAll(strings.TrimSpace(raw), "\\", "/")
	if normalized == "" || strings.HasPrefix(normalized, "/") {
		return "", fmt.Errorf("TUF target name must be relative")
	}
	cleaned := path.Clean(normalized)
	if cleaned == "." || cleaned == ".." || strings.HasPrefix(cleaned, "../") {
		return "", fmt.Errorf("TUF target name escapes its repository")
	}
	return cleaned, nil
}

func normalizeDestination(raw string) (string, error) {
	if strings.TrimSpace(raw) == "" {
		return "", fmt.Errorf("helper target destination is required")
	}
	absolute, err := filepath.Abs(raw)
	if err != nil {
		return "", fmt.Errorf("resolve helper target destination: %w", err)
	}
	if filepath.Base(absolute) == "." || filepath.Base(absolute) == string(filepath.Separator) {
		return "", fmt.Errorf("helper target destination must name a file")
	}
	return absolute, nil
}

func syncFile(filePath string) error {
	file, err := os.OpenFile(filePath, os.O_RDWR, 0)
	if err != nil {
		return fmt.Errorf("open helper target for synchronization: %w", err)
	}
	defer file.Close()
	if err := file.Sync(); err != nil {
		return fmt.Errorf("synchronize helper target: %w", err)
	}
	return nil
}

func buildResult(targetName string, destination string, data []byte, cached bool) InstallResult {
	digest := sha256.Sum256(data)
	return InstallResult{
		ByteLength: int64(len(data)),
		Cached:     cached,
		Path:       destination,
		SHA256:     hex.EncodeToString(digest[:]),
		Target:     targetName,
	}
}
