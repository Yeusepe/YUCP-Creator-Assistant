package guestagent

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/yucp/transfer-helper/internal/packagecontract"
)

const secretSentinel = "PACKAGE_LIFECYCLE_SECRET_SENTINEL_014"

type recordingSupervisor struct {
	command Command
}

type recordingNetworkObserver struct {
	beginCount int
	session    *recordingNetworkSession
}

type recordingNetworkSession struct {
	closeCount int
}

func (observer *recordingNetworkObserver) Begin(
	_ context.Context,
	request NetworkEnforcementRequest,
) (NetworkEnforcementSession, error) {
	observer.beginCount++
	observer.session = &recordingNetworkSession{}
	return observer.session, nil
}

func (session *recordingNetworkSession) Close(_ context.Context) error {
	session.closeCount++
	return nil
}

func (session *recordingNetworkSession) Observation() (NetworkEnforcementObservation, error) {
	return NetworkEnforcementObservation{
		AppliedPolicySHA256:  strings.Repeat("e", 64),
		BlockedProbe:         "198.51.100.1:443",
		NegativeProbeBlocked: true,
		PositiveProbePassed:  true,
		ProbedAllowlist: []string{
			"http://192.0.2.10:3000",
			"http://192.0.2.10:3002",
		},
	}, nil
}

func (supervisor *recordingSupervisor) Run(_ context.Context, command Command) (SupervisionResult, error) {
	supervisor.command = command
	networkPolicySHA256, err := requestNetworkPolicySHA256(command.RequestPath)
	if err != nil {
		return SupervisionResult{}, err
	}
	result, err := packagecontract.EncodeCanonical(map[any]any{
		int64(1): int64(1),
		int64(2): "passed",
		int64(3): networkPolicySHA256,
		int64(4): strings.Repeat("b", 32),
	})
	if err != nil {
		return SupervisionResult{}, err
	}
	if err := WriteFileAtomically(command.ResultPath, result); err != nil {
		return SupervisionResult{}, err
	}
	return SupervisionResult{
		AllChildrenExited: true,
		ExitCode:          0,
		KillOnJobClose:    true,
	}, nil
}

func requestNetworkPolicySHA256(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	decoded, err := packagecontract.DecodeCanonical(data)
	if err != nil {
		return "", err
	}
	return decoded.(map[any]any)[int64(9)].(string), nil
}

func lifecycleRequestBytes(t *testing.T) []byte {
	t.Helper()
	origins := []any{"http://192.0.2.10:3000", "http://192.0.2.10:3002"}
	encodedOrigins, err := packagecontract.EncodeCanonical(origins)
	if err != nil {
		t.Fatal(err)
	}
	networkPolicySHA256 := sha256.Sum256(encodedOrigins)
	encoded, err := packagecontract.EncodeCanonical(map[any]any{
		int64(1): int64(1),
		int64(2): "package-lifecycle",
		int64(3): "run-1",
		int64(4): strings.Repeat("b", 32),
		int64(5): "22222222-2222-4222-8222-222222222222",
		int64(6): "2026-07-26T01:00:00.000Z",
		int64(7): "2026-07-26T01:10:00.000Z",
		int64(8): origins,
		int64(9): hex.EncodeToString(networkPolicySHA256[:]),
		int64(10): map[any]any{
			int64(1):  "http://192.0.2.10:3002",
			int64(2):  "http://192.0.2.10:3000",
			int64(3):  secretSentinel,
			int64(4):  "buyer-enrollment-capability",
			int64(5):  "catalog-product-id",
			int64(6):  "com.yucp.lifecycle",
			int64(7):  "real-license-value",
			int64(8):  "Lifecycle Product",
			int64(9):  `C:\ProgramData\YUCP\LifecycleAgent\Fixtures\run-1\package-v1.unitypackage`,
			int64(10): "",
			int64(11): "00-" + strings.Repeat("b", 32) + "-" + strings.Repeat("d", 16) + "-01",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

func probeRequestBytes(t *testing.T) []byte {
	t.Helper()
	decoded, err := packagecontract.DecodeCanonical(lifecycleRequestBytes(t))
	if err != nil {
		t.Fatal(err)
	}
	request := decoded.(map[any]any)
	origins := []any{}
	encodedOrigins, err := packagecontract.EncodeCanonical(origins)
	if err != nil {
		t.Fatal(err)
	}
	networkPolicySHA256 := sha256.Sum256(encodedOrigins)
	request[int64(2)] = "probe"
	request[int64(8)] = origins
	request[int64(9)] = hex.EncodeToString(networkPolicySHA256[:])
	request[int64(10)] = nil
	encoded, err := packagecontract.EncodeCanonical(request)
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

func mutateLifecycleRequest(
	t *testing.T,
	mutate func(map[any]any),
) []byte {
	t.Helper()
	decoded, err := packagecontract.DecodeCanonical(lifecycleRequestBytes(t))
	if err != nil {
		t.Fatal(err)
	}
	request := decoded.(map[any]any)
	lifecycle := request[int64(10)].(map[any]any)
	mutate(lifecycle)
	encoded, err := packagecontract.EncodeCanonical(request)
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

func TestDecodeRequestValidatesTheCompleteLifecycleContract(t *testing.T) {
	request, err := decodeRequest(
		lifecycleRequestBytes(t),
		time.Date(2026, 7, 26, 1, 0, 0, 0, time.UTC),
	)
	if err != nil {
		t.Fatal(err)
	}
	if request.Lifecycle == nil {
		t.Fatal("decoded request has no lifecycle contract")
	}
	if request.Lifecycle.PackageID != "com.yucp.lifecycle" ||
		request.Lifecycle.PackageV1Path !=
			`C:\ProgramData\YUCP\LifecycleAgent\Fixtures\run-1\package-v1.unitypackage` {
		t.Fatalf("unexpected typed lifecycle contract: %+v", request.Lifecycle)
	}
}

func TestDecodeRequestRejectsMalformedLifecycleFields(t *testing.T) {
	now := time.Date(2026, 7, 26, 1, 0, 0, 0, time.UTC)
	cases := []struct {
		mutate func(map[any]any)
		name   string
	}{
		{
			name: "non-string origin",
			mutate: func(lifecycle map[any]any) {
				lifecycle[int64(1)] = int64(3002)
			},
		},
		{
			name: "origin credentials",
			mutate: func(lifecycle map[any]any) {
				lifecycle[int64(1)] = "http://user:password@192.0.2.10:3002"
			},
		},
		{
			name: "origin path",
			mutate: func(lifecycle map[any]any) {
				lifecycle[int64(2)] = "http://192.0.2.10:3000/sign-in"
			},
		},
		{
			name: "oversized enrollment capability",
			mutate: func(lifecycle map[any]any) {
				lifecycle[int64(3)] = strings.Repeat("s", 1025)
			},
		},
		{
			name: "invalid package ID",
			mutate: func(lifecycle map[any]any) {
				lifecycle[int64(6)] = `..\outside`
			},
		},
		{
			name: "oversized product name",
			mutate: func(lifecycle map[any]any) {
				lifecycle[int64(8)] = strings.Repeat("p", 513)
			},
		},
		{
			name: "version one path escape",
			mutate: func(lifecycle map[any]any) {
				lifecycle[int64(9)] =
					`C:\ProgramData\YUCP\LifecycleAgent\Fixtures\run-1\..\outside.unitypackage`
			},
		},
		{
			name: "version two wrong stem",
			mutate: func(lifecycle map[any]any) {
				lifecycle[int64(10)] =
					`C:\ProgramData\YUCP\LifecycleAgent\Fixtures\run-1\unexpected.unitypackage`
			},
		},
		{
			name: "traceparent mismatch",
			mutate: func(lifecycle map[any]any) {
				lifecycle[int64(11)] =
					"00-" + strings.Repeat("a", 32) + "-" + strings.Repeat("d", 16) + "-01"
			},
		},
	}

	for _, current := range cases {
		t.Run(current.name, func(t *testing.T) {
			encoded := mutateLifecycleRequest(t, current.mutate)
			if _, err := decodeRequest(encoded, now); err == nil {
				t.Fatal("malformed lifecycle request was accepted")
			}
		})
	}
}

func TestRunnerKeepsSecretsOutOfProcessMetadataAndRejectsIncompleteLifecycleEvidence(
	t *testing.T,
) {
	root := t.TempDir()
	requestPath := filepath.Join(root, "request.cbor")
	request := lifecycleRequestBytes(t)
	if err := os.WriteFile(requestPath, request, 0o600); err != nil {
		t.Fatal(err)
	}
	seed := bytes.Repeat([]byte{19}, ed25519.SeedSize)
	supervisor := &recordingSupervisor{}
	networkObserver := &recordingNetworkObserver{}
	runner := Runner{
		Config: Config{
			DriverArguments: []string{"--mode", "package-lifecycle"},
			DriverCommand:   `C:\Program Files\YUCP\LifecycleAgent\driver.exe`,
			EvidenceKeyID:   "guest-lifecycle-2026",
			EvidenceSeed:    seed,
			MinimalEnvironment: map[string]string{
				"SYSTEMROOT": `C:\Windows`,
			},
		},
		NewExecutionID:  func() string { return "guest-execution-id-1" },
		NetworkObserver: networkObserver,
		Now: func() time.Time {
			return time.Date(2026, 7, 26, 1, 0, 0, 0, time.UTC)
		},
		Supervisor: supervisor,
	}

	evidencePath, err := runner.Run(context.Background(), requestPath)
	if err == nil || !strings.Contains(err.Error(), "observed-evidence") {
		t.Fatalf("expected fail-closed lifecycle evidence rejection, got %q, %v", evidencePath, err)
	}
	if _, err := os.Stat(requestPath); !os.IsNotExist(err) {
		t.Fatalf("request was not removed: %v", err)
	}
	metadata := strings.Join(append(
		append([]string{supervisor.command.Executable}, supervisor.command.Arguments...),
		supervisor.command.Environment...,
	), "\n")
	if strings.Contains(metadata, secretSentinel) || strings.Contains(metadata, "real-license-value") {
		t.Fatal("process metadata contains a secret")
	}
	if !containsString(supervisor.command.SensitiveValues, secretSentinel) ||
		!containsString(supervisor.command.SensitiveValues, "real-license-value") {
		t.Fatal("supervisor did not receive the sensitive-value sentinels")
	}
	if supervisor.command.RequestPath != requestPath {
		t.Fatalf("driver request path = %q", supervisor.command.RequestPath)
	}
	if networkObserver.beginCount != 1 ||
		networkObserver.session == nil ||
		networkObserver.session.closeCount != 1 {
		t.Fatal("independent network enforcement was not closed exactly once")
	}
	if _, err := os.Stat(requestPath + ".evidence.cose"); !os.IsNotExist(err) {
		t.Fatalf("incomplete lifecycle evidence was written: %v", err)
	}
}

func TestRunnerWritesSignedProbeEvidence(t *testing.T) {
	root := t.TempDir()
	requestPath := filepath.Join(root, "probe.cbor")
	if err := os.WriteFile(requestPath, probeRequestBytes(t), 0o600); err != nil {
		t.Fatal(err)
	}
	seed := bytes.Repeat([]byte{19}, ed25519.SeedSize)
	runner := Runner{
		Config: Config{
			DriverArguments: []string{"--mode", "probe"},
			DriverCommand:   `C:\Program Files\YUCP\LifecycleAgent\driver.exe`,
			EvidenceKeyID:   "guest-lifecycle-2026",
			EvidenceSeed:    seed,
			MinimalEnvironment: map[string]string{
				"SYSTEMROOT": `C:\Windows`,
			},
		},
		NewExecutionID: func() string { return "guest-execution-id-1" },
		Now: func() time.Time {
			return time.Date(2026, 7, 26, 1, 0, 0, 0, time.UTC)
		},
		Supervisor: &recordingSupervisor{},
	}

	evidencePath, err := runner.Run(context.Background(), requestPath)
	if err != nil {
		t.Fatal(err)
	}
	evidence, err := os.ReadFile(evidencePath)
	if err != nil {
		t.Fatal(err)
	}
	payload, err := packagecontract.VerifySign1(
		evidence,
		ed25519.NewKeyFromSeed(seed).Public().(ed25519.PublicKey),
		[]byte("guest-lifecycle-2026"),
		EvidencePurpose,
	)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := packagecontract.DecodeCanonical(payload)
	if err != nil {
		t.Fatal(err)
	}
	mapped := decoded.(map[any]any)
	if mapped[int64(2)] != "run-1" || mapped[int64(3)] != strings.Repeat("b", 32) {
		t.Fatal("evidence did not preserve the root run and trace")
	}
	temporaryMatches, err := filepath.Glob(filepath.Join(root, "*.tmp"))
	if err != nil {
		t.Fatal(err)
	}
	if len(temporaryMatches) != 0 {
		t.Fatalf("atomic evidence left temporary files: %v", temporaryMatches)
	}
}

func TestSensitiveValueScannerFindsExactSentinels(t *testing.T) {
	if !containsSensitiveValue(
		[]byte("prefix-"+secretSentinel+"-suffix"),
		[]string{secretSentinel},
	) {
		t.Fatal("sensitive value scanner missed the exact sentinel")
	}
}

func containsString(values []string, expected string) bool {
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}

func TestRunnerRejectsMissingJobObjectContainment(t *testing.T) {
	root := t.TempDir()
	requestPath := filepath.Join(root, "request.cbor")
	if err := os.WriteFile(requestPath, lifecycleRequestBytes(t), 0o600); err != nil {
		t.Fatal(err)
	}
	supervisor := SupervisorFunc(func(_ context.Context, command Command) (SupervisionResult, error) {
		networkPolicySHA256, err := requestNetworkPolicySHA256(command.RequestPath)
		if err != nil {
			return SupervisionResult{}, err
		}
		result, err := packagecontract.EncodeCanonical(map[any]any{
			int64(1): int64(1),
			int64(2): "passed",
			int64(3): networkPolicySHA256,
			int64(4): strings.Repeat("b", 32),
		})
		if err != nil {
			return SupervisionResult{}, err
		}
		if err := WriteFileAtomically(command.ResultPath, result); err != nil {
			return SupervisionResult{}, err
		}
		return SupervisionResult{ExitCode: 0}, nil
	})
	runner := Runner{
		Config: Config{
			DriverCommand: `C:\Program Files\YUCP\LifecycleAgent\driver.exe`,
			EvidenceKeyID: "guest-lifecycle-2026",
			EvidenceSeed:  bytes.Repeat([]byte{23}, ed25519.SeedSize),
		},
		NewExecutionID: func() string { return "guest-execution-id-1" },
		Now: func() time.Time {
			return time.Date(2026, 7, 26, 1, 0, 0, 0, time.UTC)
		},
		Supervisor:      supervisor,
		NetworkObserver: &recordingNetworkObserver{},
	}

	if _, err := runner.Run(context.Background(), requestPath); err == nil ||
		!strings.Contains(err.Error(), "Job Object") {
		t.Fatalf("expected Job Object failure, got %v", err)
	}
	if _, err := os.Stat(requestPath); !os.IsNotExist(err) {
		t.Fatalf("failed request was not removed: %v", err)
	}
}

func TestRunnerRejectsMissingIndependentNetworkObserver(t *testing.T) {
	root := t.TempDir()
	requestPath := filepath.Join(root, "request.cbor")
	if err := os.WriteFile(requestPath, lifecycleRequestBytes(t), 0o600); err != nil {
		t.Fatal(err)
	}
	supervisor := &recordingSupervisor{}
	runner := Runner{
		Config: Config{
			DriverCommand: `C:\Program Files\YUCP\LifecycleAgent\driver.exe`,
			EvidenceKeyID: "guest-lifecycle-2026",
			EvidenceSeed:  bytes.Repeat([]byte{31}, ed25519.SeedSize),
		},
		Now: func() time.Time {
			return time.Date(2026, 7, 26, 1, 0, 0, 0, time.UTC)
		},
		Supervisor: supervisor,
	}

	if _, err := runner.Run(context.Background(), requestPath); err == nil ||
		!strings.Contains(err.Error(), "network enforcement") {
		t.Fatalf("expected independent network observer failure, got %v", err)
	}
	if supervisor.command.Executable != "" {
		t.Fatal("driver started without independent network enforcement")
	}
}

func TestRunnerClearsRequestWhenConfigurationIsInvalid(t *testing.T) {
	root := t.TempDir()
	requestPath := filepath.Join(root, "request.cbor")
	if err := os.WriteFile(requestPath, lifecycleRequestBytes(t), 0o600); err != nil {
		t.Fatal(err)
	}
	runner := Runner{
		Config: Config{
			DriverCommand: "relative-driver.exe",
		},
		Supervisor: &recordingSupervisor{},
	}

	if _, err := runner.Run(context.Background(), requestPath); err == nil {
		t.Fatal("invalid configuration was accepted")
	}
	if _, err := os.Stat(requestPath); !os.IsNotExist(err) {
		t.Fatalf("request survived configuration failure: %v", err)
	}
}
