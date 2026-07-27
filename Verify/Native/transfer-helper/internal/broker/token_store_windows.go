//go:build windows

package broker

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/yucp/transfer-helper/internal/securedata"
	"golang.org/x/sys/windows"
)

const tokenProtectionPurpose = "package-broker-oauth-tokens-v1"

type TokenStore struct {
	root string
}

type protectedTokenEnvelope struct {
	Tokens  OAuthTokens `json:"tokens"`
	UserSID string      `json:"userSid"`
}

func NewTokenStore(stateRoot string) (*TokenStore, error) {
	if !filepath.IsAbs(stateRoot) {
		return nil, fmt.Errorf("package broker state root must be absolute")
	}
	root, err := filepath.Abs(stateRoot)
	if err != nil {
		return nil, fmt.Errorf("resolve package broker state root: %w", err)
	}
	tokenRoot := filepath.Join(root, "credentials")
	if err := os.MkdirAll(tokenRoot, 0o700); err != nil {
		return nil, fmt.Errorf("create package broker credential directory: %w", err)
	}
	return &TokenStore{root: tokenRoot}, nil
}

func (store *TokenStore) Save(userSID string, tokens OAuthTokens) error {
	if store == nil || strings.TrimSpace(userSID) == "" {
		return fmt.Errorf("package broker token owner is invalid")
	}
	if err := validateOAuthTokens(tokens); err != nil {
		return err
	}
	plaintext, err := json.Marshal(protectedTokenEnvelope{
		Tokens:  tokens,
		UserSID: userSID,
	})
	if err != nil {
		return fmt.Errorf("encode package broker tokens: %w", err)
	}
	protected, err := securedata.Protect(plaintext, tokenProtectionPurpose)
	if err != nil {
		return fmt.Errorf("protect package broker tokens: %w", err)
	}
	temporary, err := os.CreateTemp(store.root, ".oauth-tokens-*.partial")
	if err != nil {
		return fmt.Errorf("create package broker token temporary file: %w", err)
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o600); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("restrict package broker token file: %w", err)
	}
	if _, err := temporary.Write(protected); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("write package broker token file: %w", err)
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("synchronize package broker token file: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("close package broker token file: %w", err)
	}
	from, err := windows.UTF16PtrFromString(temporaryPath)
	if err != nil {
		return fmt.Errorf("encode package broker temporary path: %w", err)
	}
	to, err := windows.UTF16PtrFromString(store.pathForUser(userSID))
	if err != nil {
		return fmt.Errorf("encode package broker token path: %w", err)
	}
	if err := windows.MoveFileEx(
		from,
		to,
		windows.MOVEFILE_REPLACE_EXISTING|windows.MOVEFILE_WRITE_THROUGH,
	); err != nil {
		return fmt.Errorf("publish package broker token file: %w", err)
	}
	return nil
}

func (store *TokenStore) Load(userSID string) (OAuthTokens, bool, error) {
	if store == nil || strings.TrimSpace(userSID) == "" {
		return OAuthTokens{}, false, fmt.Errorf("package broker token owner is invalid")
	}
	protected, err := os.ReadFile(store.pathForUser(userSID))
	if errors.Is(err, os.ErrNotExist) {
		return OAuthTokens{}, false, nil
	}
	if err != nil {
		return OAuthTokens{}, false, fmt.Errorf("read package broker token file: %w", err)
	}
	if len(protected) == 0 || len(protected) > 128*1024 {
		return OAuthTokens{}, false, fmt.Errorf("package broker token file size is invalid")
	}
	plaintext, err := securedata.Unprotect(protected, tokenProtectionPurpose)
	if err != nil {
		return OAuthTokens{}, false, fmt.Errorf("unprotect package broker tokens: %w", err)
	}
	var envelope protectedTokenEnvelope
	if err := json.Unmarshal(plaintext, &envelope); err != nil ||
		envelope.UserSID != userSID ||
		validateOAuthTokens(envelope.Tokens) != nil {
		return OAuthTokens{}, false, fmt.Errorf("package broker token file is invalid")
	}
	return envelope.Tokens, true, nil
}

func (store *TokenStore) Clear(userSID string) error {
	if store == nil || strings.TrimSpace(userSID) == "" {
		return fmt.Errorf("package broker token owner is invalid")
	}
	err := os.Remove(store.pathForUser(userSID))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove package broker token file: %w", err)
	}
	return nil
}

func (store *TokenStore) pathForUser(userSID string) string {
	digest := sha256.Sum256([]byte(userSID))
	return filepath.Join(store.root, hex.EncodeToString(digest[:])+".protected")
}
