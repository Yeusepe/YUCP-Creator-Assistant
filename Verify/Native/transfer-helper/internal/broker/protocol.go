package broker

import (
	"bytes"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

const (
	DefaultPipeName                 = `\\.\pipe\yucp.package-broker.v1`
	OperationRequestSchemaVersion   = 4
	connectionAuthorizationLifetime = 30 * time.Second
	maxOperationRequestBytes        = 1024 * 1024
)

var (
	safeIdentifierPattern  = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)
	stableErrorCodePattern = regexp.MustCompile(`^[A-Z][A-Z0-9_]{0,63}$`)
	traceparentPattern     = regexp.MustCompile(
		`^00-([0-9a-f]{32})-([0-9a-f]{16})-(00|01)$`,
	)
)

type OperationRequest struct {
	AliasID                     string `json:"aliasId"`
	ApprovedActiveContentDigest string `json:"approvedActiveContentDigest,omitempty"`
	ApprovedPolicyVersion       string `json:"approvedPolicyVersion,omitempty"`
	BootstrapIntentJSON         string `json:"bootstrapIntentJson,omitempty"`
	ExpectedCurrentReleaseRoot  string `json:"expectedCurrentReleaseRoot"`
	IdempotencyKey              string `json:"idempotencyKey"`
	Operation                   string `json:"operation"`
	ProjectIdentity             string `json:"projectIdentity"`
	ProjectPath                 string `json:"projectPath"`
	RunID                       string `json:"runId"`
	SchemaVersion               int    `json:"schemaVersion"`
	TargetReleaseRoot           string `json:"targetReleaseRoot,omitempty"`
	Traceparent                 string `json:"traceparent"`
}

type Progress struct {
	CompletedBytes int64  `json:"completedBytes"`
	Phase          string `json:"phase"`
	RunID          string `json:"runId"`
	SchemaVersion  int    `json:"schemaVersion"`
	Sequence       int64  `json:"sequence"`
	TotalBytes     int64  `json:"totalBytes"`
}

func DecodeOperationRequest(raw []byte) (OperationRequest, error) {
	if len(raw) == 0 || len(raw) > maxOperationRequestBytes {
		return OperationRequest{}, fmt.Errorf("package operation request size is invalid")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	var request OperationRequest
	if err := decoder.Decode(&request); err != nil {
		return OperationRequest{}, fmt.Errorf("decode package operation request: %w", err)
	}
	if err := requireJSONEnd(decoder); err != nil {
		return OperationRequest{}, err
	}
	if err := validateOperationRequest(request); err != nil {
		return OperationRequest{}, err
	}
	return request, nil
}

func validateOperationRequest(request OperationRequest) error {
	if request.SchemaVersion != OperationRequestSchemaVersion ||
		!safeIdentifierPattern.MatchString(request.RunID) ||
		!safeIdentifierPattern.MatchString(request.AliasID) ||
		!safeIdentifierPattern.MatchString(request.IdempotencyKey) ||
		!isDigest(request.ExpectedCurrentReleaseRoot) ||
		!isOptionalDigest(request.TargetReleaseRoot) ||
		!isOptionalBootstrapIntent(request.BootstrapIntentJSON) ||
		!isDigest(request.ProjectIdentity) ||
		!filepath.IsAbs(request.ProjectPath) ||
		strings.ContainsRune(request.ProjectPath, '\x00') ||
		!validTraceparent(request.Traceparent) {
		return fmt.Errorf("package operation request binding is invalid")
	}
	switch request.Operation {
	case "install", "preflight", "recover", "repair", "rollback", "uninstall", "update":
	default:
		return fmt.Errorf("package operation is invalid")
	}
	hasApproval := request.ApprovedActiveContentDigest != "" ||
		request.ApprovedPolicyVersion != ""
	if request.Operation == "preflight" {
		if hasApproval {
			return fmt.Errorf("package preflight approval must be absent")
		}
	} else if !isDigest(request.ApprovedActiveContentDigest) ||
		strings.TrimSpace(request.ApprovedPolicyVersion) == "" ||
		len([]byte(request.ApprovedPolicyVersion)) > 128 {
		return fmt.Errorf("package content approval is required")
	}
	return nil
}

func isOptionalBootstrapIntent(value string) bool {
	if value == "" {
		return true
	}
	if len(value) > 16*1024 || !json.Valid([]byte(value)) {
		return false
	}
	var intent map[string]json.RawMessage
	return json.Unmarshal([]byte(value), &intent) == nil && intent != nil
}

func requireJSONEnd(decoder *json.Decoder) error {
	var trailing json.RawMessage
	if err := decoder.Decode(&trailing); err != io.EOF {
		if err == nil {
			return fmt.Errorf("package operation request contains trailing JSON")
		}
		return fmt.Errorf("decode package operation request trailer: %w", err)
	}
	return nil
}

func isDigest(value string) bool {
	if len(value) != 64 || strings.ToLower(value) != value {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil
}

func isOptionalDigest(value string) bool {
	return value == "" || isDigest(value)
}

func validTraceparent(value string) bool {
	match := traceparentPattern.FindStringSubmatch(value)
	return match != nil &&
		match[1] != "00000000000000000000000000000000" &&
		match[2] != "0000000000000000"
}

type connectionAuthorization struct {
	ExpiresAt time.Time
	Token     string

	clientPID uint32
	clientSID string
	consumed  bool
	mu        sync.Mutex
}

func newConnectionAuthorization(
	clientSID string,
	clientPID uint32,
	now time.Time,
) (*connectionAuthorization, error) {
	if strings.TrimSpace(clientSID) == "" || clientPID == 0 {
		return nil, fmt.Errorf("named-pipe client identity is invalid")
	}
	token := make([]byte, 32)
	if _, err := rand.Read(token); err != nil {
		return nil, fmt.Errorf("create local operation authorization: %w", err)
	}
	return &connectionAuthorization{
		ExpiresAt: now.Add(connectionAuthorizationLifetime),
		Token:     base64.RawURLEncoding.EncodeToString(token),
		clientPID: clientPID,
		clientSID: clientSID,
	}, nil
}

func (authorization *connectionAuthorization) Consume(
	token string,
	clientSID string,
	clientPID uint32,
	now time.Time,
) error {
	if authorization == nil {
		return fmt.Errorf("local operation authorization is unavailable")
	}
	authorization.mu.Lock()
	defer authorization.mu.Unlock()
	presented, presentErr := base64.RawURLEncoding.DecodeString(token)
	expected, expectedErr := base64.RawURLEncoding.DecodeString(authorization.Token)
	validToken := presentErr == nil &&
		expectedErr == nil &&
		len(presented) == len(expected) &&
		subtle.ConstantTimeCompare(presented, expected) == 1
	if authorization.consumed ||
		!now.Before(authorization.ExpiresAt) ||
		clientSID != authorization.clientSID ||
		clientPID != authorization.clientPID ||
		!validToken {
		return fmt.Errorf("local operation authorization is invalid or expired")
	}
	authorization.consumed = true
	return nil
}
