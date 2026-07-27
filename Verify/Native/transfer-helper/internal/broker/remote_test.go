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
