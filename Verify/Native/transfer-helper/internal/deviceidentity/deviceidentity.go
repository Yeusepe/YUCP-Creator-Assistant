package deviceidentity

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const deviceKeyFileName = "device-key-v1.protected"

type Identity struct {
	PrivateKey *ecdsa.PrivateKey
	Thumbprint string
}

func LoadOrCreate(stateRoot string) (Identity, error) {
	root, err := requireAbsoluteDirectory(stateRoot)
	if err != nil {
		return Identity{}, err
	}
	if err := os.MkdirAll(root, 0o700); err != nil {
		return Identity{}, fmt.Errorf("create device state root: %w", err)
	}
	keyPath := filepath.Join(root, deviceKeyFileName)
	protected, err := os.ReadFile(keyPath)
	switch {
	case err == nil:
		return decodeIdentity(protected)
	case !errors.Is(err, os.ErrNotExist):
		return Identity{}, fmt.Errorf("read protected device key: %w", err)
	}

	privateKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return Identity{}, fmt.Errorf("generate device key: %w", err)
	}
	encoded, err := x509.MarshalECPrivateKey(privateKey)
	if err != nil {
		return Identity{}, fmt.Errorf("encode device key: %w", err)
	}
	protected, err = protect(encoded)
	if err != nil {
		return Identity{}, fmt.Errorf("protect device key: %w", err)
	}
	if err := publishNewFile(keyPath, protected); err != nil {
		if !errors.Is(err, os.ErrExist) {
			return Identity{}, err
		}
		protected, readErr := os.ReadFile(keyPath)
		if readErr != nil {
			return Identity{}, fmt.Errorf("read concurrently created device key: %w", readErr)
		}
		return decodeIdentity(protected)
	}
	return identityFromPrivateKey(privateKey)
}

func decodeIdentity(protected []byte) (Identity, error) {
	encoded, err := unprotect(protected)
	if err != nil {
		return Identity{}, fmt.Errorf("unprotect device key: %w", err)
	}
	privateKey, err := x509.ParseECPrivateKey(encoded)
	if err != nil || privateKey.Curve != elliptic.P256() {
		return Identity{}, fmt.Errorf("protected device key is invalid")
	}
	return identityFromPrivateKey(privateKey)
}

func identityFromPrivateKey(privateKey *ecdsa.PrivateKey) (Identity, error) {
	x := base64.RawURLEncoding.EncodeToString(privateKey.PublicKey.X.FillBytes(make([]byte, 32)))
	y := base64.RawURLEncoding.EncodeToString(privateKey.PublicKey.Y.FillBytes(make([]byte, 32)))
	jwk, err := json.Marshal(struct {
		Crv string `json:"crv"`
		Kty string `json:"kty"`
		X   string `json:"x"`
		Y   string `json:"y"`
	}{
		Crv: "P-256",
		Kty: "EC",
		X:   x,
		Y:   y,
	})
	if err != nil {
		return Identity{}, fmt.Errorf("encode device public key: %w", err)
	}
	digest := sha256.Sum256(jwk)
	return Identity{
		PrivateKey: privateKey,
		Thumbprint: hex.EncodeToString(digest[:]),
	}, nil
}

func requireAbsoluteDirectory(raw string) (string, error) {
	if strings.TrimSpace(raw) == "" || !filepath.IsAbs(raw) {
		return "", fmt.Errorf("device state root must be absolute")
	}
	root, err := filepath.Abs(raw)
	if err != nil {
		return "", fmt.Errorf("resolve device state root: %w", err)
	}
	return root, nil
}

func publishNewFile(destination string, data []byte) error {
	temp, err := os.CreateTemp(filepath.Dir(destination), ".device-key-*.partial")
	if err != nil {
		return fmt.Errorf("create protected device key temporary file: %w", err)
	}
	tempPath := temp.Name()
	defer os.Remove(tempPath)
	if err := temp.Chmod(0o600); err != nil {
		_ = temp.Close()
		return fmt.Errorf("set protected device key permissions: %w", err)
	}
	if _, err := temp.Write(data); err != nil {
		_ = temp.Close()
		return fmt.Errorf("write protected device key: %w", err)
	}
	if err := temp.Sync(); err != nil {
		_ = temp.Close()
		return fmt.Errorf("synchronize protected device key: %w", err)
	}
	if err := temp.Close(); err != nil {
		return fmt.Errorf("close protected device key: %w", err)
	}
	if err := os.Link(tempPath, destination); err != nil {
		return fmt.Errorf("publish protected device key: %w", err)
	}
	return nil
}
