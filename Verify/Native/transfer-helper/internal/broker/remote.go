package broker

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/yucp/transfer-helper/internal/dpop"
)

const maxPackageAPIResponseBytes = 512 * 1024

var ErrAuthenticationRequired = errors.New("package broker authentication is required")

type VerificationRequiredError struct {
	URL string
}

func (err *VerificationRequiredError) Error() string {
	return "package ownership verification is required"
}

type RemoteClient struct {
	APIBaseURL string
	HTTPClient *http.Client
	Now        func() time.Time
}

type AuthorizedOperation struct {
	DeliveryGrant         string
	ExpiresAt             time.Time
	InstallSession        string
	MaterializationJobID  string
	ReleaseRoot           string
	VersionID             string
	deliveryGrantPurpose  string
	installSessionPurpose string
}

type AuthorizationRenewal struct {
	DeliveryGrant  string
	InstallSession string
	ReleaseRoot    string
	Traceparent    string
	VersionID      string
}

type packageOperationBody struct {
	AliasID                     string `json:"aliasId"`
	ApprovedActiveContentDigest string `json:"approvedActiveContentDigest,omitempty"`
	ApprovedPolicyVersion       string `json:"approvedPolicyVersion,omitempty"`
	ExpectedCurrentReleaseRoot  string `json:"expectedCurrentReleaseRoot"`
	IdempotencyKey              string `json:"idempotencyKey"`
	Operation                   string `json:"operation"`
	ProjectIdentity             string `json:"projectIdentity"`
	TargetReleaseRoot           string `json:"targetReleaseRoot,omitempty"`
	Traceparent                 string `json:"traceparent"`
}

type operationAuthorizationResponse struct {
	ExpiresAt           string `json:"expiresAt"`
	OperationCapability string `json:"operationCapability"`
	ReleaseRoot         string `json:"releaseRoot"`
}

type installSessionResponse struct {
	DeliveryGrant         string `json:"deliveryGrant"`
	DeliveryGrantPurpose  string `json:"deliveryGrantPurpose"`
	ExpiresAt             string `json:"expiresAt"`
	InstallSession        string `json:"installSession"`
	InstallSessionPurpose string `json:"installSessionPurpose"`
	MaterializationJobID  string `json:"materializationJobId"`
	ReleaseRoot           string `json:"releaseRoot"`
	VersionID             string `json:"versionId"`
}

type packageAPIError struct {
	Error           string `json:"error"`
	ErrorCode       string `json:"errorCode"`
	VerificationURL string `json:"verificationUrl"`
}

type packageAPIStatusError struct {
	code   string
	status int
}

func (err *packageAPIStatusError) Error() string {
	if err.code != "" {
		return fmt.Sprintf("package broker API returned HTTP %d (%s)", err.status, err.code)
	}
	return fmt.Sprintf("package broker API returned HTTP %d", err.status)
}

func (err *packageAPIStatusError) StableCode() string {
	return err.code
}

func (client RemoteClient) AuthorizeAndExchange(
	ctx context.Context,
	request OperationRequest,
	tokens OAuthTokens,
	privateKey *ecdsa.PrivateKey,
) (AuthorizedOperation, error) {
	if err := validateOperationRequest(request); err != nil {
		return AuthorizedOperation{}, err
	}
	if err := validateOAuthTokens(tokens); err != nil {
		return AuthorizedOperation{}, err
	}
	operation := packageOperationBody{
		AliasID:                     request.AliasID,
		ApprovedActiveContentDigest: request.ApprovedActiveContentDigest,
		ApprovedPolicyVersion:       request.ApprovedPolicyVersion,
		ExpectedCurrentReleaseRoot:  request.ExpectedCurrentReleaseRoot,
		IdempotencyKey:              request.IdempotencyKey,
		Operation:                   request.Operation,
		ProjectIdentity:             request.ProjectIdentity,
		TargetReleaseRoot:           request.TargetReleaseRoot,
		Traceparent:                 request.Traceparent,
	}
	var authorization operationAuthorizationResponse
	if err := client.post(
		ctx,
		"/api/v2/package-installs/authorizations",
		operation,
		tokens.AccessToken,
		privateKey,
		request.Traceparent,
		&authorization,
	); err != nil {
		return AuthorizedOperation{}, err
	}
	if !isDigest(authorization.ReleaseRoot) ||
		authorization.OperationCapability == "" ||
		len(authorization.OperationCapability) > 256*1024 {
		return AuthorizedOperation{}, fmt.Errorf("package authorization response is invalid")
	}
	operation.TargetReleaseRoot = authorization.ReleaseRoot
	sessionBody := struct {
		packageOperationBody
		OperationCapability string `json:"operationCapability"`
	}{
		packageOperationBody: operation,
		OperationCapability:  authorization.OperationCapability,
	}
	var session installSessionResponse
	if err := client.post(
		ctx,
		"/api/v2/package-installs/sessions",
		sessionBody,
		tokens.AccessToken,
		privateKey,
		request.Traceparent,
		&session,
	); err != nil {
		return AuthorizedOperation{}, err
	}
	if session.DeliveryGrant == "" ||
		session.InstallSession == "" ||
		session.DeliveryGrantPurpose != "delivery-grant-v2" ||
		session.InstallSessionPurpose != "install-session-v2" ||
		session.ReleaseRoot != authorization.ReleaseRoot ||
		strings.TrimSpace(session.VersionID) == "" {
		return AuthorizedOperation{}, fmt.Errorf("package install session response is invalid")
	}
	return AuthorizedOperation{
		DeliveryGrant:         session.DeliveryGrant,
		InstallSession:        session.InstallSession,
		MaterializationJobID:  session.MaterializationJobID,
		ReleaseRoot:           session.ReleaseRoot,
		VersionID:             session.VersionID,
		deliveryGrantPurpose:  session.DeliveryGrantPurpose,
		installSessionPurpose: session.InstallSessionPurpose,
	}, nil
}

func (client RemoteClient) Renew(
	ctx context.Context,
	renewal AuthorizationRenewal,
	tokens OAuthTokens,
	privateKey *ecdsa.PrivateKey,
) (AuthorizedOperation, error) {
	if renewal.DeliveryGrant == "" ||
		renewal.InstallSession == "" ||
		!isDigest(renewal.ReleaseRoot) ||
		strings.TrimSpace(renewal.VersionID) == "" ||
		!validTraceparent(renewal.Traceparent) {
		return AuthorizedOperation{}, fmt.Errorf("package authorization renewal is invalid")
	}
	if err := validateOAuthTokens(tokens); err != nil {
		return AuthorizedOperation{}, err
	}
	body := struct {
		DeliveryGrant  string `json:"deliveryGrant"`
		InstallSession string `json:"installSession"`
		Traceparent    string `json:"traceparent"`
	}{
		DeliveryGrant:  renewal.DeliveryGrant,
		InstallSession: renewal.InstallSession,
		Traceparent:    renewal.Traceparent,
	}
	var response installSessionResponse
	for attempt := 0; attempt < 2; attempt++ {
		response = installSessionResponse{}
		err := client.post(
			ctx,
			"/api/v2/package-installs/renewals",
			body,
			tokens.AccessToken,
			privateKey,
			renewal.Traceparent,
			&response,
		)
		if err == nil {
			break
		}
		var statusError *packageAPIStatusError
		if attempt == 1 ||
			errors.Is(err, ErrAuthenticationRequired) ||
			errors.Is(err, context.Canceled) ||
			errors.Is(err, context.DeadlineExceeded) ||
			errors.As(err, &statusError) {
			return AuthorizedOperation{}, err
		}
	}
	expiresAt, err := time.Parse(time.RFC3339, response.ExpiresAt)
	if err != nil ||
		response.DeliveryGrant == "" ||
		response.InstallSession == "" ||
		response.DeliveryGrantPurpose != "delivery-grant-v2" ||
		response.InstallSessionPurpose != "install-session-v2" ||
		response.ReleaseRoot != renewal.ReleaseRoot ||
		response.VersionID != renewal.VersionID {
		return AuthorizedOperation{}, fmt.Errorf("package renewal response is invalid")
	}
	return AuthorizedOperation{
		DeliveryGrant:         response.DeliveryGrant,
		ExpiresAt:             expiresAt,
		InstallSession:        response.InstallSession,
		MaterializationJobID:  response.MaterializationJobID,
		ReleaseRoot:           response.ReleaseRoot,
		VersionID:             response.VersionID,
		deliveryGrantPurpose:  response.DeliveryGrantPurpose,
		installSessionPurpose: response.InstallSessionPurpose,
	}, nil
}

func (client RemoteClient) post(
	ctx context.Context,
	path string,
	body any,
	accessToken string,
	privateKey *ecdsa.PrivateKey,
	traceparent string,
	destination any,
) error {
	apiBase, err := client.canonicalAPIBase()
	if err != nil {
		return err
	}
	target := apiBase + path
	encoded, err := json.Marshal(body)
	if err != nil {
		return fmt.Errorf("encode package broker API request: %w", err)
	}
	proofTime := time.Now()
	if client.Now != nil {
		proofTime = client.Now()
	}
	proof, err := dpop.CreateProof(
		privateKey,
		http.MethodPost,
		target,
		accessToken,
		proofTime,
	)
	if err != nil {
		return fmt.Errorf("create package broker API proof: %w", err)
	}
	request, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		target,
		bytes.NewReader(encoded),
	)
	if err != nil {
		return fmt.Errorf("create package broker API request: %w", err)
	}
	request.Header.Set("Authorization", "DPoP "+accessToken)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("DPoP", proof)
	request.Header.Set("traceparent", traceparent)
	httpClient := client.HTTPClient
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 60 * time.Second}
	}
	response, err := httpClient.Do(request)
	if err != nil {
		return fmt.Errorf("send package broker API request: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusUnauthorized {
		return ErrAuthenticationRequired
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		var apiError packageAPIError
		_ = json.NewDecoder(
			io.LimitReader(response.Body, maxPackageAPIResponseBytes),
		).Decode(&apiError)
		if response.StatusCode == http.StatusForbidden &&
			apiError.ErrorCode == "ENTITLEMENT_REQUIRED" &&
			validBrowserURL(apiError.VerificationURL) {
			return &VerificationRequiredError{URL: apiError.VerificationURL}
		}
		if apiError.ErrorCode != "" {
			return &packageAPIStatusError{
				code:   apiError.ErrorCode,
				status: response.StatusCode,
			}
		}
		return &packageAPIStatusError{status: response.StatusCode}
	}
	decoder := json.NewDecoder(io.LimitReader(response.Body, maxPackageAPIResponseBytes))
	if err := decoder.Decode(destination); err != nil {
		return fmt.Errorf("decode package broker API response: %w", err)
	}
	return nil
}

func (client RemoteClient) canonicalAPIBase() (string, error) {
	parsed, err := url.Parse(strings.TrimRight(strings.TrimSpace(client.APIBaseURL), "/"))
	if err != nil ||
		!parsed.IsAbs() ||
		parsed.Hostname() == "" ||
		parsed.User != nil ||
		parsed.RawQuery != "" ||
		parsed.Fragment != "" ||
		(parsed.Scheme != "https" &&
			!(parsed.Scheme == "http" && isLoopbackHostname(parsed.Hostname()))) {
		return "", fmt.Errorf("package broker API base URL is invalid")
	}
	return parsed.String(), nil
}

func validBrowserURL(raw string) bool {
	parsed, err := url.Parse(raw)
	return err == nil &&
		parsed.IsAbs() &&
		parsed.Hostname() != "" &&
		parsed.User == nil &&
		(parsed.Scheme == "https" ||
			(parsed.Scheme == "http" && isLoopbackHostname(parsed.Hostname())))
}
