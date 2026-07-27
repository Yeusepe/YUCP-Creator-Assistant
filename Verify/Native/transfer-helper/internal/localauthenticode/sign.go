package localauthenticode

import (
	"bytes"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha1"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"errors"
	"fmt"
	"math/big"
	"os"
	"strings"
	"time"

	"github.com/foxboron/go-uefi/authenticode"
)

const localDevelopmentSubjectPrefix = "CN=YUCP Local Development "

// SignFiles uses go-uefi's Authenticode implementation so Linux development servers can publish
// the Windows client runtime. https://github.com/foxboron/go-uefi/tree/d29549a44f29/authenticode
func SignFiles(paths []string, subject string, now time.Time) (string, *x509.Certificate, error) {
	commonName, err := parseLocalDevelopmentCommonName(subject)
	if err != nil {
		return "", nil, err
	}
	if len(paths) == 0 {
		return "", nil, errors.New("at least one artifact is required")
	}

	privateKey, err := rsa.GenerateKey(rand.Reader, 3072)
	if err != nil {
		return "", nil, fmt.Errorf("generate local signing key: %w", err)
	}
	serialLimit := new(big.Int).Lsh(big.NewInt(1), 128)
	serial, err := rand.Int(rand.Reader, serialLimit)
	if err != nil {
		return "", nil, fmt.Errorf("generate local certificate serial: %w", err)
	}
	if serial.Sign() == 0 {
		serial.SetInt64(1)
	}
	template := &x509.Certificate{
		BasicConstraintsValid: true,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageCodeSigning},
		IsCA:                  false,
		KeyUsage:              x509.KeyUsageDigitalSignature,
		NotAfter:              now.UTC().Add(24 * time.Hour),
		NotBefore:             now.UTC().Add(-time.Minute),
		SerialNumber:          serial,
		Subject:               pkix.Name{CommonName: commonName},
	}
	certificateDER, err := x509.CreateCertificate(
		rand.Reader,
		template,
		template,
		&privateKey.PublicKey,
		privateKey,
	)
	if err != nil {
		return "", nil, fmt.Errorf("create local code-signing certificate: %w", err)
	}
	certificate, err := x509.ParseCertificate(certificateDER)
	if err != nil {
		return "", nil, fmt.Errorf("parse local code-signing certificate: %w", err)
	}

	for _, artifactPath := range paths {
		if err := signFile(artifactPath, privateKey, certificate); err != nil {
			return "", nil, err
		}
	}

	thumbprint := sha1.Sum(certificate.Raw)
	return strings.ToUpper(hex.EncodeToString(thumbprint[:])), certificate, nil
}

func parseLocalDevelopmentCommonName(subject string) (string, error) {
	if !strings.HasPrefix(subject, localDevelopmentSubjectPrefix) {
		return "", errors.New("local signing subject is outside the development trust domain")
	}
	commonName := strings.TrimPrefix(subject, "CN=")
	if strings.TrimSpace(commonName) != commonName || len(commonName) > 128 {
		return "", errors.New("local signing subject is invalid")
	}
	return commonName, nil
}

func signFile(
	artifactPath string,
	privateKey *rsa.PrivateKey,
	certificate *x509.Certificate,
) error {
	unsignedBytes, err := os.ReadFile(artifactPath)
	if err != nil {
		return fmt.Errorf("read local runtime artifact %q: %w", artifactPath, err)
	}
	image, err := authenticode.Parse(bytes.NewReader(unsignedBytes))
	if err != nil {
		return fmt.Errorf("parse local runtime artifact %q: %w", artifactPath, err)
	}
	if _, err := image.Sign(privateKey, certificate); err != nil {
		return fmt.Errorf("sign local runtime artifact %q: %w", artifactPath, err)
	}
	signedBytes := image.Bytes()
	verifiedImage, err := authenticode.Parse(bytes.NewReader(signedBytes))
	if err != nil {
		return fmt.Errorf("parse signed local runtime artifact %q: %w", artifactPath, err)
	}
	verified, err := verifiedImage.Verify(certificate)
	if err != nil {
		return fmt.Errorf("verify signed local runtime artifact %q: %w", artifactPath, err)
	}
	if !verified {
		return fmt.Errorf("verify signed local runtime artifact %q: digest mismatch", artifactPath)
	}

	temporaryPath := fmt.Sprintf("%s.%d.partial", artifactPath, os.Getpid())
	if err := os.WriteFile(temporaryPath, signedBytes, 0o600); err != nil {
		return fmt.Errorf("write signed local runtime artifact %q: %w", artifactPath, err)
	}
	defer os.Remove(temporaryPath)
	if err := os.Rename(temporaryPath, artifactPath); err != nil {
		return fmt.Errorf("publish signed local runtime artifact %q: %w", artifactPath, err)
	}
	if err := os.Chmod(artifactPath, 0o700); err != nil && !errors.Is(err, os.ErrPermission) {
		return fmt.Errorf("restrict signed local runtime artifact %q: %w", artifactPath, err)
	}
	return nil
}
