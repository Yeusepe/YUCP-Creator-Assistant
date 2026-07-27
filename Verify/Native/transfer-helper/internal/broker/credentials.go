package broker

import (
	"context"
	"crypto/ecdsa"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"sync"
	"time"

	"github.com/yucp/transfer-helper/internal/deviceidentity"
)

const accessTokenRefreshMargin = 30 * time.Second

type OAuthFlow interface {
	Authorize(
		ctx context.Context,
		privateKey *ecdsa.PrivateKey,
		deviceThumbprint string,
	) (OAuthTokens, error)
	Refresh(
		ctx context.Context,
		privateKey *ecdsa.PrivateKey,
		refreshToken string,
	) (OAuthTokens, error)
}

type ManagedCredentials struct {
	OAuth          OAuthFlow
	OAuthForClient func(ClientIdentity) OAuthFlow
	StateRoot      string
	Store          *TokenStore
	Now            func() time.Time

	mu sync.Mutex
}

func (credentials *ManagedCredentials) Access(
	ctx context.Context,
	clientIdentity ClientIdentity,
	forceRefresh bool,
	report ProgressReporter,
) (OAuthTokens, deviceidentity.Identity, error) {
	if credentials == nil ||
		credentials.Store == nil ||
		credentials.StateRoot == "" ||
		clientIdentity.UserSID == "" {
		return OAuthTokens{}, deviceidentity.Identity{}, fmt.Errorf(
			"package broker credentials are not configured",
		)
	}
	oauth := credentials.OAuth
	if credentials.OAuthForClient != nil {
		oauth = credentials.OAuthForClient(clientIdentity)
	}
	if oauth == nil {
		return OAuthTokens{}, deviceidentity.Identity{}, fmt.Errorf(
			"package broker OAuth flow is not configured",
		)
	}
	credentials.mu.Lock()
	defer credentials.mu.Unlock()
	identity, err := deviceidentity.LoadOrCreate(credentials.StateRoot)
	if err != nil {
		return OAuthTokens{}, deviceidentity.Identity{}, err
	}
	now := time.Now()
	if credentials.Now != nil {
		now = credentials.Now()
	}
	stored, found, err := credentials.Store.Load(clientIdentity.UserSID)
	if err != nil {
		return OAuthTokens{}, deviceidentity.Identity{}, err
	}
	if found && !forceRefresh && now.Add(accessTokenRefreshMargin).Before(stored.ExpiresAt) {
		return stored, identity, nil
	}
	if found && stored.RefreshToken != "" {
		refreshed, refreshErr := oauth.Refresh(
			ctx,
			identity.PrivateKey,
			stored.RefreshToken,
		)
		if refreshErr == nil {
			if err := credentials.Store.Save(clientIdentity.UserSID, refreshed); err != nil {
				return OAuthTokens{}, deviceidentity.Identity{}, err
			}
			return refreshed, identity, nil
		}
		if err := credentials.Store.Clear(clientIdentity.UserSID); err != nil {
			return OAuthTokens{}, deviceidentity.Identity{}, err
		}
	}
	if err := report("signing-in", 0, 0); err != nil {
		return OAuthTokens{}, deviceidentity.Identity{}, err
	}
	thumbprint, err := hex.DecodeString(identity.Thumbprint)
	if err != nil || len(thumbprint) != 32 {
		return OAuthTokens{}, deviceidentity.Identity{}, fmt.Errorf(
			"package broker device thumbprint is invalid",
		)
	}
	authorized, err := oauth.Authorize(
		ctx,
		identity.PrivateKey,
		base64.RawURLEncoding.EncodeToString(thumbprint),
	)
	if err != nil {
		return OAuthTokens{}, deviceidentity.Identity{}, err
	}
	if err := credentials.Store.Save(clientIdentity.UserSID, authorized); err != nil {
		return OAuthTokens{}, deviceidentity.Identity{}, err
	}
	return authorized, identity, nil
}
