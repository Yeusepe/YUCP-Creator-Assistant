package trust

import (
	"encoding/base64"
	"strings"
	"testing"
)

func TestParseAcceptsPurposeSeparatedSigningAuthorities(t *testing.T) {
	key := base64.RawURLEncoding.EncodeToString(make([]byte, 32))
	document, err := Parse([]byte(`{
		"schemaVersion": 1,
		"packageInstall": {
			"keyId": "install-2026-01",
			"publicKey": "` + key + `"
		},
		"materializationReceipt": {
			"keyId": "receipt-2026-01",
			"publicKey": "` + key + `"
		}
	}`))
	if err != nil {
		t.Fatalf("Parse() error = %v", err)
	}
	if string(document.PackageInstall.KeyID) != "install-2026-01" ||
		string(document.MaterializationReceipt.KeyID) != "receipt-2026-01" ||
		len(document.PackageInstall.PublicKey) != 32 {
		t.Fatalf("Parse() = %#v", document)
	}
}

func TestParseRejectsUnknownFieldsAndSharedPurposeKeys(t *testing.T) {
	key := base64.RawURLEncoding.EncodeToString(make([]byte, 32))
	for name, data := range map[string]string{
		"unknown": `{"schemaVersion":1,"packageInstall":{"keyId":"a","publicKey":"` +
			key + `"},"materializationReceipt":{"keyId":"b","publicKey":"` + key + `"},"extra":true}`,
		"shared key identifier": `{"schemaVersion":1,"packageInstall":{"keyId":"same","publicKey":"` +
			key + `"},"materializationReceipt":{"keyId":"same","publicKey":"` + key + `"}}`,
	} {
		t.Run(strings.ReplaceAll(name, " ", "_"), func(t *testing.T) {
			if _, err := Parse([]byte(data)); err == nil {
				t.Fatalf("Parse() accepted %s", name)
			}
		})
	}
}
