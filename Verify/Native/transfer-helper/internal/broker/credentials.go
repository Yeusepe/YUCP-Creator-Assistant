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

	deviceMu  sync.Mutex
	userLocks credentialUserLocks
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
	releaseUser, err := credentials.userLocks.acquire(ctx, clientIdentity.UserSID)
	if err != nil {
		return OAuthTokens{}, deviceidentity.Identity{}, err
	}
	defer releaseUser()
	credentials.deviceMu.Lock()
	identity, err := deviceidentity.LoadOrCreate(credentials.StateRoot)
	credentials.deviceMu.Unlock()
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

type credentialUserLocks struct {
	mu      sync.Mutex
	entries map[string]*credentialUserLock
}

type credentialUserLock struct {
	gate       chan struct{}
	references int
}

func (locks *credentialUserLocks) acquire(
	ctx context.Context,
	userSID string,
) (func(), error) {
	locks.mu.Lock()
	if locks.entries == nil {
		locks.entries = make(map[string]*credentialUserLock)
	}
	entry := locks.entries[userSID]
	if entry == nil {
		entry = &credentialUserLock{gate: make(chan struct{}, 1)}
		entry.gate <- struct{}{}
		locks.entries[userSID] = entry
	}
	entry.references++
	locks.mu.Unlock()

	select {
	case <-ctx.Done():
		locks.releaseReference(userSID, entry)
		return nil, ctx.Err()
	case <-entry.gate:
		if err := ctx.Err(); err != nil {
			entry.gate <- struct{}{}
			locks.releaseReference(userSID, entry)
			return nil, err
		}
		return func() {
			entry.gate <- struct{}{}
			locks.releaseReference(userSID, entry)
		}, nil
	}
}

func (locks *credentialUserLocks) releaseReference(
	userSID string,
	entry *credentialUserLock,
) {
	locks.mu.Lock()
	defer locks.mu.Unlock()
	entry.references--
	if entry.references == 0 && locks.entries[userSID] == entry {
		delete(locks.entries, userSID)
	}
}
