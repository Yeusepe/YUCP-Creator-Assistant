//go:build windows

package securedata

import (
	"bytes"
	"testing"
)

func TestProtectRoundTripIsPurposeSeparated(t *testing.T) {
	plaintext := []byte("refresh-token-value")
	protected, err := Protect(plaintext, "package-broker-oauth-tokens-v1")
	if err != nil {
		t.Fatalf("Protect() error = %v", err)
	}
	if bytes.Contains(protected, plaintext) {
		t.Fatal("Protect() left plaintext in the protected value")
	}
	decoded, err := Unprotect(protected, "package-broker-oauth-tokens-v1")
	if err != nil {
		t.Fatalf("Unprotect() error = %v", err)
	}
	if !bytes.Equal(decoded, plaintext) {
		t.Fatalf("Unprotect() = %q, want %q", decoded, plaintext)
	}
	if _, err := Unprotect(protected, "package-broker-device-key-v1"); err == nil {
		t.Fatal("Unprotect() accepted a different purpose")
	}
}
