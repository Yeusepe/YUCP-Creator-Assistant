//go:build windows

package runtimeinstaller

import (
	"bufio"
	"bytes"
	"context"
	"crypto"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/Microsoft/go-winio"
	"github.com/sigstore/sigstore/pkg/signature"
	"github.com/theupdateframework/go-tuf/v2/metadata"
	"github.com/yucp/transfer-helper/internal/tufrepository"
	"golang.org/x/sys/windows"
)

const (
	testBrokerTarget     = "broker/windows-amd64/yucp-package-broker.exe"
	testHelperTarget     = "helper/windows-amd64/yucp-transfer-helper.exe"
	testRuntimeTarget    = "runtime/windows-amd64/package-runtime.json"
	testTrustTarget      = "package-install-trust.json"
	testRuntimePlatform  = "windows-amd64"
	testRuntimeSchema    = 1
	testTrustSchema      = 1
	testMetadataVersion  = 77
	testBrokerReadyLimit = 20 * time.Second
)

func TestEnsureInstallsExactSignedRuntimeAndStartsBrokerOnCleanMachine(t *testing.T) {
	moduleRoot, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatalf("resolve native module root: %v", err)
	}
	rootBytes, err := os.ReadFile(
		filepath.Join(moduleRoot, "internal", "tufclient", "testdata", "1.root.json"),
	)
	if err != nil {
		t.Fatalf("read pinned TUF root: %v", err)
	}

	buildRoot := t.TempDir()
	sourceHelperPath := filepath.Join(buildRoot, "source", "yucp-transfer-helper.exe")
	sourceBrokerPath := filepath.Join(buildRoot, "source", "yucp-package-broker.exe")
	buildNativeCommand(t, moduleRoot, "./cmd/yucp-transfer-helper", sourceHelperPath)
	buildNativeCommand(t, moduleRoot, "./cmd/yucp-package-broker", sourceBrokerPath)
	sourceHelper := readRequiredFile(t, sourceHelperPath)
	sourceBroker := readRequiredFile(t, sourceBrokerPath)

	repositoryRoot := filepath.Join(buildRoot, "repository")
	server := httptest.NewServer(http.FileServer(http.Dir(repositoryRoot)))
	defer server.Close()
	pipeName := `\\.\pipe\yucp.package-broker.v1`
	runtimeDescriptor, err := json.Marshal(map[string]any{
		"apiBaseUrl":    server.URL,
		"authBaseUrl":   server.URL,
		"brokerTarget":  testBrokerTarget,
		"helperTarget":  testHelperTarget,
		"metadataUrl":   server.URL + "/metadata",
		"pipeName":      pipeName,
		"platform":      testRuntimePlatform,
		"schemaVersion": testRuntimeSchema,
		"targetsUrl":    server.URL + "/targets",
		"trustTarget":   testTrustTarget,
	})
	if err != nil {
		t.Fatalf("encode signed runtime descriptor: %v", err)
	}
	installKey := sha256.Sum256([]byte("clean runtime install key"))
	receiptKey := sha256.Sum256([]byte("clean runtime receipt key"))
	trustDocument, err := json.Marshal(map[string]any{
		"materializationReceipt": map[string]any{
			"keyId":     "receipt-key-1",
			"publicKey": base64.RawURLEncoding.EncodeToString(receiptKey[:]),
		},
		"packageInstall": map[string]any{
			"keyId":     "install-key-1",
			"publicKey": base64.RawURLEncoding.EncodeToString(installKey[:]),
		},
		"schemaVersion": testTrustSchema,
	})
	if err != nil {
		t.Fatalf("encode signed trust document: %v", err)
	}
	publishTestRuntimeRepository(
		t,
		repositoryRoot,
		rootBytes,
		[]tufrepository.Target{
			{Bytes: sourceBroker, Name: testBrokerTarget},
			{Bytes: sourceHelper, Name: testHelperTarget},
			{Bytes: runtimeDescriptor, Name: testRuntimeTarget},
			{Bytes: trustDocument, Name: testTrustTarget},
		},
	)

	installRoot := filepath.Join(buildRoot, "clean-install")
	stateRoot := filepath.Join(buildRoot, "clean-state")
	if _, err := os.Stat(installRoot); !os.IsNotExist(err) {
		t.Fatalf("clean install root unexpectedly exists: %v", err)
	}
	if connection, err := winio.DialPipe(pipeName, pointerDuration(100*time.Millisecond)); err == nil {
		_ = connection.Close()
		t.Fatal("broker pipe existed before runtime installation")
	}

	config := Config{
		InstallRoot:       installRoot,
		RemoteMetadataURL: server.URL + "/metadata",
		RemoteTargetsURL:  server.URL + "/targets",
		RuntimeTarget:     testRuntimeTarget,
		StartupTimeout:    testBrokerReadyLimit,
		StateRoot:         stateRoot,
		TrustedRoot:       rootBytes,
	}
	type ensureOutcome struct {
		result Result
		err    error
	}
	start := make(chan struct{})
	outcomes := make(chan ensureOutcome, 2)
	for range 2 {
		go func() {
			<-start
			result, ensureErr := Ensure(context.Background(), config)
			outcomes <- ensureOutcome{result: result, err: ensureErr}
		}()
	}
	close(start)
	first := <-outcomes
	second := <-outcomes
	if first.err != nil || second.err != nil {
		t.Fatalf("concurrent Ensure() errors = %v, %v", first.err, second.err)
	}
	result := first.result
	reusedConcurrent := second.result
	if !result.BrokerStarted {
		result, reusedConcurrent = reusedConcurrent, result
	}
	if !result.BrokerStarted ||
		reusedConcurrent.BrokerStarted ||
		result.BrokerProcessID < 1 ||
		reusedConcurrent.BrokerProcessID != result.BrokerProcessID {
		t.Fatalf(
			"concurrent Ensure() outcomes = %#v, %#v",
			result,
			reusedConcurrent,
		)
	}
	if !serverProcessMatches(
		pipeName,
		uint32(result.BrokerProcessID),
		result.BrokerPath,
	) {
		t.Fatal("active pipe server does not match the signed broker image")
	}
	t.Cleanup(func() {
		process, findErr := os.FindProcess(result.BrokerProcessID)
		if findErr == nil {
			_ = process.Kill()
			_, _ = process.Wait()
		}
	})

	installedHelper := readRequiredFile(t, result.HelperPath)
	installedBroker := readRequiredFile(t, result.BrokerPath)
	if !bytes.Equal(installedHelper, sourceHelper) {
		t.Fatal("installed helper differs from the exact signed TUF target")
	}
	if !bytes.Equal(installedBroker, sourceBroker) {
		t.Fatal("installed broker differs from the exact signed TUF target")
	}
	if result.HelperSHA256 != sha256Hex(sourceHelper) ||
		result.BrokerSHA256 != sha256Hex(sourceBroker) {
		t.Fatalf("installed runtime digests = %#v", result)
	}
	assertActiveRuntimeRecord(
		t,
		result.ActiveRecordPath,
		result,
		sha256Hex(runtimeDescriptor),
	)
	assertBrokerChallenge(t, pipeName)

	reused, err := Ensure(context.Background(), config)
	if err != nil {
		t.Fatalf("reuse Ensure() error = %v", err)
	}
	if reused.BrokerStarted || reused.BrokerProcessID != result.BrokerProcessID {
		t.Fatalf("reuse started another broker: %#v", reused)
	}
	mismatchedRoot := config
	mismatchedRoot.TrustedRoot = []byte(`{"signed":{"version":999}}`)
	if _, err := Ensure(context.Background(), mismatchedRoot); err == nil {
		t.Fatal("Ensure() reused a runtime under a different bootstrap root")
	}
	if err := os.WriteFile(result.HelperPath, []byte("tampered helper"), 0o700); err != nil {
		t.Fatalf("tamper installed helper: %v", err)
	}
	repaired, err := Ensure(context.Background(), config)
	if err != nil {
		t.Fatalf("repair Ensure() error = %v", err)
	}
	if repaired.BrokerStarted || repaired.BrokerProcessID != result.BrokerProcessID {
		t.Fatalf("repair started another broker: %#v", repaired)
	}
	if !bytes.Equal(readRequiredFile(t, repaired.HelperPath), sourceHelper) {
		t.Fatal("repair did not restore the exact signed helper")
	}
}

func TestParseDescriptorRejectsUnknownAndMutableRuntimeValues(t *testing.T) {
	metadataURL := "https://api.example.test/api/v2/package-installer/tuf/metadata"
	targetsURL := "https://api.example.test/api/v2/package-installer/tuf/targets"
	valid := []byte(
		`{"apiBaseUrl":"https://api.example.test","authBaseUrl":"https://auth.example.test/api/auth",` +
			`"brokerTarget":"broker/windows-amd64/yucp-package-broker.exe",` +
			`"helperTarget":"helper/windows-amd64/yucp-transfer-helper.exe",` +
			`"metadataUrl":"https://api.example.test/api/v2/package-installer/tuf/metadata",` +
			`"pipeName":"\\\\.\\pipe\\yucp.package-broker.v1","platform":"windows-amd64",` +
			`"schemaVersion":1,"targetsUrl":"https://api.example.test/api/v2/package-installer/tuf/targets",` +
			`"trustTarget":"package-install-trust.json"}`,
	)
	if _, err := parseDescriptor(valid, metadataURL, targetsURL); err != nil {
		t.Fatalf("parseDescriptor(valid) error = %v", err)
	}
	for name, raw := range map[string][]byte{
		"unknown field": bytes.Replace(
			valid,
			[]byte(`"schemaVersion":1`),
			[]byte(`"mutableExecutable":"evil.exe","schemaVersion":1`),
			1,
		),
		"transport substitution": bytes.Replace(
			valid,
			[]byte(metadataURL),
			[]byte("https://evil.example.test/metadata"),
			1,
		),
		"pipe substitution": bytes.Replace(
			valid,
			[]byte(`\\\\.\\pipe\\yucp.package-broker.v1`),
			[]byte(`\\\\.\\pipe\\attacker`),
			1,
		),
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := parseDescriptor(raw, metadataURL, targetsURL); err == nil {
				t.Fatal("parseDescriptor() accepted mutable signed runtime values")
			}
		})
	}
}

func buildNativeCommand(t *testing.T, moduleRoot string, command string, output string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(output), 0o700); err != nil {
		t.Fatalf("create native build directory: %v", err)
	}
	build := exec.Command("go", "build", "-trimpath", "-o", output, command)
	build.Dir = moduleRoot
	build.Env = append(os.Environ(), "GOFLAGS=-mod=readonly")
	outputBytes, err := build.CombinedOutput()
	if err != nil {
		t.Fatalf("build %s: %v\n%s", command, err, outputBytes)
	}
}

func publishTestRuntimeRepository(
	t *testing.T,
	output string,
	root []byte,
	targets []tufrepository.Target,
) {
	t.Helper()
	snapshot := testRuntimeSigner(t, metadata.SNAPSHOT)
	targetsSigner := testRuntimeSigner(t, metadata.TARGETS)
	timestamp := testRuntimeSigner(t, metadata.TIMESTAMP)
	now := time.Now().UTC()
	bundle, err := tufrepository.Build(tufrepository.Input{
		MetadataVersion: testMetadataVersion,
		Now:             now,
		Root:            root,
		Signers: tufrepository.OnlineSigners{
			Snapshot:  snapshot,
			Targets:   targetsSigner,
			Timestamp: timestamp,
		},
		SnapshotExpires:  now.Add(7 * 24 * time.Hour),
		Targets:          targets,
		TargetsExpires:   now.Add(30 * 24 * time.Hour),
		TimestampExpires: now.Add(24 * time.Hour),
	})
	if err != nil {
		t.Fatalf("build signed runtime repository: %v", err)
	}
	if err := bundle.Write(output); err != nil {
		t.Fatalf("write signed runtime repository: %v", err)
	}
}

func testRuntimeSigner(t *testing.T, role string) signature.Signer {
	t.Helper()
	seed := sha256.Sum256([]byte("YUCP transfer-helper TUF test key: " + role))
	signer, err := signature.LoadSigner(
		ed25519.NewKeyFromSeed(seed[:]),
		crypto.Hash(0),
	)
	if err != nil {
		t.Fatalf("load test TUF signer %s: %v", role, err)
	}
	return signer
}

func assertActiveRuntimeRecord(
	t *testing.T,
	recordPath string,
	result Result,
	descriptorSHA256 string,
) {
	t.Helper()
	recordBytes := readRequiredFile(t, recordPath)
	var record struct {
		BrokerPath              string `json:"brokerPath"`
		BrokerSHA256            string `json:"brokerSha256"`
		HelperPath              string `json:"helperPath"`
		HelperSHA256            string `json:"helperSha256"`
		RuntimeDescriptorSHA256 string `json:"runtimeDescriptorSha256"`
		SchemaVersion           int    `json:"schemaVersion"`
	}
	if err := json.Unmarshal(recordBytes, &record); err != nil {
		t.Fatalf("decode active runtime record: %v", err)
	}
	if record.SchemaVersion != 1 ||
		record.BrokerPath != result.BrokerPath ||
		record.BrokerSHA256 != result.BrokerSHA256 ||
		record.HelperPath != result.HelperPath ||
		record.HelperSHA256 != result.HelperSHA256 ||
		record.RuntimeDescriptorSHA256 != descriptorSHA256 {
		t.Fatalf("active runtime record = %#v", record)
	}
}

func assertBrokerChallenge(t *testing.T, pipeName string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	connection, err := winio.DialPipeAccessImpLevel(
		ctx,
		pipeName,
		uint32(windows.GENERIC_READ|windows.GENERIC_WRITE),
		winio.PipeImpLevelImpersonation,
	)
	if err != nil {
		t.Fatalf("connect to installed broker: %v", err)
	}
	defer connection.Close()
	nonceBytes := sha256.Sum256([]byte(t.Name()))
	nonce := base64.RawURLEncoding.EncodeToString(nonceBytes[:])
	if _, err := fmt.Fprintf(
		connection,
		"{\"clientNonce\":%q,\"kind\":\"begin\",\"schemaVersion\":1}\n",
		nonce,
	); err != nil {
		t.Fatalf("write broker begin frame: %v", err)
	}
	var challenge struct {
		ClientNonce    string `json:"clientNonce"`
		ExpiresAt      string `json:"expiresAt"`
		Kind           string `json:"kind"`
		OperationToken string `json:"operationToken"`
		SchemaVersion  int    `json:"schemaVersion"`
	}
	line, err := bufio.NewReader(connection).ReadBytes('\n')
	if err != nil {
		t.Fatalf("read installed broker challenge: %v", err)
	}
	if err := json.Unmarshal(line, &challenge); err != nil {
		t.Fatalf("decode installed broker challenge: %v", err)
	}
	expiresAt, err := time.Parse(time.RFC3339Nano, challenge.ExpiresAt)
	if err != nil ||
		challenge.SchemaVersion != 1 ||
		challenge.Kind != "challenge" ||
		challenge.ClientNonce != nonce ||
		challenge.OperationToken == "" ||
		!time.Now().Before(expiresAt) {
		t.Fatalf("installed broker challenge = %#v, error = %v", challenge, err)
	}
}

func readRequiredFile(t *testing.T, path string) []byte {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read required file %q: %v", path, err)
	}
	if len(data) == 0 {
		t.Fatalf("required file %q is empty", path)
	}
	return data
}

func sha256Hex(data []byte) string {
	digest := sha256.Sum256(data)
	return fmt.Sprintf("%x", digest[:])
}

func pointerDuration(value time.Duration) *time.Duration {
	return &value
}
