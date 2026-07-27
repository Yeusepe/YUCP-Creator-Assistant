package main

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/theupdateframework/go-tuf/v2/metadata"
)

func TestBuildRejectsADevelopmentRootWithoutProductionThresholdPolicy(t *testing.T) {
	root := t.TempDir()
	targetPath := filepath.Join(root, "helper.exe")
	manifestPath := filepath.Join(root, "targets.json")
	if err := os.WriteFile(targetPath, []byte("helper"), 0o600); err != nil {
		t.Fatalf("write target: %v", err)
	}
	manifest, err := json.Marshal(targetManifest{
		SchemaVersion: 1,
		Targets: []manifestTarget{{
			Name: "helper/windows-amd64/yucp-transfer-helper.exe",
			Path: targetPath,
		}},
	})
	if err != nil {
		t.Fatalf("marshal manifest: %v", err)
	}
	if err := os.WriteFile(manifestPath, manifest, 0o600); err != nil {
		t.Fatalf("write manifest: %v", err)
	}
	for _, role := range []string{metadata.TARGETS, metadata.SNAPSHOT, metadata.TIMESTAMP} {
		seed := sha256.Sum256([]byte("YUCP transfer-helper TUF test key: " + role))
		t.Setenv(
			map[string]string{
				metadata.TARGETS:   "YUCP_TUF_TARGETS_PRIVATE_KEY",
				metadata.SNAPSHOT:  "YUCP_TUF_SNAPSHOT_PRIVATE_KEY",
				metadata.TIMESTAMP: "YUCP_TUF_TIMESTAMP_PRIVATE_KEY",
			}[role],
			base64.RawURLEncoding.EncodeToString(seed[:]),
		)
	}
	now := time.Date(2026, 7, 25, 0, 0, 0, 0, time.UTC)
	developmentRoot, err := filepath.Abs(
		filepath.Join("..", "..", "internal", "tufclient", "testdata", "1.root.json"),
	)
	if err != nil {
		t.Fatalf("resolve development root: %v", err)
	}
	_, err = build(buildInput{
		ManifestPath:     manifestPath,
		MetadataVersion:  1,
		Now:              now,
		Output:           filepath.Join(root, "repository"),
		RootPath:         developmentRoot,
		SnapshotExpires:  now.Add(7 * 24 * time.Hour).Format(time.RFC3339),
		TargetsExpires:   now.Add(30 * 24 * time.Hour).Format(time.RFC3339),
		TimestampExpires: now.Add(24 * time.Hour).Format(time.RFC3339),
	})
	if err == nil || !strings.Contains(err.Error(), "threshold policy") {
		t.Fatalf("build() error = %v, want production root threshold policy failure", err)
	}
}
