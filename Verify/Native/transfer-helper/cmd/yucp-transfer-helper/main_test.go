package main

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"

	"github.com/yucp/transfer-helper/internal/lifecycle"
	"github.com/yucp/transfer-helper/internal/packagecontract"
	"github.com/yucp/transfer-helper/internal/reconstructor"
)

func TestFailedLifecycleExecutionPreservesTerminalEnvelope(t *testing.T) {
	failure := lifecycle.Result{
		ErrorCode:     lifecycleErrorCode,
		ExitCode:      1,
		JournalState:  "failed-before-project-mutation",
		Operation:     "preflight",
		RunID:         "run-1",
		SchemaVersion: lifecycle.SchemaVersion,
		Status:        "failed",
		TraceID:       "run-1",
	}

	result := mergeLifecycleExecutionResult(
		failure,
		lifecycle.Result{},
		errors.New("delivery manifest timed out"),
	)

	if result.Status != "failed" ||
		result.ExitCode != 1 ||
		result.SchemaVersion != lifecycle.SchemaVersion ||
		result.RunID != "run-1" ||
		result.Operation != "preflight" ||
		result.ErrorCode != lifecycleErrorCode ||
		result.ErrorMessage != "delivery manifest timed out" {
		t.Fatalf("failed lifecycle result = %#v", result)
	}
}

func TestDeviceInfoCommandReturnsStableProtectedIdentity(t *testing.T) {
	stateRoot := filepath.Join(t.TempDir(), "state")
	first := captureCommandOutput(t, func() int {
		return run(context.Background(), []string{
			"device-info",
			"--state-root", stateRoot,
		})
	})
	second := captureCommandOutput(t, func() int {
		return run(context.Background(), []string{
			"device-info",
			"--state-root", stateRoot,
		})
	})
	if first.ExitCode != 0 || second.ExitCode != 0 {
		t.Fatalf("device-info exit codes = %d and %d, want 0", first.ExitCode, second.ExitCode)
	}
	var firstInfo struct {
		DeviceKeyThumbprint string `json:"deviceKeyThumbprint"`
		SchemaVersion       int    `json:"schemaVersion"`
	}
	if err := json.Unmarshal(first.Output, &firstInfo); err != nil {
		t.Fatalf("decode first device-info result: %v", err)
	}
	var secondInfo struct {
		DeviceKeyThumbprint string `json:"deviceKeyThumbprint"`
		SchemaVersion       int    `json:"schemaVersion"`
	}
	if err := json.Unmarshal(second.Output, &secondInfo); err != nil {
		t.Fatalf("decode second device-info result: %v", err)
	}
	if firstInfo.SchemaVersion != 1 ||
		len(firstInfo.DeviceKeyThumbprint) != 64 ||
		firstInfo.DeviceKeyThumbprint != secondInfo.DeviceKeyThumbprint {
		t.Fatalf("device-info results = %#v and %#v", firstInfo, secondInfo)
	}
}

func TestReconstructCommandPublishesVerifiedPackage(t *testing.T) {
	root := t.TempDir()
	chunk := []byte("complete command package\n")
	encodedDigest := sha256.Sum256(chunk)
	logicalDigest := mustCommandDomainHash(t, "yucp:chunk:v2", chunk)
	fileDigest := mustCommandDomainHash(t, "yucp:file:v2", chunk)
	cacheObjectID := hex.EncodeToString(encodedDigest[:])
	cacheObjectPath := filepath.Join(root, "cache", cacheObjectID[:4], cacheObjectID)
	if err := os.MkdirAll(filepath.Dir(cacheObjectPath), 0o700); err != nil {
		t.Fatalf("create command cache: %v", err)
	}
	if err := os.WriteFile(cacheObjectPath, chunk, 0o600); err != nil {
		t.Fatalf("write command cache object: %v", err)
	}

	payload := mustCommandCanonical(t, map[any]any{
		int64(0): int64(2),
		int64(1): make([]byte, 32),
		int64(2): []any{
			map[any]any{
				int64(0): "Assets/Product/command.txt",
				int64(1): int64(len(chunk)),
				int64(2): fileDigest[:],
				int64(3): int64(packagecontract.ClassificationCommon),
				int64(4): []any{
					map[any]any{
						int64(0): logicalDigest[:],
						int64(1): int64(len(chunk)),
						int64(2): int64(0),
						int64(3): int64(len(chunk)),
						int64(4): encodedDigest[:],
					},
				},
			},
		},
	})
	keyID := []byte("command-test-root")
	seed := make([]byte, ed25519.SeedSize)
	for index := range seed {
		seed[index] = byte(index)
	}
	privateKey := ed25519.NewKeyFromSeed(seed)
	publicKey := privateKey.Public().(ed25519.PublicKey)
	protected := mustCommandCanonical(t, map[any]any{
		int64(1):    int64(-8),
		int64(2):    []any{int64(1001)},
		int64(4):    keyID,
		int64(1001): packagecontract.FileTableShardPurpose,
	})
	signatureStructure := mustCommandCanonical(
		t,
		[]any{"Signature1", protected, []byte{}, payload},
	)
	signedShard := mustCommandCanonical(t, []any{
		protected,
		map[any]any{},
		payload,
		ed25519.Sign(privateKey, signatureStructure),
	})
	signedShardPath := filepath.Join(root, "file-table-shard.cose")
	if err := os.WriteFile(signedShardPath, signedShard, 0o600); err != nil {
		t.Fatalf("write signed command shard: %v", err)
	}

	destination := filepath.Join(root, "staging", "release")
	exitCode := run(context.Background(), []string{
		"reconstruct",
		"--signed-shard", signedShardPath,
		"--public-key", hex.EncodeToString(publicKey),
		"--key-id", string(keyID),
		"--chunk-cache", filepath.Join(root, "cache"),
		"--destination", destination,
		"--encoding-profile", reconstructor.DesyncUncompressedSHA256V1,
		"--trace-id", "command-test-trace",
	})
	if exitCode != 0 {
		t.Fatalf("run(reconstruct) exit code = %d, want 0", exitCode)
	}
	reconstructed, err := os.ReadFile(
		filepath.Join(destination, "Assets", "Product", "command.txt"),
	)
	if err != nil {
		t.Fatalf("read command reconstruction: %v", err)
	}
	if string(reconstructed) != string(chunk) {
		t.Fatalf("command reconstruction = %q, want %q", reconstructed, chunk)
	}
}

type capturedCommand struct {
	ExitCode int
	Output   []byte
}

func captureCommandOutput(t *testing.T, command func() int) capturedCommand {
	t.Helper()
	original := os.Stdout
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatalf("create command output pipe: %v", err)
	}
	os.Stdout = writer
	exitCode := command()
	if err := writer.Close(); err != nil {
		t.Fatalf("close command output writer: %v", err)
	}
	os.Stdout = original
	output, err := io.ReadAll(reader)
	if err != nil {
		t.Fatalf("read command output: %v", err)
	}
	if err := reader.Close(); err != nil {
		t.Fatalf("close command output reader: %v", err)
	}
	return capturedCommand{ExitCode: exitCode, Output: output}
}

func mustCommandDomainHash(t *testing.T, purpose string, value []byte) [32]byte {
	t.Helper()
	digest, err := packagecontract.DomainHash(purpose, value)
	if err != nil {
		t.Fatalf("DomainHash() error = %v", err)
	}
	return digest
}

func mustCommandCanonical(t *testing.T, value any) []byte {
	t.Helper()
	data, err := packagecontract.EncodeCanonical(value)
	if err != nil {
		t.Fatalf("EncodeCanonical() error = %v", err)
	}
	return data
}
