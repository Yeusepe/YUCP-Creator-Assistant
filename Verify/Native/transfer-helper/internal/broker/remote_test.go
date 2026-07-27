package broker

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestRemoteClientKeepsServerCapabilitiesInsideBroker(t *testing.T) {
	privateKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("GenerateKey() error = %v", err)
	}
	request := OperationRequest{
		AliasID:                     "jammr",
		ApprovedActiveContentDigest: strings.Repeat("33", 32),
		ApprovedPolicyVersion:       "active-content-policy-v1",
		ExpectedCurrentReleaseRoot:  strings.Repeat("00", 32),
		IdempotencyKey:              "install-jammr-1",
		Operation:                   "install",
		ProjectIdentity:             strings.Repeat("22", 32),
		ProjectPath:                 `C:\Unity\Project`,
		RunID:                       "run-jammr-install-1",
		SchemaVersion:               OperationRequestSchemaVersion,
		Traceparent:                 "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
	}
	var authorizationBody map[string]any
	var sessionBody map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(
		writer http.ResponseWriter,
		httpRequest *http.Request,
	) {
		if !strings.HasPrefix(httpRequest.Header.Get("Authorization"), "DPoP ") ||
			httpRequest.Header.Get("DPoP") == "" {
			t.Error("broker request omitted DPoP authorization")
			writer.WriteHeader(http.StatusUnauthorized)
			return
		}
		writer.Header().Set("Content-Type", "application/json")
		switch httpRequest.URL.Path {
		case "/api/v2/package-installs/authorizations":
			if err := json.NewDecoder(httpRequest.Body).Decode(&authorizationBody); err != nil {
				t.Errorf("decode authorization body: %v", err)
				writer.WriteHeader(http.StatusBadRequest)
				return
			}
			writer.WriteHeader(http.StatusCreated)
			_, _ = writer.Write([]byte(`{
				"expiresAt":"2030-01-01T00:00:00Z",
				"operationCapability":"signed-operation-capability",
				"releaseRoot":"` + strings.Repeat("11", 32) + `"
			}`))
		case "/api/v2/package-installs/sessions":
			if err := json.NewDecoder(httpRequest.Body).Decode(&sessionBody); err != nil {
				t.Errorf("decode session body: %v", err)
				writer.WriteHeader(http.StatusBadRequest)
				return
			}
			_, _ = writer.Write([]byte(`{
				"deliveryGrant":"signed-delivery-grant",
				"deliveryGrantPurpose":"delivery-grant-v2",
				"installSession":"signed-install-session",
				"installSessionPurpose":"install-session-v2",
				"releaseRoot":"` + strings.Repeat("11", 32) + `",
				"versionId":"version-jammr-1"
			}`))
		default:
			http.NotFound(writer, httpRequest)
		}
	}))
	defer server.Close()

	client := RemoteClient{
		APIBaseURL: server.URL,
		HTTPClient: server.Client(),
		Now:        func() time.Time { return time.Unix(1_000, 0) },
	}
	authorized, err := client.AuthorizeAndExchange(
		context.Background(),
		request,
		OAuthTokens{
			AccessToken:  "access-token",
			ExpiresAt:    time.Unix(1_300, 0),
			RefreshToken: "refresh-token",
			Scope:        "package:operate offline_access",
			TokenType:    "DPoP",
		},
		privateKey,
	)
	if err != nil {
		t.Fatalf("AuthorizeAndExchange() error = %v", err)
	}
	if authorized.InstallSession != "signed-install-session" ||
		authorized.DeliveryGrant != "signed-delivery-grant" {
		t.Fatalf("AuthorizeAndExchange() = %#v", authorized)
	}
	for _, body := range []map[string]any{authorizationBody, sessionBody} {
		for _, forbidden := range []string{
			"accessToken",
			"refreshToken",
			"privateKey",
			"provider",
			"catalogProductIds",
		} {
			if _, exists := body[forbidden]; exists {
				t.Fatalf("broker server body exposes forbidden field %q: %#v", forbidden, body)
			}
		}
	}
	if _, exists := authorizationBody["operationCapability"]; exists {
		t.Fatalf("authorization request sent a server capability: %#v", authorizationBody)
	}
	if sessionBody["operationCapability"] != "signed-operation-capability" ||
		sessionBody["targetReleaseRoot"] != strings.Repeat("11", 32) {
		t.Fatalf("session body = %#v", sessionBody)
	}
}

func TestRemoteClientRecoversACompletedExchangeAfterTheFirstResponseIsLost(t *testing.T) {
	privateKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("GenerateKey() error = %v", err)
	}
	operation := OperationRequest{
		AliasID:                     "jammr",
		ApprovedActiveContentDigest: strings.Repeat("33", 32),
		ApprovedPolicyVersion:       "active-content-policy-v1",
		ExpectedCurrentReleaseRoot:  strings.Repeat("00", 32),
		IdempotencyKey:              "install-jammr-retry-1",
		Operation:                   "install",
		ProjectIdentity:             strings.Repeat("22", 32),
		ProjectPath:                 `C:\Unity\Project`,
		RunID:                       "run-jammr-install-retry-1",
		SchemaVersion:               OperationRequestSchemaVersion,
		Traceparent:                 "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
	}
	sessionRequests := 0
	authorizationRequests := 0
	server := httptest.NewServer(http.HandlerFunc(func(
		writer http.ResponseWriter,
		request *http.Request,
	) {
		writer.Header().Set("Content-Type", "application/json")
		switch request.URL.Path {
		case "/api/v2/package-installs/authorizations":
			authorizationRequests++
			if authorizationRequests == 1 {
				writer.WriteHeader(http.StatusCreated)
			} else {
				writer.WriteHeader(http.StatusOK)
			}
			_, _ = writer.Write([]byte(`{
				"expiresAt":"2030-01-01T00:00:00Z",
				"operationCapability":"persisted-operation-capability",
				"releaseRoot":"` + strings.Repeat("11", 32) + `"
			}`))
		case "/api/v2/package-installs/sessions":
			sessionRequests++
			if sessionRequests == 1 {
				writer.Header().Set("Content-Length", "2048")
				_, _ = writer.Write([]byte(`{"deliveryGrant":"truncated`))
				return
			}
			_, _ = writer.Write([]byte(`{
				"deliveryGrant":"signed-delivery-grant",
				"deliveryGrantPurpose":"delivery-grant-v2",
				"installSession":"signed-install-session",
				"installSessionPurpose":"install-session-v2",
				"releaseRoot":"` + strings.Repeat("11", 32) + `",
				"versionId":"version-jammr-1"
			}`))
		default:
			http.NotFound(writer, request)
		}
	}))
	defer server.Close()

	client := RemoteClient{
		APIBaseURL: server.URL,
		HTTPClient: server.Client(),
		Now:        func() time.Time { return time.Unix(1_000, 0) },
	}
	tokens := OAuthTokens{
		AccessToken:  "access-token",
		ExpiresAt:    time.Unix(1_300, 0),
		RefreshToken: "refresh-token",
		Scope:        "package:operate offline_access",
		TokenType:    "DPoP",
	}

	if _, err := client.AuthorizeAndExchange(
		context.Background(),
		operation,
		tokens,
		privateKey,
	); err == nil {
		t.Fatal("AuthorizeAndExchange() first attempt error = nil, want lost response error")
	}
	authorized, err := client.AuthorizeAndExchange(
		context.Background(),
		operation,
		tokens,
		privateKey,
	)
	if err != nil {
		t.Fatalf("AuthorizeAndExchange() retry error = %v", err)
	}
	if authorized.DeliveryGrant != "signed-delivery-grant" ||
		authorized.InstallSession != "signed-install-session" {
		t.Fatalf("AuthorizeAndExchange() retry = %#v", authorized)
	}
	if authorizationRequests != 2 || sessionRequests != 2 {
		t.Fatalf(
			"request counts = authorization %d, session %d; want 2 each",
			authorizationRequests,
			sessionRequests,
		)
	}
}

func TestRemoteClientRenewsTheExactBoundInstallSession(t *testing.T) {
	privateKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("GenerateKey() error = %v", err)
	}
	var renewalBody map[string]any
	renewalRequests := 0
	server := httptest.NewServer(http.HandlerFunc(func(
		writer http.ResponseWriter,
		request *http.Request,
	) {
		if request.URL.Path != "/api/v2/package-installs/renewals" {
			http.NotFound(writer, request)
			return
		}
		if request.Header.Get("traceparent") !=
			"00-0123456789abcdef0123456789abcdef-0123456789abcdef-01" {
			t.Error("renewal request omitted the operation trace context")
			writer.WriteHeader(http.StatusBadRequest)
			return
		}
		if err := json.NewDecoder(request.Body).Decode(&renewalBody); err != nil {
			t.Errorf("decode renewal body: %v", err)
			writer.WriteHeader(http.StatusBadRequest)
			return
		}
		renewalRequests++
		writer.Header().Set("Content-Type", "application/json")
		if renewalRequests == 1 {
			writer.Header().Set("Content-Length", "2048")
			_, _ = writer.Write([]byte(`{"deliveryGrant":"truncated`))
			return
		}
		_, _ = writer.Write([]byte(`{
			"deliveryGrant":"renewed-delivery-grant",
			"deliveryGrantPurpose":"delivery-grant-v2",
			"expiresAt":"2030-01-01T00:05:00Z",
			"installSession":"renewed-install-session",
			"installSessionPurpose":"install-session-v2",
			"releaseRoot":"` + strings.Repeat("11", 32) + `",
			"versionId":"version-jammr-1"
		}`))
	}))
	defer server.Close()

	client := RemoteClient{
		APIBaseURL: server.URL,
		HTTPClient: server.Client(),
		Now:        func() time.Time { return time.Unix(1_000, 0) },
	}
	renewed, err := client.Renew(
		context.Background(),
		AuthorizationRenewal{
			DeliveryGrant:  "expired-delivery-grant",
			InstallSession: "expired-install-session",
			ReleaseRoot:    strings.Repeat("11", 32),
			Traceparent:    "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
			VersionID:      "version-jammr-1",
		},
		OAuthTokens{
			AccessToken:  "access-token",
			ExpiresAt:    time.Unix(1_300, 0),
			RefreshToken: "refresh-token",
			Scope:        "package:operate offline_access",
			TokenType:    "DPoP",
		},
		privateKey,
	)
	if err != nil {
		t.Fatalf("Renew() error = %v", err)
	}
	if renewed.DeliveryGrant != "renewed-delivery-grant" ||
		renewed.InstallSession != "renewed-install-session" {
		t.Fatalf("Renew() = %#v", renewed)
	}
	if renewalBody["deliveryGrant"] != "expired-delivery-grant" ||
		renewalBody["installSession"] != "expired-install-session" ||
		renewalBody["traceparent"] !=
			"00-0123456789abcdef0123456789abcdef-0123456789abcdef-01" {
		t.Fatalf("renewal body = %#v", renewalBody)
	}
	if renewalRequests != 2 {
		t.Fatalf("renewal requests = %d, want 2 after the lost first response", renewalRequests)
	}
}

func TestRemoteClientReturnsVerificationRequirementWithoutReadingDelivery(t *testing.T) {
	privateKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("GenerateKey() error = %v", err)
	}
	requestCount := 0
	server := httptest.NewServer(http.HandlerFunc(func(
		writer http.ResponseWriter,
		_ *http.Request,
	) {
		requestCount++
		writer.Header().Set("Content-Type", "application/json")
		writer.WriteHeader(http.StatusForbidden)
		_, _ = writer.Write([]byte(`{
			"errorCode":"ENTITLEMENT_REQUIRED",
			"verificationUrl":"https://app.example.test/access/product-1"
		}`))
	}))
	defer server.Close()
	client := RemoteClient{APIBaseURL: server.URL, HTTPClient: server.Client()}
	_, err = client.AuthorizeAndExchange(
		context.Background(),
		OperationRequest{
			AliasID:                    "jammr",
			ExpectedCurrentReleaseRoot: strings.Repeat("00", 32),
			IdempotencyKey:             "preflight-jammr-1",
			Operation:                  "preflight",
			ProjectIdentity:            strings.Repeat("22", 32),
			ProjectPath:                `C:\Unity\Project`,
			RunID:                      "run-jammr-preflight-1",
			SchemaVersion:              OperationRequestSchemaVersion,
			Traceparent:                "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
		},
		OAuthTokens{
			AccessToken:  "access-token",
			ExpiresAt:    time.Now().Add(5 * time.Minute),
			RefreshToken: "refresh-token",
			Scope:        "package:operate offline_access",
			TokenType:    "DPoP",
		},
		privateKey,
	)
	var verification *VerificationRequiredError
	if !errors.As(err, &verification) ||
		verification.URL != "https://app.example.test/access/product-1" {
		t.Fatalf("AuthorizeAndExchange() error = %v", err)
	}
	if requestCount != 1 {
		t.Fatalf("server requests = %d, want 1", requestCount)
	}
}
