package broker

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestOAuthAuthorizationUsesRFC8252PKCEResourceAndDPoP(t *testing.T) {
	privateKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("GenerateKey() error = %v", err)
	}
	var authorizationQuery url.Values
	var callbackHTML string
	var tokenForm url.Values
	server := httptest.NewServer(http.HandlerFunc(func(
		writer http.ResponseWriter,
		request *http.Request,
	) {
		switch request.URL.Path {
		case "/api/auth/oauth2/token":
			if err := request.ParseForm(); err != nil {
				t.Errorf("ParseForm() error = %v", err)
				writer.WriteHeader(http.StatusBadRequest)
				return
			}
			tokenForm = request.PostForm
			if request.Header.Get("DPoP") == "" {
				t.Error("token request omitted DPoP proof")
			}
			writer.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(writer).Encode(map[string]any{
				"access_token":  "access-token",
				"expires_in":    300,
				"refresh_token": "refresh-token",
				"scope":         "package:operate offline_access",
				"token_type":    "DPoP",
			})
		default:
			http.NotFound(writer, request)
		}
	}))
	defer server.Close()

	client := OAuthClient{
		AuthBaseURL: server.URL + "/api/auth",
		HTTPClient:  server.Client(),
		Now:         func() time.Time { return time.Unix(1_000, 0) },
		OpenURL: func(raw string) error {
			parsed, err := url.Parse(raw)
			if err != nil {
				return err
			}
			authorizationQuery = parsed.Query()
			callback, err := url.Parse(authorizationQuery.Get("redirect_uri"))
			if err != nil {
				return err
			}
			query := callback.Query()
			query.Set("code", "authorization-code")
			query.Set("state", authorizationQuery.Get("state"))
			callback.RawQuery = query.Encode()
			response, err := server.Client().Get(callback.String())
			if err != nil {
				return err
			}
			defer response.Body.Close()
			callbackBody, err := io.ReadAll(response.Body)
			if err != nil {
				return err
			}
			callbackHTML = string(callbackBody)
			return nil
		},
	}
	thumbprint := make([]byte, 32)
	for index := range thumbprint {
		thumbprint[index] = 0x44
	}
	tokens, err := client.Authorize(
		context.Background(),
		privateKey,
		base64.RawURLEncoding.EncodeToString(thumbprint),
	)
	if err != nil {
		t.Fatalf("Authorize() error = %v", err)
	}
	if tokens.AccessToken != "access-token" || tokens.RefreshToken != "refresh-token" {
		t.Fatalf("Authorize() tokens = %#v", tokens)
	}
	if authorizationQuery.Get("client_id") != PackageBrokerOAuthClientID ||
		authorizationQuery.Get("response_type") != "code" ||
		authorizationQuery.Get("code_challenge_method") != "S256" ||
		authorizationQuery.Get("resource") != PackageBrokerOAuthResource ||
		authorizationQuery.Get("dpop_jkt") != base64.RawURLEncoding.EncodeToString(thumbprint) ||
		!strings.HasPrefix(authorizationQuery.Get("redirect_uri"), "http://127.0.0.1:") {
		t.Fatalf("authorization query = %#v", authorizationQuery)
	}
	if tokenForm.Get("grant_type") != "authorization_code" ||
		tokenForm.Get("code") != "authorization-code" ||
		tokenForm.Get("client_id") != PackageBrokerOAuthClientID ||
		tokenForm.Get("resource") != PackageBrokerOAuthResource ||
		tokenForm.Get("code_verifier") == "" {
		t.Fatalf("token form = %#v", tokenForm)
	}
	for _, expected := range []string{
		"Creator Identity is ready",
		"Return to Unity. Your purchase verification controls are now available in the YUCP Package Manager.",
		"You can close this tab and continue in Unity.",
		"class=\"detail-card detail-card-success\"",
		"font-family: 'Plus Jakarta Sans'",
		"apps/web/public/Icons/MainLogo.png",
	} {
		if !strings.Contains(callbackHTML, expected) {
			t.Fatalf("OAuth callback page omitted %q", expected)
		}
	}
}

func TestOAuthRefreshRotatesTokenWithTheDeviceProofKey(t *testing.T) {
	privateKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("GenerateKey() error = %v", err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(
		writer http.ResponseWriter,
		request *http.Request,
	) {
		if err := request.ParseForm(); err != nil {
			t.Errorf("ParseForm() error = %v", err)
			writer.WriteHeader(http.StatusBadRequest)
			return
		}
		if request.PostForm.Get("grant_type") != "refresh_token" ||
			request.PostForm.Get("refresh_token") != "old-refresh-token" ||
			request.Header.Get("DPoP") == "" {
			t.Errorf("refresh request = %#v", request.PostForm)
			writer.WriteHeader(http.StatusBadRequest)
			return
		}
		writer.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprint(writer, `{
			"access_token":"new-access-token",
			"expires_in":300,
			"refresh_token":"new-refresh-token",
			"scope":"package:operate offline_access",
			"token_type":"DPoP"
		}`)
	}))
	defer server.Close()

	client := OAuthClient{
		AuthBaseURL: server.URL,
		HTTPClient:  server.Client(),
		Now:         func() time.Time { return time.Unix(2_000, 0) },
	}
	tokens, err := client.Refresh(
		context.Background(),
		privateKey,
		"old-refresh-token",
	)
	if err != nil {
		t.Fatalf("Refresh() error = %v", err)
	}
	if tokens.AccessToken != "new-access-token" ||
		tokens.RefreshToken != "new-refresh-token" {
		t.Fatalf("Refresh() = %#v", tokens)
	}
}

func TestOAuthRevokesRefreshTokenWithPublicClientAndDeviceProof(t *testing.T) {
	privateKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("GenerateKey() error = %v", err)
	}
	var revoked url.Values
	server := httptest.NewServer(http.HandlerFunc(func(
		writer http.ResponseWriter,
		request *http.Request,
	) {
		if request.URL.Path != "/api/auth/oauth2/revoke" {
			http.NotFound(writer, request)
			return
		}
		if err := request.ParseForm(); err != nil {
			t.Errorf("ParseForm() error = %v", err)
			writer.WriteHeader(http.StatusBadRequest)
			return
		}
		revoked = request.PostForm
		if request.Header.Get("DPoP") == "" {
			t.Error("revocation request omitted DPoP proof")
			writer.WriteHeader(http.StatusBadRequest)
			return
		}
		writer.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	client := OAuthClient{
		AuthBaseURL: server.URL + "/api/auth",
		HTTPClient:  server.Client(),
		Now:         func() time.Time { return time.Unix(3_000, 0) },
	}
	if err := client.Revoke(
		context.Background(),
		privateKey,
		"refresh-token-to-revoke",
	); err != nil {
		t.Fatalf("Revoke() error = %v", err)
	}
	if revoked.Get("client_id") != PackageBrokerOAuthClientID ||
		revoked.Get("token") != "refresh-token-to-revoke" ||
		revoked.Get("token_type_hint") != "refresh_token" {
		t.Fatalf("revocation form = %#v", revoked)
	}
}
