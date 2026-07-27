package trust

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"strings"
)

type Authority struct {
	KeyID     []byte
	PublicKey ed25519.PublicKey
}

type Document struct {
	MaterializationReceipt Authority
	PackageInstall         Authority
}

type encodedAuthority struct {
	KeyID     string `json:"keyId"`
	PublicKey string `json:"publicKey"`
}

type encodedDocument struct {
	MaterializationReceipt encodedAuthority `json:"materializationReceipt"`
	PackageInstall         encodedAuthority `json:"packageInstall"`
	SchemaVersion          int              `json:"schemaVersion"`
}

func Parse(data []byte) (Document, error) {
	if len(data) == 0 || len(data) > 64*1024 {
		return Document{}, fmt.Errorf("package install trust target has an invalid length")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var encoded encodedDocument
	if err := decoder.Decode(&encoded); err != nil {
		return Document{}, fmt.Errorf("decode package install trust target: %w", err)
	}
	if err := requireJSONEnd(decoder); err != nil {
		return Document{}, err
	}
	if encoded.SchemaVersion != 1 {
		return Document{}, fmt.Errorf("package install trust target schema version is invalid")
	}
	packageInstall, err := parseAuthority(encoded.PackageInstall, "packageInstall")
	if err != nil {
		return Document{}, err
	}
	receipt, err := parseAuthority(encoded.MaterializationReceipt, "materializationReceipt")
	if err != nil {
		return Document{}, err
	}
	if bytes.Equal(packageInstall.KeyID, receipt.KeyID) {
		return Document{}, fmt.Errorf("package install trust authorities must use distinct key identifiers")
	}
	return Document{
		MaterializationReceipt: receipt,
		PackageInstall:         packageInstall,
	}, nil
}

func parseAuthority(encoded encodedAuthority, name string) (Authority, error) {
	keyID := []byte(strings.TrimSpace(encoded.KeyID))
	if len(keyID) == 0 || len(keyID) > 64 || string(keyID) != encoded.KeyID {
		return Authority{}, fmt.Errorf("%s key identifier is invalid", name)
	}
	if encoded.PublicKey == "" || strings.Contains(encoded.PublicKey, "=") {
		return Authority{}, fmt.Errorf("%s public key must use unpadded base64url", name)
	}
	publicKey, err := base64.RawURLEncoding.DecodeString(encoded.PublicKey)
	if err != nil || len(publicKey) != ed25519.PublicKeySize {
		return Authority{}, fmt.Errorf("%s public key is invalid", name)
	}
	return Authority{
		KeyID:     append([]byte(nil), keyID...),
		PublicKey: ed25519.PublicKey(append([]byte(nil), publicKey...)),
	}, nil
}

func requireJSONEnd(decoder *json.Decoder) error {
	var extra any
	if err := decoder.Decode(&extra); err == io.EOF {
		return nil
	}
	return fmt.Errorf("package install trust target contains trailing JSON")
}
