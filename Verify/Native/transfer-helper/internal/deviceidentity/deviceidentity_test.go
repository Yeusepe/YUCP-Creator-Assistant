package deviceidentity

import (
	"bytes"
	"encoding/hex"
	"os"
	"path/filepath"
	"testing"
)

func TestLoadOrCreateKeepsOneProtectedDeviceKey(t *testing.T) {
	stateRoot := t.TempDir()

	first, err := LoadOrCreate(stateRoot)
	if err != nil {
		t.Fatalf("LoadOrCreate() first call error = %v", err)
	}
	second, err := LoadOrCreate(stateRoot)
	if err != nil {
		t.Fatalf("LoadOrCreate() second call error = %v", err)
	}
	if first.Thumbprint != second.Thumbprint {
		t.Fatalf(
			"device thumbprint changed from %q to %q",
			first.Thumbprint,
			second.Thumbprint,
		)
	}
	if _, err := hex.DecodeString(first.Thumbprint); err != nil || len(first.Thumbprint) != 64 {
		t.Fatalf("device thumbprint = %q, want lowercase SHA-256", first.Thumbprint)
	}
	if first.PrivateKey == nil || second.PrivateKey == nil {
		t.Fatal("LoadOrCreate() returned no signing key")
	}

	stored, err := os.ReadFile(filepath.Join(stateRoot, deviceKeyFileName))
	if err != nil {
		t.Fatalf("read protected device key: %v", err)
	}
	privateScalar := first.PrivateKey.D.FillBytes(make([]byte, 32))
	if bytes.Contains(stored, privateScalar) {
		t.Fatal("device key file contains the plaintext private scalar")
	}
}

func TestLoadOrCreateRejectsRelativeStateRoot(t *testing.T) {
	if _, err := LoadOrCreate("relative-state"); err == nil {
		t.Fatal("LoadOrCreate() accepted a relative state root")
	}
}
