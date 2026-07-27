package packagecontract

import (
	"bytes"
	"crypto/ed25519"
	"fmt"
	"regexp"
)

const (
	coseAlgorithmEdDSA = int64(-8)
	cosePurposeHeader  = int64(1001)
)

var contractPurposePattern = regexp.MustCompile(`^[a-z0-9-]+-v[0-9]+$`)

func VerifySign1(
	envelopeBytes []byte,
	publicKey ed25519.PublicKey,
	expectedKeyID []byte,
	expectedPurpose string,
) ([]byte, error) {
	if len(publicKey) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("COSE Ed25519 public key must contain %d bytes", ed25519.PublicKeySize)
	}
	if len(expectedKeyID) < 1 || len(expectedKeyID) > 64 {
		return nil, fmt.Errorf("COSE expected key ID must contain 1 through 64 bytes")
	}
	if !contractPurposePattern.MatchString(expectedPurpose) {
		return nil, fmt.Errorf("COSE expected purpose is invalid")
	}

	decoded, err := DecodeCanonical(envelopeBytes)
	if err != nil {
		return nil, err
	}
	envelope, err := requireArray(decoded, "COSE_Sign1")
	if err != nil {
		return nil, err
	}
	if len(envelope) != 4 {
		return nil, fmt.Errorf("COSE_Sign1 must contain four fields")
	}
	protectedBytes, err := requireBytes(envelope[0], "COSE_Sign1 protected headers", -1)
	if err != nil {
		return nil, err
	}
	unprotected, err := requireMap(envelope[1], "COSE_Sign1 unprotected headers")
	if err != nil {
		return nil, err
	}
	if len(unprotected) != 0 {
		return nil, fmt.Errorf("COSE_Sign1 unprotected headers must be empty")
	}
	payload, err := requireBytes(envelope[2], "COSE_Sign1 payload", -1)
	if err != nil {
		return nil, err
	}
	signature, err := requireBytes(envelope[3], "COSE_Sign1 signature", ed25519.SignatureSize)
	if err != nil {
		return nil, err
	}

	protectedValue, err := DecodeCanonical(protectedBytes)
	if err != nil {
		return nil, fmt.Errorf("decode COSE_Sign1 protected headers: %w", err)
	}
	protected, err := requireMap(protectedValue, "COSE_Sign1 protected headers")
	if err != nil {
		return nil, err
	}
	if err := requireExactIntegerLabels(
		protected,
		[]int64{1, 2, 4, cosePurposeHeader},
		"COSE_Sign1 protected headers",
	); err != nil {
		return nil, err
	}
	algorithm, err := requireInt(protected[int64(1)], "COSE algorithm")
	if err != nil {
		return nil, err
	}
	if algorithm != coseAlgorithmEdDSA {
		return nil, fmt.Errorf("COSE_Sign1 algorithm is not EdDSA")
	}
	critical, err := requireArray(protected[int64(2)], "COSE critical headers")
	if err != nil {
		return nil, err
	}
	if len(critical) != 1 {
		return nil, fmt.Errorf("COSE_Sign1 purpose header is not critical")
	}
	criticalPurpose, err := requireInt(critical[0], "COSE purpose critical header")
	if err != nil || criticalPurpose != cosePurposeHeader {
		return nil, fmt.Errorf("COSE_Sign1 purpose header is not critical")
	}
	keyID, err := requireBytes(protected[int64(4)], "COSE key ID", -1)
	if err != nil {
		return nil, err
	}
	if !bytes.Equal(keyID, expectedKeyID) {
		return nil, fmt.Errorf("COSE_Sign1 key ID is not trusted")
	}
	purpose, err := requireString(protected[cosePurposeHeader], "COSE purpose")
	if err != nil {
		return nil, err
	}
	if purpose != expectedPurpose {
		return nil, fmt.Errorf("COSE_Sign1 purpose does not match the expected contract")
	}
	if _, err := DecodeCanonical(payload); err != nil {
		return nil, fmt.Errorf("decode COSE_Sign1 payload: %w", err)
	}
	signatureStructure, err := EncodeCanonical([]any{
		"Signature1",
		protectedBytes,
		[]byte{},
		payload,
	})
	if err != nil {
		return nil, fmt.Errorf("encode COSE_Sign1 signature structure: %w", err)
	}
	if !ed25519.Verify(publicKey, signatureStructure, signature) {
		return nil, fmt.Errorf("COSE_Sign1 signature is invalid")
	}
	return payload, nil
}
