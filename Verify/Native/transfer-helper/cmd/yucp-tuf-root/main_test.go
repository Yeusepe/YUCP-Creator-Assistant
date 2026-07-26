package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/yucp/transfer-helper/internal/tufroot"
)

func TestRunCompletesAnOfflineTwoOfThreeRootCeremony(t *testing.T) {
	now := time.Date(2026, 7, 25, 0, 0, 0, 0, time.UTC)
	rootSeeds := [][]byte{
		ceremonySeed("root-1"),
		ceremonySeed("root-2"),
		ceremonySeed("root-3"),
	}
	root := t.TempDir()
	manifestPath := filepath.Join(root, "manifest.json")
	unsignedPath := filepath.Join(root, "1.root.unsigned.json")
	oncePath := filepath.Join(root, "1.root.signed-1.json")
	completePath := filepath.Join(root, "1.root.json")
	manifest, err := json.Marshal(tufroot.Manifest{
		Expires:            now.Add(365 * 24 * time.Hour).Format(time.RFC3339),
		RootPublicKeys:     ceremonyPublicKeys(rootSeeds),
		RootThreshold:      2,
		SchemaVersion:      1,
		SnapshotPublicKey:  ceremonyPublicKey(ceremonySeed("snapshot")),
		TargetsPublicKey:   ceremonyPublicKey(ceremonySeed("targets")),
		TimestampPublicKey: ceremonyPublicKey(ceremonySeed("timestamp")),
		Version:            1,
	})
	if err != nil {
		t.Fatalf("marshal manifest: %v", err)
	}
	if err := os.WriteFile(manifestPath, manifest, 0o600); err != nil {
		t.Fatalf("write manifest: %v", err)
	}

	var output bytes.Buffer
	if err := run(
		[]string{"create", "--manifest", manifestPath, "--output", unsignedPath},
		func(string) string { return "" },
		&output,
		now,
	); err != nil {
		t.Fatalf("create run() error = %v", err)
	}
	output.Reset()
	if err := run(
		[]string{"sign", "--root", unsignedPath, "--output", oncePath},
		func(name string) string {
			if name == "YUCP_TUF_ROOT_PRIVATE_KEY" {
				return base64.RawURLEncoding.EncodeToString(rootSeeds[0])
			}
			return ""
		},
		&output,
		now,
	); err != nil {
		t.Fatalf("first sign run() error = %v", err)
	}
	if bytes.Contains(output.Bytes(), rootSeeds[0]) {
		t.Fatal("sign result exposed the root private key")
	}
	output.Reset()
	if err := run(
		[]string{"sign", "--root", oncePath, "--output", completePath},
		func(name string) string {
			if name == "YUCP_TUF_ROOT_PRIVATE_KEY" {
				return base64.RawURLEncoding.EncodeToString(rootSeeds[1])
			}
			return ""
		},
		&output,
		now,
	); err != nil {
		t.Fatalf("second sign run() error = %v", err)
	}
	output.Reset()
	if err := run(
		[]string{"verify", "--root", completePath},
		func(string) string { return "" },
		&output,
		now,
	); err != nil {
		t.Fatalf("verify run() error = %v", err)
	}
	var result commandResult
	if err := json.Unmarshal(output.Bytes(), &result); err != nil {
		t.Fatalf("decode command result: %v", err)
	}
	if !result.Complete || result.Operation != "verify" || result.RootVersion != 1 {
		t.Fatalf("verify result = %#v", result)
	}
}

func ceremonyPublicKeys(seeds [][]byte) []string {
	result := make([]string, 0, len(seeds))
	for _, seed := range seeds {
		result = append(result, ceremonyPublicKey(seed))
	}
	return result
}

func ceremonyPublicKey(seed []byte) string {
	key := ed25519.NewKeyFromSeed(seed).Public().(ed25519.PublicKey)
	return base64.RawURLEncoding.EncodeToString(key)
}

func ceremonySeed(name string) []byte {
	value := sha256.Sum256([]byte("YUCP TUF root CLI test key: " + name))
	return value[:]
}
