package broker

import (
	"context"
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/yucp/transfer-helper/internal/dpop"
)

const (
	PackageBrokerOAuthClientID = "yucp-package-broker"
	PackageBrokerOAuthResource = "https://api.creators.yucp.club/package-operations"
	packageBrokerOAuthScope    = "package:operate offline_access"
	oauthCallbackTimeout       = 5 * time.Minute
	maxOAuthResponseBytes      = 64 * 1024
)

type OAuthClient struct {
	AuthBaseURL string
	HTTPClient  *http.Client
	Now         func() time.Time
	OpenURL     func(string) error
}

type oauthCallback struct {
	code string
	err  error
}

type oauthTokenResponse struct {
	AccessToken  string `json:"access_token"`
	ExpiresAt    int64  `json:"expires_at"`
	ExpiresIn    int64  `json:"expires_in"`
	IDToken      string `json:"id_token"`
	RefreshToken string `json:"refresh_token"`
	Scope        string `json:"scope"`
	TokenType    string `json:"token_type"`
}

// Authorize follows RFC 8252 loopback redirects and RFC 7636 PKCE.
// See https://www.rfc-editor.org/rfc/rfc8252 and https://www.rfc-editor.org/rfc/rfc7636.
// Better Auth documents this provider at https://better-auth.com/docs/plugins/oauth-provider.
func (client OAuthClient) Authorize(
	ctx context.Context,
	privateKey *ecdsa.PrivateKey,
	deviceThumbprint string,
) (OAuthTokens, error) {
	authBase, err := client.canonicalAuthBase()
	if err != nil {
		return OAuthTokens{}, err
	}
	if !isCanonicalThumbprint(deviceThumbprint) {
		return OAuthTokens{}, fmt.Errorf("package broker DPoP thumbprint is invalid")
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return OAuthTokens{}, fmt.Errorf("listen for OAuth callback: %w", err)
	}
	defer listener.Close()
	callbackURL := "http://" + listener.Addr().String() + "/callback"
	state, err := randomBase64URL(32)
	if err != nil {
		return OAuthTokens{}, err
	}
	verifier, err := randomBase64URL(32)
	if err != nil {
		return OAuthTokens{}, err
	}
	challengeDigest := sha256.Sum256([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(challengeDigest[:])
	callbacks := make(chan oauthCallback, 1)
	mux := http.NewServeMux()
	mux.HandleFunc("/callback", func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Cache-Control", "no-store")
		writer.Header().Set(
			"Content-Security-Policy",
			"default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; "+
				"font-src https://fonts.gstatic.com; img-src https://raw.githubusercontent.com; "+
				"base-uri 'none'; frame-ancestors 'none'",
		)
		writer.Header().Set("Content-Type", "text/html; charset=utf-8")
		if request.Method != http.MethodGet ||
			request.URL.Query().Get("state") != state ||
			request.URL.Query().Get("code") == "" ||
			request.URL.Query().Get("error") != "" {
			select {
			case callbacks <- oauthCallback{err: fmt.Errorf("OAuth callback is invalid")}:
			default:
			}
			writer.WriteHeader(http.StatusBadRequest)
			_, _ = io.WriteString(
				writer,
				buildOAuthErrorPage("The authorization response was invalid or expired."),
			)
			return
		}
		select {
		case callbacks <- oauthCallback{code: request.URL.Query().Get("code")}:
		default:
		}
		_, _ = io.WriteString(
			writer,
			buildOAuthSuccessPage(),
		)
	})
	server := &http.Server{
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}
	serveDone := make(chan error, 1)
	go func() {
		serveDone <- server.Serve(listener)
	}()

	authorizeURL, err := url.Parse(authBase + "/oauth2/authorize")
	if err != nil {
		return OAuthTokens{}, fmt.Errorf("build OAuth authorization URL: %w", err)
	}
	query := authorizeURL.Query()
	query.Set("client_id", PackageBrokerOAuthClientID)
	query.Set("code_challenge", challenge)
	query.Set("code_challenge_method", "S256")
	query.Set("dpop_jkt", deviceThumbprint)
	query.Set("redirect_uri", callbackURL)
	query.Set("resource", PackageBrokerOAuthResource)
	query.Set("response_type", "code")
	query.Set("scope", packageBrokerOAuthScope)
	query.Set("state", state)
	authorizeURL.RawQuery = query.Encode()
	openURL := client.OpenURL
	if openURL == nil {
		openURL = openExternalURL
	}
	if err := openURL(authorizeURL.String()); err != nil {
		return OAuthTokens{}, fmt.Errorf("open OAuth authorization page: %w", err)
	}

	callbackContext, cancel := context.WithTimeout(ctx, oauthCallbackTimeout)
	defer cancel()
	var callback oauthCallback
	select {
	case callback = <-callbacks:
	case err := <-serveDone:
		if err != nil && err != http.ErrServerClosed {
			return OAuthTokens{}, fmt.Errorf("serve OAuth callback: %w", err)
		}
		return OAuthTokens{}, fmt.Errorf("OAuth callback listener stopped")
	case <-callbackContext.Done():
		return OAuthTokens{}, fmt.Errorf("OAuth authorization timed out")
	}
	shutdownContext, shutdownCancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer shutdownCancel()
	_ = server.Shutdown(shutdownContext)
	if callback.err != nil {
		return OAuthTokens{}, callback.err
	}
	return client.exchangeToken(ctx, privateKey, url.Values{
		"client_id":     {PackageBrokerOAuthClientID},
		"code":          {callback.code},
		"code_verifier": {verifier},
		"grant_type":    {"authorization_code"},
		"redirect_uri":  {callbackURL},
		"resource":      {PackageBrokerOAuthResource},
	})
}

func (client OAuthClient) Refresh(
	ctx context.Context,
	privateKey *ecdsa.PrivateKey,
	refreshToken string,
) (OAuthTokens, error) {
	if strings.TrimSpace(refreshToken) == "" {
		return OAuthTokens{}, fmt.Errorf("package broker refresh token is missing")
	}
	return client.exchangeToken(ctx, privateKey, url.Values{
		"client_id":     {PackageBrokerOAuthClientID},
		"grant_type":    {"refresh_token"},
		"refresh_token": {refreshToken},
		"resource":      {PackageBrokerOAuthResource},
	})
}

// Revoke follows RFC 7009 token revocation and RFC 9449 DPoP proof binding.
// See https://www.rfc-editor.org/rfc/rfc7009 and https://www.rfc-editor.org/rfc/rfc9449.
func (client OAuthClient) Revoke(
	ctx context.Context,
	privateKey *ecdsa.PrivateKey,
	refreshToken string,
) error {
	if strings.TrimSpace(refreshToken) == "" {
		return fmt.Errorf("package broker refresh token is missing")
	}
	authBase, err := client.canonicalAuthBase()
	if err != nil {
		return err
	}
	revokeURL := authBase + "/oauth2/revoke"
	now := time.Now()
	if client.Now != nil {
		now = client.Now()
	}
	proof, err := dpop.CreateTokenProof(privateKey, revokeURL, now)
	if err != nil {
		return fmt.Errorf("create OAuth revocation DPoP proof: %w", err)
	}
	form := url.Values{
		"client_id":       {PackageBrokerOAuthClientID},
		"token":           {refreshToken},
		"token_type_hint": {"refresh_token"},
	}
	request, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		revokeURL,
		strings.NewReader(form.Encode()),
	)
	if err != nil {
		return fmt.Errorf("create OAuth revocation request: %w", err)
	}
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	request.Header.Set("DPoP", proof)
	httpClient := client.HTTPClient
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 30 * time.Second}
	}
	response, err := httpClient.Do(request)
	if err != nil {
		return fmt.Errorf("revoke OAuth token: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf(
			"OAuth revocation endpoint returned HTTP %d",
			response.StatusCode,
		)
	}
	return nil
}

func (client OAuthClient) exchangeToken(
	ctx context.Context,
	privateKey *ecdsa.PrivateKey,
	form url.Values,
) (OAuthTokens, error) {
	authBase, err := client.canonicalAuthBase()
	if err != nil {
		return OAuthTokens{}, err
	}
	tokenURL := authBase + "/oauth2/token"
	now := time.Now()
	if client.Now != nil {
		now = client.Now()
	}
	proof, err := dpop.CreateTokenProof(privateKey, tokenURL, now)
	if err != nil {
		return OAuthTokens{}, fmt.Errorf("create OAuth DPoP proof: %w", err)
	}
	request, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		tokenURL,
		strings.NewReader(form.Encode()),
	)
	if err != nil {
		return OAuthTokens{}, fmt.Errorf("create OAuth token request: %w", err)
	}
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	request.Header.Set("DPoP", proof)
	httpClient := client.HTTPClient
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 30 * time.Second}
	}
	response, err := httpClient.Do(request)
	if err != nil {
		return OAuthTokens{}, fmt.Errorf("exchange OAuth token: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return OAuthTokens{}, fmt.Errorf(
			"OAuth token endpoint returned HTTP %d",
			response.StatusCode,
		)
	}
	decoder := json.NewDecoder(io.LimitReader(response.Body, maxOAuthResponseBytes))
	var tokenResponse oauthTokenResponse
	if err := decoder.Decode(&tokenResponse); err != nil {
		return OAuthTokens{}, fmt.Errorf("decode OAuth token response: %w", err)
	}
	if tokenResponse.ExpiresIn <= 0 || tokenResponse.ExpiresIn > 900 {
		return OAuthTokens{}, fmt.Errorf("OAuth access token lifetime is invalid")
	}
	tokens := OAuthTokens{
		AccessToken:  tokenResponse.AccessToken,
		ExpiresAt:    now.Add(time.Duration(tokenResponse.ExpiresIn) * time.Second),
		RefreshToken: tokenResponse.RefreshToken,
		Scope:        tokenResponse.Scope,
		TokenType:    tokenResponse.TokenType,
	}
	if err := validateOAuthTokens(tokens); err != nil {
		return OAuthTokens{}, err
	}
	return tokens, nil
}

func (client OAuthClient) canonicalAuthBase() (string, error) {
	parsed, err := url.Parse(strings.TrimRight(strings.TrimSpace(client.AuthBaseURL), "/"))
	if err != nil ||
		!parsed.IsAbs() ||
		parsed.Hostname() == "" ||
		parsed.User != nil ||
		(parsed.Scheme != "https" &&
			!(parsed.Scheme == "http" && isLoopbackHostname(parsed.Hostname()))) {
		return "", fmt.Errorf("package broker authorization base URL is invalid")
	}
	return parsed.String(), nil
}

func randomBase64URL(length int) (string, error) {
	value := make([]byte, length)
	if _, err := rand.Read(value); err != nil {
		return "", fmt.Errorf("create OAuth random value: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(value), nil
}

func isCanonicalThumbprint(value string) bool {
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	return err == nil &&
		len(decoded) == 32 &&
		base64.RawURLEncoding.EncodeToString(decoded) == value
}

func isLoopbackHostname(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(strings.Trim(host, "[]"))
	return ip != nil && ip.IsLoopback()
}
