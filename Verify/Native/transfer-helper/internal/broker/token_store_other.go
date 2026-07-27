//go:build !windows

package broker

import "fmt"

type TokenStore struct{}

func NewTokenStore(_ string) (*TokenStore, error) {
	return nil, fmt.Errorf("package broker token storage is supported on Windows only")
}

func (store *TokenStore) Save(_ string, _ OAuthTokens) error {
	return fmt.Errorf("package broker token storage is supported on Windows only")
}

func (store *TokenStore) Load(_ string) (OAuthTokens, bool, error) {
	return OAuthTokens{}, false, fmt.Errorf(
		"package broker token storage is supported on Windows only",
	)
}

func (store *TokenStore) Clear(_ string) error {
	return fmt.Errorf("package broker token storage is supported on Windows only")
}
