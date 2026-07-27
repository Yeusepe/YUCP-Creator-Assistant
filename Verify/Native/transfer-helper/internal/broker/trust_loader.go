package broker

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/yucp/transfer-helper/internal/trust"
	"github.com/yucp/transfer-helper/internal/tufclient"
)

const (
	maxTrustedRootBytes   = 512 * 1024
	maxTrustDocumentBytes = 64 * 1024
)

type TrustConfig struct {
	MetadataURL string
	RootPath    string
	StateRoot   string
	TargetsURL  string
	TrustTarget string
}

func LoadTrustDocument(config TrustConfig) (trust.Document, error) {
	if !filepath.IsAbs(config.RootPath) ||
		!filepath.IsAbs(config.StateRoot) ||
		filepath.Base(config.TrustTarget) != config.TrustTarget ||
		strings.ContainsAny(config.TrustTarget, `/\`) ||
		strings.TrimSpace(config.MetadataURL) == "" ||
		strings.TrimSpace(config.TargetsURL) == "" {
		return trust.Document{}, fmt.Errorf("package broker trust configuration is invalid")
	}
	rootBytes, err := readBoundedTrustFile(config.RootPath, maxTrustedRootBytes)
	if err != nil {
		return trust.Document{}, fmt.Errorf("read pinned package broker TUF root: %w", err)
	}
	targetPath := filepath.Join(
		config.StateRoot,
		"tuf",
		"targets",
		config.TrustTarget,
	)
	if _, err := tufclient.InstallTarget(tufclient.Config{
		LocalMetadataDir:  filepath.Join(config.StateRoot, "tuf", "metadata"),
		RemoteMetadataURL: config.MetadataURL,
		RemoteTargetsURL:  config.TargetsURL,
		TrustedRoot:       rootBytes,
	}, config.TrustTarget, targetPath); err != nil {
		return trust.Document{}, fmt.Errorf("refresh package broker trust: %w", err)
	}
	targetBytes, err := readBoundedTrustFile(targetPath, maxTrustDocumentBytes)
	if err != nil {
		return trust.Document{}, fmt.Errorf("read package broker trust target: %w", err)
	}
	return trust.Parse(targetBytes)
}

func readBoundedTrustFile(path string, maxBytes int64) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, maxBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > maxBytes {
		return nil, fmt.Errorf("file exceeds %d bytes", maxBytes)
	}
	return data, nil
}
