package guestagent

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/yucp/transfer-helper/internal/packagecontract"
)

const (
	EvidencePurpose      = "package-lifecycle-guest-evidence-v1"
	maxProtocolFileBytes = 8 * 1024 * 1024
)

var (
	hex128Pattern           = regexp.MustCompile(`^[0-9a-f]{32}$`)
	hex256Pattern           = regexp.MustCompile(`^[0-9a-f]{64}$`)
	safeIDPattern           = regexp.MustCompile(`^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,254}[A-Za-z0-9])?$`)
	traceparentPattern      = regexp.MustCompile(`^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$`)
	fixtureExtensionPattern = regexp.MustCompile(`^\.[a-z0-9]{1,31}$`)
	uuidPattern             = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
)

type Config struct {
	DriverArguments    []string
	DriverCommand      string
	EvidenceKeyID      string
	EvidenceSeed       []byte
	MinimalEnvironment map[string]string
}

type Command struct {
	Arguments       []string
	Environment     []string
	Executable      string
	RequestPath     string
	ResultPath      string
	SensitiveValues []string
}

type SupervisionResult struct {
	AllChildrenExited bool
	ExitCode          int
	KillOnJobClose    bool
}

type Supervisor interface {
	Run(context.Context, Command) (SupervisionResult, error)
}

type SupervisorFunc func(context.Context, Command) (SupervisionResult, error)

func (function SupervisorFunc) Run(
	ctx context.Context,
	command Command,
) (SupervisionResult, error) {
	return function(ctx, command)
}

type Runner struct {
	Config          Config
	NetworkObserver NetworkEnforcementObserver
	NewExecutionID  func() string
	Now             func() time.Time
	Supervisor      Supervisor
}

type lifecycleRequest struct {
	CheckpointID        string
	ExpiresAt           time.Time
	Kind                string
	Lifecycle           *packageLifecycleRequest
	NetworkAllowlist    []string
	NetworkPolicySHA256 string
	RunID               string
	SensitiveValues     []string
	TraceID             string
}

type NetworkEnforcementRequest struct {
	Allowlist   []string
	Environment []string
	RunID       string
}

type NetworkEnforcementObservation struct {
	AppliedPolicySHA256  string
	BlockedProbe         string
	NegativeProbeBlocked bool
	PositiveProbePassed  bool
	ProbedAllowlist      []string
}

type NetworkEnforcementSession interface {
	Close(context.Context) error
	Observation() (NetworkEnforcementObservation, error)
}

type NetworkEnforcementObserver interface {
	Begin(context.Context, NetworkEnforcementRequest) (NetworkEnforcementSession, error)
}

type packageLifecycleRequest struct {
	APIOrigin                   string
	BuyerEnrollmentCapability   string
	CatalogProductID            string
	CreatorEnrollmentCapability string
	LicenseKey                  string
	PackageID                   string
	PackageV1Path               string
	PackageV2Path               string
	ProductName                 string
	Traceparent                 string
	WebOrigin                   string
}

type driverResult struct {
	NetworkPolicySHA256 string
	Status              string
	TraceID             string
}

func requireMap(value any, name string) (map[any]any, error) {
	mapped, ok := value.(map[any]any)
	if !ok {
		return nil, fmt.Errorf("%s must be a CBOR map", name)
	}
	return mapped, nil
}

func requireArray(value any, name string) ([]any, error) {
	array, ok := value.([]any)
	if !ok {
		return nil, fmt.Errorf("%s must be a CBOR array", name)
	}
	return array, nil
}

func requireString(value any, name string, maximumBytes int) (string, error) {
	text, ok := value.(string)
	if !ok || text == "" || len([]byte(text)) > maximumBytes {
		return "", fmt.Errorf("%s is invalid", name)
	}
	for _, character := range text {
		if character < 0x20 || character == 0x7f {
			return "", fmt.Errorf("%s is invalid", name)
		}
	}
	return text, nil
}

func requireInteger(value any, name string) (int64, error) {
	number, ok := value.(int64)
	if !ok {
		return 0, fmt.Errorf("%s must be an integer", name)
	}
	return number, nil
}

func requireExactLabels(mapped map[any]any, labels ...int64) error {
	if len(mapped) != len(labels) {
		return fmt.Errorf("CBOR map contains missing or unknown labels")
	}
	allowed := make(map[int64]struct{}, len(labels))
	for _, label := range labels {
		allowed[label] = struct{}{}
	}
	for key := range mapped {
		label, ok := key.(int64)
		if !ok {
			return fmt.Errorf("CBOR map contains a non-integer label")
		}
		if _, ok := allowed[label]; !ok {
			return fmt.Errorf("CBOR map contains unknown label %d", label)
		}
	}
	return nil
}

func requireOrigin(value any, name string) (string, error) {
	origin, err := requireString(value, name, 2048)
	if err != nil {
		return "", err
	}
	parsed, err := url.Parse(origin)
	if err != nil ||
		(parsed.Scheme != "http" && parsed.Scheme != "https") ||
		parsed.Hostname() == "" ||
		parsed.User != nil ||
		parsed.Path != "" ||
		parsed.RawPath != "" ||
		parsed.RawQuery != "" ||
		parsed.Fragment != "" ||
		parsed.Opaque != "" ||
		parsed.String() != origin {
		return "", fmt.Errorf("%s must be one canonical HTTP origin", name)
	}
	return origin, nil
}

func requireSafeID(value any, name string) (string, error) {
	identifier, err := requireString(value, name, 256)
	if err != nil || !safeIDPattern.MatchString(identifier) {
		return "", fmt.Errorf("%s is invalid", name)
	}
	return identifier, nil
}

func requireWindowsFixturePath(value any, runID string, stem string, optional bool) (string, error) {
	path, ok := value.(string)
	if !ok || len(path) > 32_767 {
		return "", fmt.Errorf("Package fixture path is invalid")
	}
	if optional && path == "" {
		return "", nil
	}
	if path == "" {
		return "", fmt.Errorf("Package fixture path is invalid")
	}
	prefix := `C:\ProgramData\YUCP\LifecycleAgent\Fixtures\` + runID + `\` + stem
	if !strings.HasPrefix(path, prefix) {
		return "", fmt.Errorf("Package fixture path escapes the run directory")
	}
	extension := strings.TrimPrefix(path, prefix)
	if !fixtureExtensionPattern.MatchString(extension) || path != prefix+extension {
		return "", fmt.Errorf("Package fixture path is not canonical")
	}
	return path, nil
}

func requireTraceparent(value any, traceID string) (string, error) {
	traceparent, err := requireString(value, "Lifecycle traceparent", 55)
	if err != nil {
		return "", err
	}
	matches := traceparentPattern.FindStringSubmatch(traceparent)
	if len(matches) != 4 ||
		matches[1] != traceID ||
		matches[1] == strings.Repeat("0", 32) ||
		matches[2] == strings.Repeat("0", 16) ||
		(matches[3] != "00" && matches[3] != "01") {
		return "", fmt.Errorf("Lifecycle traceparent is invalid")
	}
	return traceparent, nil
}

func includesString(values []string, expected string) bool {
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}

func equalStrings(left []string, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}

func decodeRequest(data []byte, now time.Time) (lifecycleRequest, error) {
	value, err := packagecontract.DecodeCanonical(data)
	if err != nil {
		return lifecycleRequest{}, err
	}
	mapped, err := requireMap(value, "Lifecycle guest request")
	if err != nil {
		return lifecycleRequest{}, err
	}
	if err := requireExactLabels(mapped, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10); err != nil {
		return lifecycleRequest{}, err
	}
	version, err := requireInteger(mapped[int64(1)], "Lifecycle guest request schema version")
	if err != nil || version != 1 {
		return lifecycleRequest{}, fmt.Errorf("lifecycle guest request schema version is invalid")
	}
	kind, err := requireString(mapped[int64(2)], "Lifecycle guest request kind", 64)
	if err != nil || (kind != "probe" && kind != "package-lifecycle") {
		return lifecycleRequest{}, fmt.Errorf("lifecycle guest request kind is invalid")
	}
	runID, err := requireString(mapped[int64(3)], "Lifecycle guest run ID", 256)
	if err != nil || !safeIDPattern.MatchString(runID) {
		return lifecycleRequest{}, fmt.Errorf("lifecycle guest run ID is invalid")
	}
	traceID, err := requireString(mapped[int64(4)], "Lifecycle guest trace ID", 32)
	if err != nil || !hex128Pattern.MatchString(traceID) {
		return lifecycleRequest{}, fmt.Errorf("lifecycle guest trace ID is invalid")
	}
	checkpointID, err := requireString(mapped[int64(5)], "Lifecycle checkpoint binding", 64)
	if err != nil || !uuidPattern.MatchString(checkpointID) {
		return lifecycleRequest{}, fmt.Errorf("lifecycle checkpoint binding is invalid")
	}
	issuedText, err := requireString(mapped[int64(6)], "Lifecycle guest issue time", 64)
	if err != nil {
		return lifecycleRequest{}, err
	}
	expiresText, err := requireString(mapped[int64(7)], "Lifecycle guest expiry time", 64)
	if err != nil {
		return lifecycleRequest{}, err
	}
	issuedAt, err := time.Parse(time.RFC3339Nano, issuedText)
	if err != nil {
		return lifecycleRequest{}, fmt.Errorf("lifecycle guest issue time is invalid")
	}
	expiresAt, err := time.Parse(time.RFC3339Nano, expiresText)
	if err != nil {
		return lifecycleRequest{}, fmt.Errorf("lifecycle guest expiry time is invalid")
	}
	if expiresAt.Sub(issuedAt) <= 0 ||
		expiresAt.Sub(issuedAt) > 15*time.Minute ||
		now.Before(issuedAt.Add(-30*time.Second)) ||
		!now.Before(expiresAt) {
		return lifecycleRequest{}, fmt.Errorf("lifecycle guest request is not active")
	}
	originValues, err := requireArray(mapped[int64(8)], "Lifecycle guest network allowlist")
	if err != nil || len(originValues) > 32 {
		return lifecycleRequest{}, fmt.Errorf("lifecycle guest network allowlist is invalid")
	}
	origins := make([]string, 0, len(originValues))
	for index, value := range originValues {
		origin, err := requireOrigin(value, fmt.Sprintf("Lifecycle guest origin %d", index))
		if err != nil {
			return lifecycleRequest{}, err
		}
		if index > 0 && origins[index-1] >= origin {
			return lifecycleRequest{}, fmt.Errorf("lifecycle guest network allowlist is not canonical")
		}
		origins = append(origins, origin)
	}
	networkPolicySHA256, err := requireString(
		mapped[int64(9)],
		"Lifecycle guest network policy digest",
		64,
	)
	if err != nil || !hex256Pattern.MatchString(networkPolicySHA256) {
		return lifecycleRequest{}, fmt.Errorf("lifecycle guest network policy digest is invalid")
	}
	encodedOrigins, err := packagecontract.EncodeCanonical(originValues)
	if err != nil {
		return lifecycleRequest{}, err
	}
	observedNetworkPolicySHA256 := sha256.Sum256(encodedOrigins)
	if hex.EncodeToString(observedNetworkPolicySHA256[:]) != networkPolicySHA256 {
		return lifecycleRequest{}, fmt.Errorf("lifecycle guest network policy digest does not match")
	}
	sensitiveValues := []string{}
	var decodedLifecycle *packageLifecycleRequest
	if kind == "probe" {
		if mapped[int64(10)] != nil {
			return lifecycleRequest{}, fmt.Errorf("probe request carries lifecycle data")
		}
	} else {
		lifecycle, err := requireMap(mapped[int64(10)], "Package lifecycle request")
		if err != nil {
			return lifecycleRequest{}, err
		}
		if err := requireExactLabels(lifecycle, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11); err != nil {
			return lifecycleRequest{}, err
		}
		apiOrigin, err := requireOrigin(lifecycle[int64(1)], "Lifecycle API origin")
		if err != nil {
			return lifecycleRequest{}, err
		}
		webOrigin, err := requireOrigin(lifecycle[int64(2)], "Lifecycle web origin")
		if err != nil {
			return lifecycleRequest{}, err
		}
		if apiOrigin == webOrigin ||
			!includesString(origins, apiOrigin) ||
			!includesString(origins, webOrigin) {
			return lifecycleRequest{}, fmt.Errorf("lifecycle origins do not match the network allowlist")
		}
		creatorEnrollmentCapability, err := requireString(
			lifecycle[int64(3)],
			"Creator enrollment capability",
			1024,
		)
		if err != nil {
			return lifecycleRequest{}, err
		}
		buyerEnrollmentCapability, err := requireString(
			lifecycle[int64(4)],
			"Buyer enrollment capability",
			1024,
		)
		if err != nil {
			return lifecycleRequest{}, err
		}
		catalogProductID, err := requireSafeID(lifecycle[int64(5)], "Catalog product ID")
		if err != nil {
			return lifecycleRequest{}, err
		}
		packageID, err := requireSafeID(lifecycle[int64(6)], "Package ID")
		if err != nil {
			return lifecycleRequest{}, err
		}
		licenseKey, err := requireString(lifecycle[int64(7)], "Manual license key", 4096)
		if err != nil {
			return lifecycleRequest{}, err
		}
		productName, err := requireString(lifecycle[int64(8)], "Product name", 512)
		if err != nil {
			return lifecycleRequest{}, err
		}
		packageV1Path, err := requireWindowsFixturePath(
			lifecycle[int64(9)],
			runID,
			"package-v1",
			false,
		)
		if err != nil {
			return lifecycleRequest{}, err
		}
		packageV2Path, err := requireWindowsFixturePath(
			lifecycle[int64(10)],
			runID,
			"package-v2",
			true,
		)
		if err != nil {
			return lifecycleRequest{}, err
		}
		traceparent, err := requireTraceparent(lifecycle[int64(11)], traceID)
		if err != nil {
			return lifecycleRequest{}, err
		}
		decodedLifecycle = &packageLifecycleRequest{
			APIOrigin:                   apiOrigin,
			BuyerEnrollmentCapability:   buyerEnrollmentCapability,
			CatalogProductID:            catalogProductID,
			CreatorEnrollmentCapability: creatorEnrollmentCapability,
			LicenseKey:                  licenseKey,
			PackageID:                   packageID,
			PackageV1Path:               packageV1Path,
			PackageV2Path:               packageV2Path,
			ProductName:                 productName,
			Traceparent:                 traceparent,
			WebOrigin:                   webOrigin,
		}
		sensitiveValues = []string{
			creatorEnrollmentCapability,
			buyerEnrollmentCapability,
			licenseKey,
		}
	}
	return lifecycleRequest{
		CheckpointID:        checkpointID,
		ExpiresAt:           expiresAt,
		Kind:                kind,
		Lifecycle:           decodedLifecycle,
		NetworkAllowlist:    origins,
		NetworkPolicySHA256: networkPolicySHA256,
		RunID:               runID,
		SensitiveValues:     sensitiveValues,
		TraceID:             traceID,
	}, nil
}

func containsSensitiveValue(data []byte, values []string) bool {
	for _, value := range values {
		if value != "" && bytes.Contains(data, []byte(value)) {
			return true
		}
	}
	return false
}

func decodeDriverResult(data []byte, request lifecycleRequest) (driverResult, error) {
	value, err := packagecontract.DecodeCanonical(data)
	if err != nil {
		return driverResult{}, err
	}
	mapped, err := requireMap(value, "Lifecycle driver result")
	if err != nil {
		return driverResult{}, err
	}
	if err := requireExactLabels(mapped, 1, 2, 3, 4); err != nil {
		return driverResult{}, err
	}
	version, err := requireInteger(mapped[int64(1)], "Lifecycle driver schema version")
	if err != nil || version != 1 {
		return driverResult{}, fmt.Errorf("lifecycle driver schema version is invalid")
	}
	status, err := requireString(mapped[int64(2)], "Lifecycle driver status", 32)
	if err != nil || status != "passed" {
		return driverResult{}, fmt.Errorf("lifecycle driver did not pass")
	}
	networkPolicy, err := requireString(mapped[int64(3)], "Observed network policy digest", 64)
	if err != nil || networkPolicy != request.NetworkPolicySHA256 {
		return driverResult{}, fmt.Errorf("observed network policy digest does not match")
	}
	traceID, err := requireString(mapped[int64(4)], "Observed root trace ID", 32)
	if err != nil || traceID != request.TraceID {
		return driverResult{}, fmt.Errorf("observed root trace ID does not match")
	}
	return driverResult{
		NetworkPolicySHA256: networkPolicy,
		Status:              status,
		TraceID:             traceID,
	}, nil
}

func readBoundedFile(path string) ([]byte, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() <= 0 || info.Size() > maxProtocolFileBytes {
		return nil, fmt.Errorf("protocol file is not one bounded regular file")
	}
	return os.ReadFile(path)
}

func environmentList(values map[string]string) ([]string, error) {
	names := make([]string, 0, len(values))
	for name, value := range values {
		if name == "" || strings.ContainsAny(name, "=\x00") || strings.IndexByte(value, 0) >= 0 {
			return nil, fmt.Errorf("minimal child environment is invalid")
		}
		if regexp.MustCompile(`(?i)authorization|cookie|credential|password|private_key|secret|token`).MatchString(name) {
			return nil, fmt.Errorf("minimal child environment contains a forbidden field")
		}
		names = append(names, name)
	}
	sort.Strings(names)
	environment := make([]string, 0, len(names))
	for _, name := range names {
		environment = append(environment, name+"="+values[name])
	}
	return environment, nil
}

func validateConfig(config Config) error {
	if !filepath.IsAbs(config.DriverCommand) {
		return fmt.Errorf("lifecycle driver command must be absolute")
	}
	if len(config.EvidenceKeyID) < 1 || len(config.EvidenceKeyID) > 64 {
		return fmt.Errorf("guest evidence key ID is invalid")
	}
	if len(config.EvidenceSeed) != ed25519.SeedSize {
		return fmt.Errorf("guest evidence seed is invalid")
	}
	for _, argument := range config.DriverArguments {
		if argument == "" || strings.IndexByte(argument, 0) >= 0 {
			return fmt.Errorf("lifecycle driver argument is invalid")
		}
	}
	return nil
}

func signEvidence(
	config Config,
	payload []byte,
) ([]byte, error) {
	protected, err := packagecontract.EncodeCanonical(map[any]any{
		int64(1):    int64(-8),
		int64(2):    []any{int64(1001)},
		int64(4):    []byte(config.EvidenceKeyID),
		int64(1001): EvidencePurpose,
	})
	if err != nil {
		return nil, err
	}
	signatureStructure, err := packagecontract.EncodeCanonical([]any{
		"Signature1",
		protected,
		[]byte{},
		payload,
	})
	if err != nil {
		return nil, err
	}
	signature := ed25519.Sign(ed25519.NewKeyFromSeed(config.EvidenceSeed), signatureStructure)
	return packagecontract.EncodeCanonical([]any{
		protected,
		map[any]any{},
		payload,
		signature,
	})
}

func randomExecutionID() string {
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		panic(fmt.Sprintf("generate guest execution ID: %v", err))
	}
	value[6] = (value[6] & 0x0f) | 0x40
	value[8] = (value[8] & 0x3f) | 0x80
	return fmt.Sprintf(
		"%s-%s-%s-%s-%s",
		hex.EncodeToString(value[0:4]),
		hex.EncodeToString(value[4:6]),
		hex.EncodeToString(value[6:8]),
		hex.EncodeToString(value[8:10]),
		hex.EncodeToString(value[10:16]),
	)
}

func WriteFileAtomically(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	temporaryPath := path + ".tmp"
	file, err := os.OpenFile(temporaryPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	removeTemporary := true
	defer func() {
		if removeTemporary {
			_ = os.Remove(temporaryPath)
		}
	}()
	if _, err := file.Write(data); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	if err := os.Rename(temporaryPath, path); err != nil {
		return err
	}
	removeTemporary = false
	return nil
}

func clearAndRemove(path string) error {
	file, err := os.OpenFile(path, os.O_WRONLY, 0)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	info, err := file.Stat()
	if err != nil {
		_ = file.Close()
		return err
	}
	zeroes := make([]byte, 64*1024)
	remaining := info.Size()
	for remaining > 0 {
		chunk := int64(len(zeroes))
		if remaining < chunk {
			chunk = remaining
		}
		if _, err := file.Write(zeroes[:chunk]); err != nil {
			_ = file.Close()
			return err
		}
		remaining -= chunk
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	return os.Remove(path)
}

func (runner Runner) Run(ctx context.Context, requestPath string) (string, error) {
	if runner.Now == nil {
		runner.Now = time.Now
	}
	if runner.NewExecutionID == nil {
		runner.NewExecutionID = randomExecutionID
	}
	if runner.Supervisor == nil {
		return "", errors.Join(
			fmt.Errorf("lifecycle child supervisor is unavailable"),
			clearAndRemove(requestPath),
		)
	}
	if err := validateConfig(runner.Config); err != nil {
		return "", errors.Join(err, clearAndRemove(requestPath))
	}
	requestBytes, err := readBoundedFile(requestPath)
	if err != nil {
		return "", errors.Join(err, clearAndRemove(requestPath))
	}
	requestSHA256 := sha256.Sum256(requestBytes)
	startedAt := runner.Now().UTC()
	request, runErr := decodeRequest(requestBytes, startedAt)
	resultPath := requestPath + ".driver-result.cbor"
	evidencePath := requestPath + ".evidence.cose"
	var networkSession NetworkEnforcementSession
	if runErr == nil {
		environment, environmentErr := environmentList(runner.Config.MinimalEnvironment)
		if environmentErr != nil {
			runErr = environmentErr
		} else {
			if request.Kind == "package-lifecycle" {
				if runner.NetworkObserver == nil {
					runErr = fmt.Errorf("independent lifecycle network enforcement is unavailable")
				} else {
					networkSession, runErr = runner.NetworkObserver.Begin(
						ctx,
						NetworkEnforcementRequest{
							Allowlist:   append([]string(nil), request.NetworkAllowlist...),
							Environment: append([]string(nil), environment...),
							RunID:       request.RunID,
						},
					)
					if runErr == nil {
						observation, observationErr := networkSession.Observation()
						if observationErr != nil ||
							!hex256Pattern.MatchString(observation.AppliedPolicySHA256) ||
							!observation.PositiveProbePassed ||
							!observation.NegativeProbeBlocked ||
							!equalStrings(
								observation.ProbedAllowlist,
								request.NetworkAllowlist,
							) ||
							observation.BlockedProbe == "" {
							runErr = fmt.Errorf(
								"independent lifecycle network enforcement was not observed",
							)
						}
					}
				}
			}
		}
		if runErr == nil {
			supervision, supervisionErr := runner.Supervisor.Run(ctx, Command{
				Arguments: append(
					append([]string{}, runner.Config.DriverArguments...),
					"--request-path",
					requestPath,
					"--result-path",
					resultPath,
				),
				Environment:     environment,
				Executable:      runner.Config.DriverCommand,
				RequestPath:     requestPath,
				ResultPath:      resultPath,
				SensitiveValues: append([]string(nil), request.SensitiveValues...),
			})
			if supervisionErr != nil {
				runErr = fmt.Errorf("lifecycle driver supervision failed")
			} else if supervision.ExitCode != 0 {
				runErr = fmt.Errorf("lifecycle driver failed")
			} else if !supervision.KillOnJobClose || !supervision.AllChildrenExited {
				runErr = fmt.Errorf("lifecycle driver did not prove Job Object containment")
			} else {
				resultBytes, resultErr := readBoundedFile(resultPath)
				if resultErr != nil {
					runErr = resultErr
				} else {
					_, runErr = decodeDriverResult(resultBytes, request)
				}
			}
		}
	}
	if networkSession != nil {
		runErr = errors.Join(runErr, networkSession.Close(context.WithoutCancel(ctx)))
	}
	if runErr == nil && request.Kind == "package-lifecycle" {
		runErr = fmt.Errorf("package lifecycle observed-evidence contract is unavailable")
	}
	clearErr := errors.Join(clearAndRemove(requestPath), clearAndRemove(resultPath))
	if runErr != nil || clearErr != nil {
		return "", errors.Join(runErr, clearErr)
	}
	finishedAt := runner.Now().UTC()
	payload, err := packagecontract.EncodeCanonical(map[any]any{
		int64(1): int64(1),
		int64(2): request.RunID,
		int64(3): request.TraceID,
		int64(4): hex.EncodeToString(requestSHA256[:]),
		int64(5): "passed",
		int64(6): startedAt.Format(time.RFC3339Nano),
		int64(7): finishedAt.Format(time.RFC3339Nano),
		int64(8): runner.NewExecutionID(),
		int64(9): request.NetworkPolicySHA256,
		int64(10): map[any]any{
			int64(1): "windows-job-object",
			int64(2): true,
			int64(3): true,
		},
	})
	if err != nil {
		return "", err
	}
	evidence, err := signEvidence(runner.Config, payload)
	if err != nil {
		return "", err
	}
	if bytes.Contains(evidence, requestBytes) {
		return "", fmt.Errorf("guest evidence contains request bytes")
	}
	if containsSensitiveValue(evidence, request.SensitiveValues) {
		return "", fmt.Errorf("guest evidence contains a sensitive value")
	}
	if err := WriteFileAtomically(evidencePath, evidence); err != nil {
		return "", err
	}
	return evidencePath, nil
}
