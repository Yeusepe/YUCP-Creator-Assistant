package localauthenticode

import (
	"bytes"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/foxboron/go-uefi/authenticode"
)

func TestSignFilesProducesVerifiableWindowsAuthenticode(t *testing.T) {
	moduleRoot := moduleRoot(t)
	artifactPath := filepath.Join(t.TempDir(), "fixture.exe")
	goExecutable := filepath.Join(runtime.GOROOT(), "bin", "go")
	if runtime.GOOS == "windows" {
		goExecutable += ".exe"
	}
	build := exec.Command(
		goExecutable,
		"build",
		"-trimpath",
		"-o",
		artifactPath,
		"./cmd/yucp-transfer-helper",
	)
	build.Dir = moduleRoot
	build.Env = append(os.Environ(), "CGO_ENABLED=0", "GOARCH=amd64", "GOOS=windows")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build Windows fixture: %v\n%s", err, output)
	}

	now := time.Date(2026, 7, 27, 12, 0, 0, 0, time.UTC)
	subject := "CN=YUCP Local Development portable-signing-test"
	thumbprint, certificate, err := SignFiles([]string{artifactPath}, subject, now)
	if err != nil {
		t.Fatalf("SignFiles() error = %v", err)
	}
	wantThumbprint := sha1.Sum(certificate.Raw)
	if thumbprint != strings.ToUpper(hex.EncodeToString(wantThumbprint[:])) {
		t.Fatalf("thumbprint = %q", thumbprint)
	}
	if certificate.Subject.CommonName != strings.TrimPrefix(subject, "CN=") {
		t.Fatalf("certificate subject = %q", certificate.Subject.String())
	}
	if certificate.NotAfter.Sub(certificate.NotBefore) > 25*time.Hour {
		t.Fatalf("certificate lifetime = %s", certificate.NotAfter.Sub(certificate.NotBefore))
	}

	signedBytes, err := os.ReadFile(artifactPath)
	if err != nil {
		t.Fatalf("read signed fixture: %v", err)
	}
	image, err := authenticode.Parse(bytes.NewReader(signedBytes))
	if err != nil {
		t.Fatalf("parse signed fixture: %v", err)
	}
	verified, err := image.Verify(certificate)
	if err != nil {
		t.Fatalf("verify signed fixture: %v", err)
	}
	if !verified {
		t.Fatal("signed fixture did not verify")
	}

	certificateSHA256 := sha256.Sum256(certificate.Raw)
	if err := VerifyFile(
		artifactPath,
		subject,
		hex.EncodeToString(certificateSHA256[:]),
		now.Add(time.Hour),
	); err != nil {
		t.Fatalf("VerifyFile() error = %v", err)
	}

	signedBytes[1024] ^= 0xff
	if err := os.WriteFile(artifactPath, signedBytes, 0o600); err != nil {
		t.Fatalf("tamper signed fixture: %v", err)
	}
	if err := VerifyFile(
		artifactPath,
		subject,
		hex.EncodeToString(certificateSHA256[:]),
		now.Add(time.Hour),
	); err == nil {
		t.Fatal("VerifyFile() accepted a modified artifact")
	}
}

func TestSignFilesRejectsSubjectsOutsideLocalDevelopmentTrust(t *testing.T) {
	_, _, err := SignFiles([]string{"unused.exe"}, "CN=Production Publisher", time.Now())
	if err == nil || !strings.Contains(err.Error(), "outside the development trust domain") {
		t.Fatalf("SignFiles() error = %v", err)
	}
}

func moduleRoot(t *testing.T) string {
	t.Helper()
	_, sourcePath, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve test source path")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(sourcePath), "..", ".."))
}
