package packagecontract

import (
	"bytes"
	"testing"
	"time"
)

func TestParseInstallSessionAndDeliveryGrant(t *testing.T) {
	deviceKey := bytes.Repeat([]byte{0x33}, 32)
	releaseRoot := bytes.Repeat([]byte{0x11}, 32)
	bindingRoot := bytes.Repeat([]byte{0x22}, 32)
	manifestDigest := bytes.Repeat([]byte{0x44}, 32)
	sessionPayload := mustInstallCanonical(t, map[any]any{
		int64(0):  int64(2),
		int64(1):  InstallSessionTokenType,
		int64(2):  "http://127.0.0.1:3001",
		int64(3):  "http://127.0.0.1:3003",
		int64(4):  "test-key",
		int64(5):  "creator-1",
		int64(6):  "buyer-1",
		int64(7):  "product-1",
		int64(8):  "1.0.0",
		int64(9):  "alias-1",
		int64(10): releaseRoot,
		int64(11): bindingRoot,
		int64(12): deviceKey,
		int64(13): []any{"http://127.0.0.1:3001"},
		int64(14): []any{"http://127.0.0.1:3003"},
		int64(15): []any{map[any]any{
			int64(0): "logical-tree-manifest-v4",
			int64(1): "http://127.0.0.1:3003/v2/delivery/version-1/manifest",
			int64(2): manifestDigest,
		}},
		int64(16): int64(1_800_000_000),
		int64(17): int64(1_800_000_000),
		int64(18): int64(1_800_000_300),
		int64(19): "session-1",
		int64(20): int64(300),
		int64(21): "install",
	})
	session, err := ParseInstallSession(sessionPayload)
	if err != nil {
		t.Fatalf("ParseInstallSession() error = %v", err)
	}
	if session.AliasID != "alias-1" ||
		session.Operation != "install" ||
		session.Version != "1.0.0" ||
		session.Bootstrap.URL != "http://127.0.0.1:3003/v2/delivery/version-1/manifest" ||
		!bytes.Equal(session.DeviceKeyThumbprint[:], deviceKey) {
		t.Fatalf("ParseInstallSession() = %#v", session)
	}

	grantPayload := mustInstallCanonical(t, map[any]any{
		int64(0):  int64(2),
		int64(1):  "grant-1",
		int64(2):  "http://127.0.0.1:3001",
		int64(3):  "http://127.0.0.1:3003",
		int64(4):  "creator-1",
		int64(5):  "buyer-1",
		int64(6):  "product-1",
		int64(7):  releaseRoot,
		int64(8):  bindingRoot,
		int64(9):  deviceKey,
		int64(10): int64(1_800_000_000),
		int64(11): int64(1_800_000_000),
		int64(12): int64(1_800_000_300),
		int64(13): []any{"materialization:job-1:read", "package:version-1:read"},
		int64(14): "session-1",
	})
	grant, err := ParseDeliveryGrant(grantPayload)
	if err != nil {
		t.Fatalf("ParseDeliveryGrant() error = %v", err)
	}
	if grant.GrantID != "grant-1" ||
		grant.InstallSessionID != session.SessionID ||
		grant.MaterializationJobID() != "job-1" {
		t.Fatalf("ParseDeliveryGrant() = %#v", grant)
	}
	if err := ValidateInstallAuthorization(session, grant, InstallAuthorizationContext{
		AliasID:             "alias-1",
		DeviceKeyThumbprint: deviceKey,
		ExpectedReleaseRoot: releaseRoot,
		Now:                 time.Unix(1_800_000_001, 0),
		Operation:           "install",
	}); err != nil {
		t.Fatalf("ValidateInstallAuthorization() error = %v", err)
	}
}

func TestValidateInstallAuthorizationRejectsExpiredOrSubstitutedTokens(t *testing.T) {
	session := InstallSession{
		AliasID:             "alias-1",
		Audience:            "https://delivery.example.test",
		BindingRoot:         [32]byte{0x22},
		DeviceKeyThumbprint: [32]byte{0x33},
		ExpiresAt:           100,
		Issuer:              "https://api.example.test",
		NotBefore:           50,
		Operation:           "install",
		ReleaseRoot:         [32]byte{0x11},
		SessionID:           "session-1",
	}
	grant := DeliveryGrant{
		Audience:            session.Audience,
		BindingRoot:         session.BindingRoot,
		DeviceKeyThumbprint: session.DeviceKeyThumbprint,
		ExpiresAt:           100,
		InstallSessionID:    "other-session",
		Issuer:              session.Issuer,
		NotBefore:           50,
		ReleaseRoot:         session.ReleaseRoot,
	}
	if err := ValidateInstallAuthorization(session, grant, InstallAuthorizationContext{
		AliasID:             session.AliasID,
		DeviceKeyThumbprint: session.DeviceKeyThumbprint[:],
		ExpectedReleaseRoot: session.ReleaseRoot[:],
		Now:                 time.Unix(75, 0),
		Operation:           "preflight",
	}); err == nil {
		t.Fatal("ValidateInstallAuthorization() accepted a substituted grant")
	}
}

func TestValidateInstallAuthorizationSeparatesReadAndUninstallScopes(t *testing.T) {
	session := InstallSession{
		AliasID:             "alias-1",
		Audience:            "https://delivery.example.test",
		BindingRoot:         [32]byte{0x22},
		BuyerID:             "buyer-1",
		CreatorID:           "creator-1",
		DeviceKeyThumbprint: [32]byte{0x33},
		ExpiresAt:           100,
		Issuer:              "https://api.example.test",
		NotBefore:           50,
		Operation:           "uninstall",
		ProductID:           "product-1",
		ReleaseRoot:         [32]byte{0x11},
		SessionID:           "session-1",
	}
	grant := DeliveryGrant{
		Audience:            session.Audience,
		BindingRoot:         session.BindingRoot,
		BuyerID:             session.BuyerID,
		CreatorID:           session.CreatorID,
		DeviceKeyThumbprint: session.DeviceKeyThumbprint,
		ExpiresAt:           100,
		InstallSessionID:    session.SessionID,
		Issuer:              session.Issuer,
		NotBefore:           50,
		ProductID:           session.ProductID,
		ReleaseRoot:         session.ReleaseRoot,
		Scopes:              []string{"package:version-1:uninstall"},
	}
	context := InstallAuthorizationContext{
		AliasID:             session.AliasID,
		DeviceKeyThumbprint: session.DeviceKeyThumbprint[:],
		ExpectedReleaseRoot: session.ReleaseRoot[:],
		Now:                 time.Unix(75, 0),
		Operation:           "uninstall",
	}

	if err := ValidateInstallAuthorization(session, grant, context); err != nil {
		t.Fatalf("ValidateInstallAuthorization(uninstall) error = %v", err)
	}
	grant.Scopes = []string{"package:version-1:read"}
	if err := ValidateInstallAuthorization(session, grant, context); err == nil {
		t.Fatal("ValidateInstallAuthorization() accepted package read for uninstall")
	}
	grant.Scopes = []string{
		"package:version-1:read",
		"package:version-1:uninstall",
	}
	if err := ValidateInstallAuthorization(session, grant, context); err == nil {
		t.Fatal("ValidateInstallAuthorization() accepted mixed package scopes")
	}
}

func mustInstallCanonical(t *testing.T, value any) []byte {
	t.Helper()
	data, err := EncodeCanonical(value)
	if err != nil {
		t.Fatalf("EncodeCanonical() error = %v", err)
	}
	return data
}

func installAuthorizationFixture() (InstallSession, DeliveryGrant, InstallAuthorizationContext) {
	session := InstallSession{
		AliasID:             "alias-1",
		Audience:            "https://delivery.example.test",
		BindingRoot:         [32]byte{0x22},
		BuyerID:             "buyer-1",
		CreatorID:           "creator-1",
		DeviceKeyThumbprint: [32]byte{0x33},
		ExpiresAt:           1_000_300,
		Issuer:              "https://api.example.test",
		NotBefore:           1_000_000,
		Operation:           "preflight",
		ProductID:           "product-1",
		ReleaseRoot:         [32]byte{0x11},
		SessionID:           "session-1",
	}
	grant := DeliveryGrant{
		Audience:            session.Audience,
		BindingRoot:         session.BindingRoot,
		BuyerID:             session.BuyerID,
		CreatorID:           session.CreatorID,
		DeviceKeyThumbprint: session.DeviceKeyThumbprint,
		ExpiresAt:           session.ExpiresAt,
		GrantID:             "grant-1",
		InstallSessionID:    session.SessionID,
		Issuer:              session.Issuer,
		NotBefore:           session.NotBefore,
		ProductID:           session.ProductID,
		ReleaseRoot:         session.ReleaseRoot,
		Scopes:              []string{"materialization:job-1:read", "package:version-1:read"},
	}
	context := InstallAuthorizationContext{
		AliasID:             session.AliasID,
		DeviceKeyThumbprint: session.DeviceKeyThumbprint[:],
		ExpectedReleaseRoot: session.ReleaseRoot[:],
		Now:                 time.Unix(session.NotBefore, 0),
		Operation:           session.Operation,
	}
	return session, grant, context
}

func TestValidateInstallAuthorizationToleratesClockBehindIssuer(t *testing.T) {
	session, grant, context := installAuthorizationFixture()
	for _, secondsBehind := range []int64{1, 30, installAuthorizationStartLeewaySeconds} {
		context.Now = time.Unix(session.NotBefore-secondsBehind, 0)
		if err := ValidateInstallAuthorization(session, grant, context); err != nil {
			t.Fatalf("clock %ds behind rejected: %v", secondsBehind, err)
		}
	}
}

func TestValidateInstallAuthorizationRejectsClockBeyondLeeway(t *testing.T) {
	session, grant, context := installAuthorizationFixture()
	context.Now = time.Unix(
		session.NotBefore-installAuthorizationStartLeewaySeconds-1,
		0,
	)
	if err := ValidateInstallAuthorization(session, grant, context); err == nil {
		t.Fatal("a clock beyond the leeway was accepted")
	}
}

func TestValidateInstallAuthorizationStillRejectsExpiredWindow(t *testing.T) {
	session, grant, context := installAuthorizationFixture()
	context.Now = time.Unix(session.ExpiresAt, 0)
	if err := ValidateInstallAuthorization(session, grant, context); err == nil {
		t.Fatal("an expired authorization was accepted")
	}
	session, grant, context = installAuthorizationFixture()
	grant.ExpiresAt = session.NotBefore + 10
	context.Now = time.Unix(grant.ExpiresAt, 0)
	if err := ValidateInstallAuthorization(session, grant, context); err == nil {
		t.Fatal("an expired grant was accepted")
	}
}
