package broker

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/yucp/transfer-helper/internal/deviceidentity"
	"github.com/yucp/transfer-helper/internal/lifecycle"
	"github.com/yucp/transfer-helper/internal/trust"
)

type credentialProviderFunc func(
	context.Context,
	ClientIdentity,
	bool,
	ProgressReporter,
) (OAuthTokens, deviceidentity.Identity, error)

func (provider credentialProviderFunc) Access(
	ctx context.Context,
	identity ClientIdentity,
	forceRefresh bool,
	report ProgressReporter,
) (OAuthTokens, deviceidentity.Identity, error) {
	return provider(ctx, identity, forceRefresh, report)
}

type authenticationCredentialProvider struct {
	forceRefresh bool
}

func (provider *authenticationCredentialProvider) Access(
	_ context.Context,
	_ ClientIdentity,
	forceRefresh bool,
	_ ProgressReporter,
) (OAuthTokens, deviceidentity.Identity, error) {
	provider.forceRefresh = forceRefresh
	return OAuthTokens{}, deviceidentity.Identity{}, nil
}

func (*authenticationCredentialProvider) Status(
	context.Context,
	ClientIdentity,
) (bool, error) {
	return true, nil
}

func (*authenticationCredentialProvider) SignOut(
	context.Context,
	ClientIdentity,
) error {
	return nil
}

type remoteExchangeFunc func(
	context.Context,
	OperationRequest,
	OAuthTokens,
	*ecdsa.PrivateKey,
) (AuthorizedOperation, error)

func (exchange remoteExchangeFunc) AuthorizeAndExchange(
	ctx context.Context,
	request OperationRequest,
	tokens OAuthTokens,
	key *ecdsa.PrivateKey,
) (AuthorizedOperation, error) {
	return exchange(ctx, request, tokens, key)
}

func (remoteExchangeFunc) Renew(
	context.Context,
	AuthorizationRenewal,
	OAuthTokens,
	*ecdsa.PrivateKey,
) (AuthorizedOperation, error) {
	return AuthorizedOperation{}, errors.New("unexpected package authorization renewal")
}

type lifecycleExecutorFunc func(
	context.Context,
	lifecycle.AuthorizedRequest,
	deviceidentity.Identity,
	trust.Document,
	lifecycle.ProgressReporter,
) (lifecycle.Result, error)

func (executor lifecycleExecutorFunc) Execute(
	ctx context.Context,
	request lifecycle.AuthorizedRequest,
	identity deviceidentity.Identity,
	document trust.Document,
	report lifecycle.ProgressReporter,
) (lifecycle.Result, error) {
	return executor(ctx, request, identity, document, report)
}

func TestAuthenticationSignInReusesSavedCredentialsBeforeOpeningBrowser(
	t *testing.T,
) {
	credentials := &authenticationCredentialProvider{}
	runtime := Runtime{Credentials: credentials}

	result, err := runtime.HandleAuthentication(
		context.Background(),
		ClientIdentity{UserSID: "S-1-5-21-saved"},
		"sign-in",
	)
	if err != nil {
		t.Fatalf("HandleAuthentication() error = %v", err)
	}
	if !result.SignedIn {
		t.Fatal("HandleAuthentication() = signed out, want saved session")
	}
	if credentials.forceRefresh {
		t.Fatal("sign-in forced a refresh instead of reusing saved credentials")
	}
}

func TestRuntimeOpensVerificationAndRetriesWithoutExposingCapabilities(t *testing.T) {
	privateKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("GenerateKey() error = %v", err)
	}
	request := OperationRequest{
		AliasID:                    "jammr",
		ExpectedCurrentReleaseRoot: strings.Repeat("00", 32),
		IdempotencyKey:             "preflight-jammr-1",
		Operation:                  "preflight",
		ProjectIdentity:            strings.Repeat("22", 32),
		ProjectPath:                `C:\Unity\Project`,
		RunID:                      "run-jammr-preflight-1",
		SchemaVersion:              OperationRequestSchemaVersion,
		Traceparent:                "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
	}
	exchanges := 0
	opened := ""
	runtime := Runtime{
		Credentials: credentialProviderFunc(func(
			context.Context,
			ClientIdentity,
			bool,
			ProgressReporter,
		) (OAuthTokens, deviceidentity.Identity, error) {
			return OAuthTokens{
					AccessToken:  "access-token",
					RefreshToken: "refresh-token",
					Scope:        "package:operate offline_access",
					TokenType:    "DPoP",
				},
				deviceidentity.Identity{PrivateKey: privateKey, Thumbprint: strings.Repeat("44", 32)},
				nil
		}),
		Exchange: remoteExchangeFunc(func(
			context.Context,
			OperationRequest,
			OAuthTokens,
			*ecdsa.PrivateKey,
		) (AuthorizedOperation, error) {
			exchanges++
			if exchanges == 1 {
				return AuthorizedOperation{}, &VerificationRequiredError{
					URL: "https://app.example.test/access/product-1",
				}
			}
			return AuthorizedOperation{
				DeliveryGrant:  "signed-delivery-grant",
				InstallSession: "signed-install-session",
				ReleaseRoot:    strings.Repeat("11", 32),
				VersionID:      "version-jammr-1",
			}, nil
		}),
		Executor: lifecycleExecutorFunc(func(
			_ context.Context,
			_ lifecycle.AuthorizedRequest,
			_ deviceidentity.Identity,
			_ trust.Document,
			_ lifecycle.ProgressReporter,
		) (lifecycle.Result, error) {
			return lifecycle.Result{
				ActiveContentDigest: strings.Repeat("33", 32),
				ActivePolicyVersion: "policy-v1",
				Files:               []lifecycle.ResultFile{},
				Operation:           request.Operation,
				RunID:               request.RunID,
				SchemaVersion:       lifecycle.SchemaVersion,
				Status:              "succeeded",
				TargetReleaseRoot:   strings.Repeat("11", 32),
			}, nil
		}),
		LaunchURL: func(_ ClientIdentity, raw string) error {
			opened = raw
			return nil
		},
		StateRoot:                t.TempDir(),
		Results:                  mustResultStore(t),
		TrustDocument:            trust.Document{},
		VerificationPollInterval: 1,
	}
	var phases []string
	result, err := runtime.Handle(
		context.Background(),
		ClientIdentity{ProcessID: 42, UserSID: "S-1-5-21-test"},
		request,
		func(phase string, _ int64, _ int64) error {
			phases = append(phases, phase)
			return nil
		},
	)
	if err != nil {
		t.Fatalf("Handle() error = %v", err)
	}
	if result.Status != "succeeded" ||
		exchanges != 2 ||
		opened != "https://app.example.test/access/product-1" {
		t.Fatalf("result = %#v, exchanges = %d, opened = %q", result, exchanges, opened)
	}
	if !containsString(phases, "verifying-access") {
		t.Fatalf("progress phases = %#v", phases)
	}
}

func TestRuntimePersistsAndRedactsFailedTerminalResult(t *testing.T) {
	request := OperationRequest{
		AliasID:                    "jammr",
		ExpectedCurrentReleaseRoot: strings.Repeat("00", 32),
		IdempotencyKey:             "install-jammr-1",
		Operation:                  "preflight",
		ProjectIdentity:            strings.Repeat("22", 32),
		ProjectPath:                t.TempDir(),
		RunID:                      "run-jammr-failure-1",
		SchemaVersion:              OperationRequestSchemaVersion,
		Traceparent:                "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
	}
	const privateDetail = "private upstream response"
	accesses := 0
	runtime := Runtime{
		Credentials: credentialProviderFunc(func(
			context.Context,
			ClientIdentity,
			bool,
			ProgressReporter,
		) (OAuthTokens, deviceidentity.Identity, error) {
			accesses++
			return OAuthTokens{}, deviceidentity.Identity{}, errors.New(privateDetail)
		}),
		Exchange: remoteExchangeFunc(func(
			context.Context,
			OperationRequest,
			OAuthTokens,
			*ecdsa.PrivateKey,
		) (AuthorizedOperation, error) {
			t.Fatal("AuthorizeAndExchange() must not run")
			return AuthorizedOperation{}, nil
		}),
		Executor: lifecycleExecutorFunc(func(
			context.Context,
			lifecycle.AuthorizedRequest,
			deviceidentity.Identity,
			trust.Document,
			lifecycle.ProgressReporter,
		) (lifecycle.Result, error) {
			t.Fatal("Execute() must not run")
			return lifecycle.Result{}, nil
		}),
		LaunchURL: func(ClientIdentity, string) error {
			t.Fatal("LaunchURL() must not run")
			return nil
		},
		Results:   mustResultStore(t),
		StateRoot: t.TempDir(),
	}
	var first OperationResult
	for attempt := 0; attempt < 2; attempt++ {
		result, err := runtime.Handle(
			context.Background(),
			ClientIdentity{ProcessID: 42, UserSID: "S-1-5-21-test"},
			request,
			func(string, int64, int64) error { return nil },
		)
		if err != nil {
			t.Fatalf("Handle() attempt %d error = %v", attempt, err)
		}
		if attempt == 0 {
			first = result
		} else if !reflect.DeepEqual(result, first) {
			t.Fatalf("retry result = %#v, want %#v", result, first)
		}
	}
	if accesses != 1 ||
		first.ErrorCode != "PACKAGE_LIFECYCLE_FAILED" ||
		first.ErrorMessage == "" ||
		strings.Contains(first.ErrorMessage, privateDetail) ||
		first.Files == nil ||
		len(first.Files) != 0 ||
		first.TargetReleaseRoot != request.ExpectedCurrentReleaseRoot ||
		first.TraceID != request.Traceparent[3:35] {
		t.Fatalf("result = %#v, accesses = %d", first, accesses)
	}
}

func mustResultStore(t *testing.T) *ResultStore {
	t.Helper()
	store, err := NewResultStore(t.TempDir())
	if err != nil {
		t.Fatalf("NewResultStore() error = %v", err)
	}
	return store
}

func containsString(values []string, expected string) bool {
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}
