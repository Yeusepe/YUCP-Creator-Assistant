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
	releaseAuthorize chan struct{}
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

func (*controlledOAuthFlow) Refresh(
	_ context.Context,
	_ *ecdsa.PrivateKey,
	_ string,
) (OAuthTokens, error) {
	return OAuthTokens{}, errors.New("refresh was not expected")
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
			false,
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
			false,
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
			false,
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
			false,
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

func discardCredentialProgress(string, int64, int64) error {
	return nil
}
