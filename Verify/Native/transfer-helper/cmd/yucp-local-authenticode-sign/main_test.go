package main

import (
	"encoding/json"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestSignerReturnsTheExactReleasePublisherIdentity(t *testing.T) {
	moduleRoot := filepath.Clean(filepath.Join(filepath.Dir(currentSourcePath(t)), "..", ".."))
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
	build.Env = append(build.Environ(), "CGO_ENABLED=0", "GOARCH=amd64", "GOOS=windows")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build Windows fixture: %v\n%s", err, output)
	}

	subject := "CN=YUCP Local Development signer-result-test"
	run := exec.Command(
		goExecutable,
		"run",
		"./cmd/yucp-local-authenticode-sign",
		"--subject",
		subject,
		"--artifact",
		artifactPath,
	)
	run.Dir = moduleRoot
	output, err := run.Output()
	if err != nil {
		t.Fatalf("run signer: %v", err)
	}
	var result struct {
		CertificateSHA256 string `json:"certificateSha256"`
		Subject           string `json:"subject"`
	}
	if err := json.Unmarshal(output, &result); err != nil {
		t.Fatalf("decode signer result: %v", err)
	}
	if len(result.CertificateSHA256) != 64 ||
		result.CertificateSHA256 != strings.ToLower(result.CertificateSHA256) {
		t.Fatalf("certificateSha256 = %q", result.CertificateSHA256)
	}
	if result.Subject != subject {
		t.Fatalf("subject = %q, want %q", result.Subject, subject)
	}

	verify := exec.Command(
		goExecutable,
		"run",
		"./cmd/yucp-local-authenticode-sign",
		"--verify",
		"--subject",
		result.Subject,
		"--certificate-sha256",
		result.CertificateSHA256,
		"--artifact",
		artifactPath,
	)
	verify.Dir = moduleRoot
	if output, err := verify.CombinedOutput(); err != nil {
		t.Fatalf("verify signed artifact: %v\n%s", err, output)
	}
}

func currentSourcePath(t *testing.T) string {
	t.Helper()
	_, sourcePath, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve test source path")
	}
	return sourcePath
}
