package broker

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestDecodeOperationRequestAcceptsOnlyHighLevelFields(t *testing.T) {
	raw := []byte(`{
		"schemaVersion":3,
		"runId":"run-jammr-install-1",
		"aliasId":"jammr",
		"expectedCurrentReleaseRoot":"` + strings.Repeat("00", 32) + `",
		"targetReleaseRoot":"` + strings.Repeat("11", 32) + `",
		"operation":"install",
		"projectPath":"C:\\Unity\\Project",
		"projectIdentity":"` + strings.Repeat("22", 32) + `",
		"approvedActiveContentDigest":"` + strings.Repeat("33", 32) + `",
		"approvedPolicyVersion":"active-content-policy-v1",
		"idempotencyKey":"install-jammr-1",
		"traceparent":"00-0123456789abcdef0123456789abcdef-0123456789abcdef-01"
	}`)

	request, err := DecodeOperationRequest(raw)
	if err != nil {
		t.Fatalf("DecodeOperationRequest() error = %v", err)
	}
	encoded, err := json.Marshal(request)
	if err != nil {
		t.Fatalf("json.Marshal() error = %v", err)
	}
	for _, forbidden := range []string{
		"accessToken",
		"refreshToken",
		"privateKey",
		"installSession",
		"deliveryGrant",
		"tufMetadataUrl",
		"tufRootPath",
		"tufTargetsUrl",
		"tufTrustTarget",
		"catalogProductIds",
		"provider",
	} {
		if bytes.Contains(encoded, []byte(`"`+forbidden+`"`)) {
			t.Fatalf("operation request exposes forbidden field %q: %s", forbidden, encoded)
		}
	}
}

func TestDecodeOperationRequestRejectsUnknownAndMissingBindings(t *testing.T) {
	valid := `{
		"schemaVersion":3,
		"runId":"run-jammr-preflight-1",
		"aliasId":"jammr",
		"expectedCurrentReleaseRoot":"` + strings.Repeat("00", 32) + `",
		"operation":"preflight",
		"projectPath":"C:\\Unity\\Project",
		"projectIdentity":"` + strings.Repeat("22", 32) + `",
		"idempotencyKey":"preflight-jammr-1",
		"traceparent":"00-0123456789abcdef0123456789abcdef-0123456789abcdef-01"
	}`
	if _, err := DecodeOperationRequest([]byte(strings.Replace(
		valid,
		`"schemaVersion":3`,
		`"schemaVersion":3,"installSession":"secret"`,
		1,
	))); err == nil {
		t.Fatal("DecodeOperationRequest() accepted a secret legacy field")
	}
	if _, err := DecodeOperationRequest([]byte(strings.Replace(
		valid,
		`"expectedCurrentReleaseRoot":"`+strings.Repeat("00", 32)+`",`,
		"",
		1,
	))); err == nil {
		t.Fatal("DecodeOperationRequest() accepted a missing current release root")
	}
	if _, err := DecodeOperationRequest([]byte(strings.Replace(
		valid,
		`"operation":"preflight"`,
		`"operation":"install"`,
		1,
	))); err == nil {
		t.Fatal("DecodeOperationRequest() accepted an install without content approval")
	}
}

func TestConnectionAuthorizationIsFreshBoundAndOneUse(t *testing.T) {
	now := time.Unix(1_000, 0)
	authorization, err := newConnectionAuthorization("S-1-5-21-test", 42, now)
	if err != nil {
		t.Fatalf("newConnectionAuthorization() error = %v", err)
	}
	if err := authorization.Consume(
		authorization.Token,
		"S-1-5-21-test",
		42,
		now.Add(10*time.Second),
	); err != nil {
		t.Fatalf("Consume() error = %v", err)
	}
	if err := authorization.Consume(
		authorization.Token,
		"S-1-5-21-test",
		42,
		now.Add(11*time.Second),
	); err == nil {
		t.Fatal("Consume() accepted a replay")
	}

	expired, err := newConnectionAuthorization("S-1-5-21-test", 42, now)
	if err != nil {
		t.Fatalf("newConnectionAuthorization() error = %v", err)
	}
	if err := expired.Consume(
		expired.Token,
		"S-1-5-21-test",
		42,
		now.Add(connectionAuthorizationLifetime+time.Second),
	); err == nil {
		t.Fatal("Consume() accepted an expired authorization")
	}
}
