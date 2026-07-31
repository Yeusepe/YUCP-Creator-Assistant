//go:build windows

package broker

import (
	"context"
	"crypto/ecdsa"
	"errors"
	"sync"
	"testing"
	"time"
)

type controlledOAuthFlow struct {
	authorizeStarted chan struct{}
	refreshErr       error
	releaseAuthorize chan struct{}
	revoked          chan string
	startOnce        sync.Once
	tokens           OAuthTokens
}

func (flow *controlledOAuthFlow) Authorize(
	ctx context.Context,
	_ *ecdsa.PrivateKey,
	_ string,
) (OAuthTokens, error) {
	flow.startOnce.Do(func() {
		close(flow.authorizeStarted)
	})
	select {
	case <-ctx.Done():
		return OAuthTokens{}, ctx.Err()
	case <-flow.releaseAuthorize:
		return flow.tokens, nil
	}
}

func (flow *controlledOAuthFlow) Refresh(
	_ context.Context,
	_ *ecdsa.PrivateKey,
	_ string,
) (OAuthTokens, error) {
	if flow.refreshErr != nil {
		return OAuthTokens{}, flow.refreshErr
	}
	return OAuthTokens{}, errors.New("refresh was not expected")
}

func (flow *controlledOAuthFlow) Revoke(
	_ context.Context,
	_ *ecdsa.PrivateKey,
	refreshToken string,
) error {
	flow.revoked <- refreshToken
	return nil
}

func TestManagedCredentialsStatusReusesWindowsProtectedSessionWithoutBrowser(
	t *testing.T,
) {
	const userSID = "S-1-5-21-saved"
	flow := newControlledOAuthFlow("saved")
	credentials := newTestManagedCredentials(t, map[string]OAuthFlow{
		userSID: flow,
	})
	if err := credentials.Store.Save(userSID, flow.tokens); err != nil {
		t.Fatalf("Save() error = %v", err)
	}

	signedIn, err := credentials.Status(
		context.Background(),
		ClientIdentity{UserSID: userSID},
	)
	if err != nil {
		t.Fatalf("Status() error = %v", err)
	}
	if !signedIn {
		t.Fatal("Status() = signed out, want saved session")
	}
	select {
	case <-flow.authorizeStarted:
		t.Fatal("Status() opened browser authorization for a saved session")
	default:
	}
}

func TestManagedCredentialsStatusReportsSessionRevokedAtTheIssuer(t *testing.T) {
	const userSID = "S-1-5-21-revoked"
	flow := newControlledOAuthFlow("revoked")
	flow.refreshErr = OAuthResponseError{StatusCode: 400}
	credentials := newTestManagedCredentials(t, map[string]OAuthFlow{
		userSID: flow,
	})
	if err := credentials.Store.Save(userSID, flow.tokens); err != nil {
		t.Fatalf("Save() error = %v", err)
	}

	signedIn, err := credentials.Status(
		context.Background(),
		ClientIdentity{UserSID: userSID},
	)
	if err != nil {
		t.Fatalf("Status() error = %v", err)
	}
	if signedIn {
		t.Fatal("Status() = signed in for a session the issuer refused")
	}
}

func TestManagedCredentialsStatusKeepsSessionWhenTheIssuerIsUnreachable(
	t *testing.T,
) {
	const userSID = "S-1-5-21-offline"
	flow := newControlledOAuthFlow("offline")
	flow.refreshErr = errors.New("dial tcp: no such host")
	credentials := newTestManagedCredentials(t, map[string]OAuthFlow{
		userSID: flow,
	})
	if err := credentials.Store.Save(userSID, flow.tokens); err != nil {
		t.Fatalf("Save() error = %v", err)
	}

	signedIn, err := credentials.Status(
		context.Background(),
		ClientIdentity{UserSID: userSID},
	)
	if err != nil {
		t.Fatalf("Status() error = %v", err)
	}
	if !signedIn {
		t.Fatal("Status() = signed out because the issuer could not be reached")
	}
}

func TestManagedCredentialsSignOutRevokesAndClearsWindowsProtectedSession(
	t *testing.T,
) {
	const userSID = "S-1-5-21-sign-out"
	flow := newControlledOAuthFlow("sign-out")
	credentials := newTestManagedCredentials(t, map[string]OAuthFlow{
		userSID: flow,
	})
	if err := credentials.Store.Save(userSID, flow.tokens); err != nil {
		t.Fatalf("Save() error = %v", err)
	}

	if err := credentials.SignOut(
		context.Background(),
		ClientIdentity{UserSID: userSID},
	); err != nil {
		t.Fatalf("SignOut() error = %v", err)
	}
	select {
	case revoked := <-flow.revoked:
		if revoked != flow.tokens.RefreshToken {
			t.Fatalf("Revoke() token = %q", revoked)
		}
	default:
		t.Fatal("SignOut() did not revoke the refresh token")
	}
	if _, found, err := credentials.Store.Load(userSID); err != nil || found {
		t.Fatalf("Load() after SignOut() found = %t, error = %v", found, err)
	}
}

func TestManagedCredentialsRefreshFailureDoesNotOpenBrowser(t *testing.T) {
	const userSID = "S-1-5-21-refresh-failure"
	flow := newControlledOAuthFlow("refresh-failure")
	credentials := newTestManagedCredentials(t, map[string]OAuthFlow{
		userSID: flow,
	})
	if err := credentials.Store.Save(userSID, flow.tokens); err != nil {
		t.Fatalf("Save() error = %v", err)
	}

	_, _, err := credentials.Access(
		context.Background(),
		ClientIdentity{UserSID: userSID},
		CredentialAccessRefresh,
		discardCredentialProgress,
	)
	if !errors.Is(err, ErrAuthenticationRequired) {
		t.Fatalf("Access() error = %v, want ErrAuthenticationRequired", err)
	}
	select {
	case <-flow.authorizeStarted:
		t.Fatal("noninteractive refresh opened browser authorization")
	default:
	}
}

func TestManagedCredentialsDoNotBlockAnotherUserDuringAuthorization(t *testing.T) {
	firstFlow := newControlledOAuthFlow("first")
	secondFlow := newControlledOAuthFlow("second")
	close(secondFlow.releaseAuthorize)
	credentials := newTestManagedCredentials(t, map[string]OAuthFlow{
		"S-1-5-21-first":  firstFlow,
		"S-1-5-21-second": secondFlow,
	})
	firstDone := make(chan error, 1)
	go func() {
		_, _, err := credentials.Access(
			context.Background(),
			ClientIdentity{UserSID: "S-1-5-21-first"},
			CredentialAccessInteractive,
			discardCredentialProgress,
		)
		firstDone <- err
	}()
	<-firstFlow.authorizeStarted

	secondDone := make(chan error, 1)
	go func() {
		_, _, err := credentials.Access(
			context.Background(),
			ClientIdentity{UserSID: "S-1-5-21-second"},
			CredentialAccessInteractive,
			discardCredentialProgress,
		)
		secondDone <- err
	}()
	select {
	case err := <-secondDone:
		if err != nil {
			t.Fatalf("second user Access() error = %v", err)
		}
	case <-time.After(500 * time.Millisecond):
		close(firstFlow.releaseAuthorize)
		<-firstDone
		t.Fatal("second user waited for another user's authorization")
	}
	close(firstFlow.releaseAuthorize)
	if err := <-firstDone; err != nil {
		t.Fatalf("first user Access() error = %v", err)
	}
}

func TestManagedCredentialsObserveCancellationWhileWaitingForTheSameUser(
	t *testing.T,
) {
	flow := newControlledOAuthFlow("same")
	credentials := newTestManagedCredentials(t, map[string]OAuthFlow{
		"S-1-5-21-same": flow,
	})
	firstDone := make(chan error, 1)
	go func() {
		_, _, err := credentials.Access(
			context.Background(),
			ClientIdentity{UserSID: "S-1-5-21-same"},
			CredentialAccessInteractive,
			discardCredentialProgress,
		)
		firstDone <- err
	}()
	<-flow.authorizeStarted

	waitContext, cancel := context.WithCancel(context.Background())
	cancel()
	waiterDone := make(chan error, 1)
	go func() {
		_, _, err := credentials.Access(
			waitContext,
			ClientIdentity{UserSID: "S-1-5-21-same"},
			CredentialAccessInteractive,
			discardCredentialProgress,
		)
		waiterDone <- err
	}()
	select {
	case err := <-waiterDone:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("waiting Access() error = %v, want context.Canceled", err)
		}
	case <-time.After(500 * time.Millisecond):
		close(flow.releaseAuthorize)
		<-firstDone
		t.Fatal("waiting Access() did not observe context cancellation")
	}
	close(flow.releaseAuthorize)
	if err := <-firstDone; err != nil {
		t.Fatalf("first Access() error = %v", err)
	}
}

func newControlledOAuthFlow(label string) *controlledOAuthFlow {
	return &controlledOAuthFlow{
		authorizeStarted: make(chan struct{}),
		releaseAuthorize: make(chan struct{}),
		revoked:          make(chan string, 1),
		tokens: OAuthTokens{
			AccessToken:  label + "-access",
			ExpiresAt:    time.Now().Add(5 * time.Minute),
			RefreshToken: label + "-refresh",
			Scope:        "package:operate offline_access",
			TokenType:    "DPoP",
		},
	}
}

func newTestManagedCredentials(
	t *testing.T,
	flows map[string]OAuthFlow,
) *ManagedCredentials {
	t.Helper()
	store, err := NewTokenStore(t.TempDir())
	if err != nil {
		t.Fatalf("NewTokenStore() error = %v", err)
	}
	return &ManagedCredentials{
		OAuthForClient: func(identity ClientIdentity) OAuthFlow {
			return flows[identity.UserSID]
		},
		StateRoot: t.TempDir(),
		Store:     store,
	}
}

func discardCredentialProgress(string, int64, int64, int64, int64) error {
	return nil
}
