package dpop

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"strings"
	"testing"
	"time"
)

type repeatingEntropyReader byte

func (reader repeatingEntropyReader) Read(destination []byte) (int, error) {
	for index := range destination {
		destination[index] = byte(reader)
	}
	return len(destination), nil
}

func TestCreateProofBindsMethodURLTokenAndPublicKey(t *testing.T) {
	privateKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("GenerateKey() error = %v", err)
	}
	now := time.Unix(1_800_000_000, 0)
	proof, err := CreateProof(
		privateKey,
		"get",
		"http://127.0.0.1:3003/v2/delivery/version-1/chunks/abc?ignored=1",
		"delivery-grant",
		now,
	)
	if err != nil {
		t.Fatalf("CreateProof() error = %v", err)
	}
	parts := strings.Split(proof, ".")
	if len(parts) != 3 {
		t.Fatalf("proof parts = %d, want 3", len(parts))
	}
	var header struct {
		Algorithm string          `json:"alg"`
		JWK       json.RawMessage `json:"jwk"`
		Type      string          `json:"typ"`
	}
	if err := decodePart(parts[0], &header); err != nil {
		t.Fatalf("decode proof header: %v", err)
	}
	if header.Algorithm != "ES256" || header.Type != "dpop+jwt" {
		t.Fatalf("proof header = %#v", header)
	}
	var payload struct {
		AccessTokenHash string `json:"ath"`
		Method          string `json:"htm"`
		URL             string `json:"htu"`
		IssuedAt        int64  `json:"iat"`
		Identifier      string `json:"jti"`
	}
	if err := decodePart(parts[1], &payload); err != nil {
		t.Fatalf("decode proof payload: %v", err)
	}
	tokenDigest := sha256.Sum256([]byte("delivery-grant"))
	if payload.AccessTokenHash != base64.RawURLEncoding.EncodeToString(tokenDigest[:]) ||
		payload.Method != "GET" ||
		payload.URL != "http://127.0.0.1:3003/v2/delivery/version-1/chunks/abc" ||
		payload.IssuedAt != now.Unix() ||
		payload.Identifier == "" {
		t.Fatalf("proof payload = %#v", payload)
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil || len(signature) != 64 {
		t.Fatalf("proof signature is invalid: %v", err)
	}
	digest := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	if !ecdsa.Verify(
		&privateKey.PublicKey,
		digest[:],
		new(big.Int).SetBytes(signature[:32]),
		new(big.Int).SetBytes(signature[32:]),
	) {
		t.Fatal("proof signature did not verify")
	}
}

func TestCreateProofIdentifierRemainsUniqueWhenEntropyRepeats(t *testing.T) {
	privateKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("GenerateKey() error = %v", err)
	}
	originalReader := rand.Reader
	rand.Reader = repeatingEntropyReader(0x42)
	defer func() {
		rand.Reader = originalReader
	}()

	identifiers := make([]string, 0, 2)
	for attempt := 0; attempt < 2; attempt++ {
		proof, err := CreateProof(
			privateKey,
			"POST",
			"https://api.example.test/api/v2/package-installs/authorizations",
			"access-token",
			time.Unix(1_800_000_000, 0),
		)
		if err != nil {
			t.Fatalf("CreateProof() attempt %d error = %v", attempt, err)
		}
		parts := strings.Split(proof, ".")
		if len(parts) != 3 {
			t.Fatalf("proof parts = %d, want 3", len(parts))
		}
		var payload proofPayload
		if err := decodePart(parts[1], &payload); err != nil {
			t.Fatalf("decode proof payload: %v", err)
		}
		identifiers = append(identifiers, payload.Identifier)
	}
	if identifiers[0] == identifiers[1] {
		t.Fatalf("DPoP proof identifiers were reused: %q", identifiers[0])
	}
}

func TestCreateProofRejectsRemotePlaintextHTTP(t *testing.T) {
	privateKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("GenerateKey() error = %v", err)
	}
	if _, err := CreateProof(
		privateKey,
		"GET",
		"http://delivery.example.test/v2/chunk",
		"grant",
		time.Now(),
	); err == nil {
		t.Fatal("CreateProof() accepted remote plaintext HTTP")
	}
}

func TestCreateTokenProofOmitsAccessTokenHashAndBindsTokenEndpoint(t *testing.T) {
	privateKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("GenerateKey() error = %v", err)
	}
	proof, err := CreateTokenProof(
		privateKey,
		"https://auth.example.test/api/auth/oauth2/token",
		time.Unix(1_000, 0),
	)
	if err != nil {
		t.Fatalf("CreateTokenProof() error = %v", err)
	}
	parts := strings.Split(proof, ".")
	if len(parts) != 3 {
		t.Fatalf("proof parts = %d, want 3", len(parts))
	}
	var payload map[string]any
	if err := decodePart(parts[1], &payload); err != nil {
		t.Fatalf("decode proof payload: %v", err)
	}
	if _, exists := payload["ath"]; exists {
		t.Fatalf("token endpoint proof includes ath: %#v", payload)
	}
	if payload["htm"] != "POST" ||
		payload["htu"] != "https://auth.example.test/api/auth/oauth2/token" {
		t.Fatalf("token endpoint proof claims = %#v", payload)
	}
}

func decodePart(encoded string, destination any) error {
	bytes, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil {
		return err
	}
	return json.Unmarshal(bytes, destination)
}
