package dpop

import (
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math/big"
	"net"
	"net/url"
	"strings"
	"time"
)

type publicJWK struct {
	Curve string `json:"crv"`
	Type  string `json:"kty"`
	X     string `json:"x"`
	Y     string `json:"y"`
}

type proofHeader struct {
	Algorithm string    `json:"alg"`
	JWK       publicJWK `json:"jwk"`
	Type      string    `json:"typ"`
}

type proofPayload struct {
	AccessTokenHash string `json:"ath"`
	Method          string `json:"htm"`
	URL             string `json:"htu"`
	IssuedAt        int64  `json:"iat"`
	Identifier      string `json:"jti"`
}

func CreateProof(
	privateKey *ecdsa.PrivateKey,
	method string,
	targetURL string,
	accessToken string,
	now time.Time,
) (string, error) {
	if privateKey == nil ||
		privateKey.Curve == nil ||
		privateKey.Curve.Params().Name != "P-256" {
		return "", fmt.Errorf("DPoP private key must use P-256")
	}
	canonicalURL, err := canonicalTargetURL(targetURL)
	if err != nil {
		return "", err
	}
	method = strings.ToUpper(strings.TrimSpace(method))
	if method == "" || strings.ContainsAny(method, " \t\r\n") {
		return "", fmt.Errorf("DPoP HTTP method is invalid")
	}
	if accessToken == "" {
		return "", fmt.Errorf("DPoP access token is required")
	}
	x := base64.RawURLEncoding.EncodeToString(
		privateKey.PublicKey.X.FillBytes(make([]byte, 32)),
	)
	y := base64.RawURLEncoding.EncodeToString(
		privateKey.PublicKey.Y.FillBytes(make([]byte, 32)),
	)
	header, err := json.Marshal(proofHeader{
		Algorithm: "ES256",
		JWK: publicJWK{
			Curve: "P-256",
			Type:  "EC",
			X:     x,
			Y:     y,
		},
		Type: "dpop+jwt",
	})
	if err != nil {
		return "", fmt.Errorf("encode DPoP protected header: %w", err)
	}
	tokenDigest := sha256.Sum256([]byte(accessToken))
	jti := make([]byte, 16)
	if _, err := rand.Read(jti); err != nil {
		return "", fmt.Errorf("create DPoP proof identifier: %w", err)
	}
	payload, err := json.Marshal(proofPayload{
		AccessTokenHash: base64.RawURLEncoding.EncodeToString(tokenDigest[:]),
		Method:          method,
		URL:             canonicalURL,
		IssuedAt:        now.Unix(),
		Identifier:      base64.RawURLEncoding.EncodeToString(jti),
	})
	if err != nil {
		return "", fmt.Errorf("encode DPoP claims: %w", err)
	}
	encodedHeader := base64.RawURLEncoding.EncodeToString(header)
	encodedPayload := base64.RawURLEncoding.EncodeToString(payload)
	signingInput := encodedHeader + "." + encodedPayload
	digest := sha256.Sum256([]byte(signingInput))
	r, s, err := ecdsa.Sign(rand.Reader, privateKey, digest[:])
	if err != nil {
		return "", fmt.Errorf("sign DPoP proof: %w", err)
	}
	signature := append(
		r.FillBytes(make([]byte, 32)),
		s.FillBytes(make([]byte, 32))...,
	)
	return signingInput + "." + base64.RawURLEncoding.EncodeToString(signature), nil
}

func canonicalTargetURL(raw string) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || !parsed.IsAbs() || parsed.Hostname() == "" {
		return "", fmt.Errorf("DPoP target URL is invalid")
	}
	if parsed.User != nil ||
		(parsed.Scheme != "https" &&
			!(parsed.Scheme == "http" && isLoopbackHost(parsed.Hostname()))) {
		return "", fmt.Errorf("DPoP target URL must use HTTPS or loopback HTTP")
	}
	parsed.RawQuery = ""
	parsed.ForceQuery = false
	parsed.Fragment = ""
	return parsed.String(), nil
}

func isLoopbackHost(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(strings.Trim(host, "[]"))
	return ip != nil && ip.IsLoopback()
}

func leftPad(value *big.Int) []byte {
	return value.FillBytes(make([]byte, 32))
}
