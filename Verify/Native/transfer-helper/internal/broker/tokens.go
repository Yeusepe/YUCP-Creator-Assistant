package broker

import (
	"fmt"
	"strings"
	"time"
)

type OAuthTokens struct {
	AccessToken  string    `json:"accessToken"`
	ExpiresAt    time.Time `json:"expiresAt"`
	RefreshToken string    `json:"refreshToken"`
	Scope        string    `json:"scope"`
	TokenType    string    `json:"tokenType"`
}

func validateOAuthTokens(tokens OAuthTokens) error {
	scopes := strings.Fields(tokens.Scope)
	hasOperationScope := false
	hasOfflineAccess := false
	for _, scope := range scopes {
		hasOperationScope = hasOperationScope || scope == "package:operate"
		hasOfflineAccess = hasOfflineAccess || scope == "offline_access"
	}
	if tokens.AccessToken == "" ||
		len(tokens.AccessToken) > 16*1024 ||
		tokens.RefreshToken == "" ||
		len(tokens.RefreshToken) > 16*1024 ||
		tokens.TokenType != "DPoP" ||
		!hasOperationScope ||
		!hasOfflineAccess ||
		tokens.ExpiresAt.IsZero() {
		return fmt.Errorf("package broker OAuth token response is invalid")
	}
	return nil
}
