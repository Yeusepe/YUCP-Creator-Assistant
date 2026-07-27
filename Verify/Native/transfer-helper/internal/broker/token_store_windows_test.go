//go:build windows

package broker

import (
	"bytes"
	"os"
	"testing"
	"time"
)

func TestTokenStorePersistsProtectedPerUserCredentials(t *testing.T) {
	store, err := NewTokenStore(t.TempDir())
	if err != nil {
		t.Fatalf("NewTokenStore() error = %v", err)
	}
	tokens := OAuthTokens{
		AccessToken:  "access-token-secret",
		ExpiresAt:    time.Unix(2_000, 0),
		RefreshToken: "refresh-token-secret",
		Scope:        "package:operate offline_access",
		TokenType:    "DPoP",
	}
	if err := store.Save("S-1-5-21-test-user", tokens); err != nil {
		t.Fatalf("Save() error = %v", err)
	}
	protected, err := os.ReadFile(store.pathForUser("S-1-5-21-test-user"))
	if err != nil {
		t.Fatalf("read protected token file: %v", err)
	}
	if bytes.Contains(protected, []byte(tokens.AccessToken)) ||
		bytes.Contains(protected, []byte(tokens.RefreshToken)) {
		t.Fatal("protected token file contains plaintext credentials")
	}
	loaded, found, err := store.Load("S-1-5-21-test-user")
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if !found ||
		loaded.AccessToken != tokens.AccessToken ||
		!loaded.ExpiresAt.Equal(tokens.ExpiresAt) ||
		loaded.RefreshToken != tokens.RefreshToken ||
		loaded.Scope != tokens.Scope ||
		loaded.TokenType != tokens.TokenType {
		t.Fatalf("Load() = %#v, %t, want %#v", loaded, found, tokens)
	}
	if _, found, err := store.Load("S-1-5-21-other-user"); err != nil || found {
		t.Fatalf("Load(other user) found = %t, error = %v", found, err)
	}
	if err := store.Clear("S-1-5-21-test-user"); err != nil {
		t.Fatalf("Clear() error = %v", err)
	}
	if _, found, err := store.Load("S-1-5-21-test-user"); err != nil || found {
		t.Fatalf("Load(cleared user) found = %t, error = %v", found, err)
	}
}
