//go:build windows

package runtimeinstaller

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"github.com/Microsoft/go-winio"
	"github.com/yucp/transfer-helper/internal/broker"
	"github.com/yucp/transfer-helper/internal/runtimecontract"
	"github.com/yucp/transfer-helper/internal/tufclient"
	"golang.org/x/sys/windows"
)

const (
	BrokerTargetName    = runtimecontract.BrokerTargetName
	HelperTargetName    = runtimecontract.HelperTargetName
	RuntimePlatform     = runtimecontract.Platform
	RuntimeTargetName   = runtimecontract.RuntimeTargetName
	TrustTargetName     = runtimecontract.TrustTargetName
	activeRecordName    = "active-runtime.json"
	activeRecordSchema  = 1
	defaultHTTPTimeout  = 30 * time.Second
	defaultStartupLimit = 20 * time.Second
	maxDescriptorBytes  = 64 * 1024
	maxRootBytes        = 512 * 1024
	maxStartupLogBytes  = 64 * 1024
)

type Config struct {
	HTTPTimeout       time.Duration
	InstallRoot       string
	RemoteMetadataURL string
	RemoteTargetsURL  string
	RuntimeTarget     string
	StartupTimeout    time.Duration
	StateRoot         string
	Traceparent       string
	TrustedRoot       []byte
}

type Result struct {
	ActiveRecordPath        string
	BrokerPath              string
	BrokerProcessID         int
	BrokerSHA256            string
	BrokerStarted           bool
	HelperPath              string
	HelperSHA256            string
	RuntimeDescriptorSHA256 string
}

type activeRecord struct {
	APIBaseURL              string `json:"apiBaseUrl"`
	AuthBaseURL             string `json:"authBaseUrl"`
	BrokerPath              string `json:"brokerPath"`
	BrokerProcessID         int    `json:"brokerProcessId"`
	BrokerSHA256            string `json:"brokerSha256"`
	HelperPath              string `json:"helperPath"`
	HelperSHA256            string `json:"helperSha256"`
	MetadataURL             string `json:"metadataUrl"`
	PipeName                string `json:"pipeName"`
	RuntimeDescriptorSHA256 string `json:"runtimeDescriptorSha256"`
	SchemaVersion           int    `json:"schemaVersion"`
	TargetsURL              string `json:"targetsUrl"`
	TrustTarget             string `json:"trustTarget"`
}

type normalizedConfig struct {
	HTTPTimeout       time.Duration
	InstallRoot       string
	RemoteMetadataURL string
	RemoteTargetsURL  string
	StartupTimeout    time.Duration
	StateRoot         string
	Traceparent       string
	TrustedRoot       []byte
}

func Ensure(ctx context.Context, config Config) (Result, error) {
	normalized, err := normalizeConfig(config)
	if err != nil {
		return Result{}, err
	}
	if err := os.MkdirAll(normalized.InstallRoot, 0o700); err != nil {
		return Result{}, fmt.Errorf("create package runtime install root: %w", err)
	}
	if err := os.MkdirAll(normalized.StateRoot, 0o700); err != nil {
		return Result{}, fmt.Errorf("create package runtime state root: %w", err)
	}
	lock, err := acquireRuntimeLock(ctx, filepath.Join(normalized.StateRoot, "runtime.lock"))
	if err != nil {
		return Result{}, err
	}
	defer lock.release()

	activePath := filepath.Join(normalized.InstallRoot, activeRecordName)
	previous, previousOK := readActiveRecord(activePath, normalized.InstallRoot)
	if previousOK && !matchesBootstrap(previous, normalized) {
		previousOK = false
	}
	if previousOK {
		if serverProcessMatches(
			previous.PipeName,
			uint32(previous.BrokerProcessID),
			previous.BrokerPath,
		) {
			return resultFromRecord(previous, activePath, false), nil
		}
	}

	desired, installErr := installSignedRuntime(normalized)
	if installErr == nil {
		repaired, repairedOK := readActiveRecord(activePath, normalized.InstallRoot)
		if repairedOK &&
			sameRuntime(repaired, desired) &&
			serverProcessMatches(
				repaired.PipeName,
				uint32(repaired.BrokerProcessID),
				repaired.BrokerPath,
			) {
			return resultFromRecord(repaired, activePath, false), nil
		}
		started, startErr := startRuntime(normalized, desired)
		if startErr == nil {
			if err := writeActiveRecord(activePath, started); err != nil {
				terminateProcess(started.BrokerProcessID)
				return Result{}, err
			}
			return resultFromRecord(started, activePath, true), nil
		}
		installErr = startErr
	}
	if previousOK {
		rolledBack, rollbackErr := startRuntime(normalized, previous)
		if rollbackErr == nil {
			if err := writeActiveRecord(activePath, rolledBack); err != nil {
				terminateProcess(rolledBack.BrokerProcessID)
				return Result{}, err
			}
			return resultFromRecord(rolledBack, activePath, true), nil
		}
		return Result{}, fmt.Errorf(
			"start signed package runtime: %v; restore prior runtime: %w",
			installErr,
			rollbackErr,
		)
	}
	return Result{}, installErr
}

func matchesBootstrap(record activeRecord, config normalizedConfig) bool {
	return record.MetadataURL == config.RemoteMetadataURL &&
		record.TargetsURL == config.RemoteTargetsURL &&
		verifyFile(
			filepath.Join(config.StateRoot, "trust", "1.root.json"),
			digestHex(config.TrustedRoot),
		) == nil
}

func sameRuntime(active activeRecord, desired activeRecord) bool {
	return active.APIBaseURL == desired.APIBaseURL &&
		active.AuthBaseURL == desired.AuthBaseURL &&
		active.BrokerPath == desired.BrokerPath &&
		active.BrokerSHA256 == desired.BrokerSHA256 &&
		active.HelperPath == desired.HelperPath &&
		active.HelperSHA256 == desired.HelperSHA256 &&
		active.MetadataURL == desired.MetadataURL &&
		active.PipeName == desired.PipeName &&
		active.RuntimeDescriptorSHA256 == desired.RuntimeDescriptorSHA256 &&
		active.SchemaVersion == desired.SchemaVersion &&
		active.TargetsURL == desired.TargetsURL &&
		active.TrustTarget == desired.TrustTarget
}

func normalizeConfig(config Config) (normalizedConfig, error) {
	if config.RuntimeTarget != "" && config.RuntimeTarget != RuntimeTargetName {
		return normalizedConfig{}, fmt.Errorf("package runtime target is fixed")
	}
	if len(config.TrustedRoot) == 0 || len(config.TrustedRoot) > maxRootBytes {
		return normalizedConfig{}, fmt.Errorf("package runtime TUF root length is invalid")
	}
	installRoot, err := absoluteDirectory(config.InstallRoot, "install")
	if err != nil {
		return normalizedConfig{}, err
	}
	stateRoot, err := absoluteDirectory(config.StateRoot, "state")
	if err != nil {
		return normalizedConfig{}, err
	}
	if samePathOrNested(installRoot, stateRoot) || samePathOrNested(stateRoot, installRoot) {
		return normalizedConfig{}, fmt.Errorf("package runtime install and state roots must be separate")
	}
	metadataURL, err := canonicalRepositoryURL(config.RemoteMetadataURL)
	if err != nil {
		return normalizedConfig{}, fmt.Errorf("package runtime metadata URL: %w", err)
	}
	targetsURL, err := canonicalRepositoryURL(config.RemoteTargetsURL)
	if err != nil {
		return normalizedConfig{}, fmt.Errorf("package runtime targets URL: %w", err)
	}
	httpTimeout := config.HTTPTimeout
	if httpTimeout <= 0 {
		httpTimeout = defaultHTTPTimeout
	}
	startupTimeout := config.StartupTimeout
	if startupTimeout <= 0 {
		startupTimeout = defaultStartupLimit
	}
	if httpTimeout > 5*time.Minute || startupTimeout > 2*time.Minute {
		return normalizedConfig{}, fmt.Errorf("package runtime timeout is invalid")
	}
	return normalizedConfig{
		HTTPTimeout:       httpTimeout,
		InstallRoot:       installRoot,
		RemoteMetadataURL: metadataURL,
		RemoteTargetsURL:  targetsURL,
		StartupTimeout:    startupTimeout,
		StateRoot:         stateRoot,
		Traceparent:       strings.TrimSpace(config.Traceparent),
		TrustedRoot:       append([]byte(nil), config.TrustedRoot...),
	}, nil
}

func installSignedRuntime(config normalizedConfig) (activeRecord, error) {
	tufState := filepath.Join(config.StateRoot, "bootstrap-tuf")
	targetCache := filepath.Join(tufState, "targets")
	descriptorPath := filepath.Join(targetCache, "package-runtime.json")
	descriptorResult, err := tufclient.InstallTarget(tufclient.Config{
		HTTPTimeout:       config.HTTPTimeout,
		LocalMetadataDir:  filepath.Join(tufState, "metadata"),
		RemoteMetadataURL: config.RemoteMetadataURL,
		RemoteTargetsURL:  config.RemoteTargetsURL,
		Traceparent:       config.Traceparent,
		TrustedRoot:       config.TrustedRoot,
	}, RuntimeTargetName, descriptorPath)
	if err != nil {
		return activeRecord{}, fmt.Errorf("install signed package runtime descriptor: %w", err)
	}
	descriptorBytes, err := readBounded(descriptorPath, maxDescriptorBytes)
	if err != nil {
		return activeRecord{}, fmt.Errorf("read signed package runtime descriptor: %w", err)
	}
	if descriptorResult.SHA256 != digestHex(descriptorBytes) {
		return activeRecord{}, fmt.Errorf("signed package runtime descriptor digest changed")
	}
	runtimeDescriptor, err := parseDescriptor(
		descriptorBytes,
		config.RemoteMetadataURL,
		config.RemoteTargetsURL,
	)
	if err != nil {
		return activeRecord{}, err
	}
	helperDownload := filepath.Join(targetCache, "yucp-transfer-helper.exe")
	helper, err := tufclient.InstallTarget(tufclient.Config{
		HTTPTimeout:       config.HTTPTimeout,
		LocalMetadataDir:  filepath.Join(tufState, "metadata"),
		RemoteMetadataURL: config.RemoteMetadataURL,
		RemoteTargetsURL:  config.RemoteTargetsURL,
		Traceparent:       config.Traceparent,
		TrustedRoot:       config.TrustedRoot,
	}, runtimeDescriptor.HelperTarget, helperDownload)
	if err != nil {
		return activeRecord{}, fmt.Errorf("install signed transfer helper: %w", err)
	}
	brokerDownload := filepath.Join(targetCache, "yucp-package-broker.exe")
	brokerResult, err := tufclient.InstallTarget(tufclient.Config{
		HTTPTimeout:       config.HTTPTimeout,
		LocalMetadataDir:  filepath.Join(tufState, "metadata"),
		RemoteMetadataURL: config.RemoteMetadataURL,
		RemoteTargetsURL:  config.RemoteTargetsURL,
		Traceparent:       config.Traceparent,
		TrustedRoot:       config.TrustedRoot,
	}, runtimeDescriptor.BrokerTarget, brokerDownload)
	if err != nil {
		return activeRecord{}, fmt.Errorf("install signed package broker: %w", err)
	}
	versionRoot := filepath.Join(
		config.InstallRoot,
		"versions",
		descriptorResult.SHA256,
	)
	helperPath := filepath.Join(versionRoot, filepath.Base(HelperTargetName))
	if err := publishExactFile(helperDownload, helperPath, helper.SHA256); err != nil {
		return activeRecord{}, fmt.Errorf("activate signed transfer helper: %w", err)
	}
	brokerPath := filepath.Join(versionRoot, filepath.Base(BrokerTargetName))
	if err := publishExactFile(brokerDownload, brokerPath, brokerResult.SHA256); err != nil {
		return activeRecord{}, fmt.Errorf("activate signed package broker: %w", err)
	}
	rootPath := filepath.Join(config.StateRoot, "trust", "1.root.json")
	if err := publishExactBytes(config.TrustedRoot, rootPath, digestHex(config.TrustedRoot)); err != nil {
		return activeRecord{}, fmt.Errorf("activate pinned package runtime root: %w", err)
	}
	return activeRecord{
		APIBaseURL:              runtimeDescriptor.APIBaseURL,
		AuthBaseURL:             runtimeDescriptor.AuthBaseURL,
		BrokerPath:              brokerPath,
		BrokerSHA256:            brokerResult.SHA256,
		HelperPath:              helperPath,
		HelperSHA256:            helper.SHA256,
		MetadataURL:             runtimeDescriptor.MetadataURL,
		PipeName:                runtimeDescriptor.PipeName,
		RuntimeDescriptorSHA256: descriptorResult.SHA256,
		SchemaVersion:           activeRecordSchema,
		TargetsURL:              runtimeDescriptor.TargetsURL,
		TrustTarget:             runtimeDescriptor.TrustTarget,
	}, nil
}

func parseDescriptor(
	raw []byte,
	metadataURL string,
	targetsURL string,
) (runtimecontract.Descriptor, error) {
	value, err := runtimecontract.Parse(raw)
	if err != nil {
		return runtimecontract.Descriptor{}, fmt.Errorf(
			"decode signed package runtime descriptor: %w",
			err,
		)
	}
	if value.PipeName != broker.DefaultPipeName ||
		value.MetadataURL != metadataURL ||
		value.TargetsURL != targetsURL {
		return runtimecontract.Descriptor{}, fmt.Errorf(
			"signed package runtime descriptor is invalid",
		)
	}
	return value, nil
}

func startRuntime(config normalizedConfig, record activeRecord) (activeRecord, error) {
	if err := validateActiveRecord(record, config.InstallRoot); err != nil {
		return activeRecord{}, err
	}
	rootPath := filepath.Join(config.StateRoot, "trust", "1.root.json")
	if err := verifyFile(rootPath, digestHex(config.TrustedRoot)); err != nil {
		return activeRecord{}, fmt.Errorf("verify pinned package runtime root: %w", err)
	}
	stateRoot := filepath.Join(config.StateRoot, "broker")
	if err := os.MkdirAll(stateRoot, 0o700); err != nil {
		return activeRecord{}, fmt.Errorf("create package broker state root: %w", err)
	}
	startupLog, startupLogPath, err := openStartupLog(config.StateRoot)
	if err != nil {
		return activeRecord{}, err
	}
	defer startupLog.Close()
	command := exec.Command(
		record.BrokerPath,
		"--api-base-url", record.APIBaseURL,
		"--auth-base-url", record.AuthBaseURL,
		"--pipe", record.PipeName,
		"--state-root", stateRoot,
		"--tuf-root", rootPath,
		"--tuf-metadata-url", record.MetadataURL,
		"--tuf-targets-url", record.TargetsURL,
		"--tuf-trust-target", record.TrustTarget,
	)
	command.Dir = filepath.Dir(record.BrokerPath)
	command.Stdin = nil
	command.Stdout = startupLog
	command.Stderr = startupLog
	command.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: brokerCreationFlags(),
		HideWindow:    true,
	}
	if err := command.Start(); err != nil {
		return activeRecord{}, fmt.Errorf("start detached package broker: %w", err)
	}
	processID := command.Process.Pid
	if err := waitForBroker(record.PipeName, uint32(processID), config.StartupTimeout); err != nil {
		_ = command.Process.Kill()
		_, _ = command.Process.Wait()
		_ = startupLog.Sync()
		diagnostic := readStartupDiagnostic(startupLogPath)
		if diagnostic != "" {
			return activeRecord{}, fmt.Errorf("%w: %s", err, diagnostic)
		}
		return activeRecord{}, err
	}
	if err := command.Process.Release(); err != nil {
		terminateProcess(processID)
		return activeRecord{}, fmt.Errorf("release detached package broker: %w", err)
	}
	record.BrokerProcessID = processID
	return record, nil
}

func brokerCreationFlags() uint32 {
	var information windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION
	err := windows.QueryInformationJobObject(
		0,
		windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&information)),
		uint32(unsafe.Sizeof(information)),
		nil,
	)
	if err != nil {
		return brokerCreationFlagsForLimitFlags(0)
	}
	return brokerCreationFlagsForLimitFlags(
		information.BasicLimitInformation.LimitFlags,
	)
}

func brokerCreationFlagsForLimitFlags(limitFlags uint32) uint32 {
	flags := uint32(windows.CREATE_NEW_PROCESS_GROUP | windows.DETACHED_PROCESS)
	// Windows child processes inherit their parent's job. Explicit breakaway is
	// valid only when the job enables JOB_OBJECT_LIMIT_BREAKAWAY_OK.
	// https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects
	if limitFlags&windows.JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK != 0 {
		return flags
	}
	if limitFlags&windows.JOB_OBJECT_LIMIT_BREAKAWAY_OK != 0 {
		flags |= windows.CREATE_BREAKAWAY_FROM_JOB
	}
	return flags
}

func openStartupLog(stateRoot string) (*os.File, string, error) {
	logRoot := filepath.Join(stateRoot, "diagnostics")
	if err := os.MkdirAll(logRoot, 0o700); err != nil {
		return nil, "", fmt.Errorf("create package broker diagnostic root: %w", err)
	}
	current := filepath.Join(logRoot, "broker-startup.log")
	previous := filepath.Join(logRoot, "broker-startup.previous.log")
	_ = os.Remove(previous)
	if err := os.Rename(current, previous); err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, "", fmt.Errorf("rotate package broker startup diagnostic: %w", err)
	}
	file, err := os.OpenFile(current, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return nil, "", fmt.Errorf("open package broker startup diagnostic: %w", err)
	}
	return file, current, nil
}

func readStartupDiagnostic(path string) string {
	raw, err := readBounded(path, maxStartupLogBytes)
	if err != nil {
		return ""
	}
	message := strings.TrimSpace(string(raw))
	if len(message) > 4096 {
		message = message[:4096]
	}
	return strings.NewReplacer(
		"\r", " ",
		"\n", " ",
		"\t", " ",
	).Replace(message)
}

func waitForBroker(pipeName string, processID uint32, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		wait := 250 * time.Millisecond
		connection, err := winio.DialPipe(pipeName, &wait)
		if err == nil {
			serverProcessID, identifyErr := namedPipeServerProcessID(connection)
			_ = connection.Close()
			if identifyErr == nil && serverProcessID == processID {
				return nil
			}
		}
		if !processRunning(processID) {
			return fmt.Errorf("package broker exited before readiness")
		}
		time.Sleep(50 * time.Millisecond)
	}
	return fmt.Errorf("package broker readiness timed out")
}

func processRunning(processID uint32) bool {
	process, err := windows.OpenProcess(windows.SYNCHRONIZE, false, processID)
	if err != nil {
		return false
	}
	defer windows.CloseHandle(process)
	state, err := windows.WaitForSingleObject(process, 0)
	return err == nil && state == uint32(windows.WAIT_TIMEOUT)
}

func namedPipeServerProcessID(connection net.Conn) (uint32, error) {
	handleOwner, ok := connection.(interface{ Fd() uintptr })
	if !ok {
		return 0, fmt.Errorf("package broker pipe handle is unavailable")
	}
	var processID uint32
	if err := windows.GetNamedPipeServerProcessId(
		windows.Handle(handleOwner.Fd()),
		&processID,
	); err != nil {
		return 0, err
	}
	return processID, nil
}

func serverProcessID(pipeName string) uint32 {
	wait := 100 * time.Millisecond
	connection, err := winio.DialPipe(pipeName, &wait)
	if err != nil {
		return 0
	}
	defer connection.Close()
	processID, err := namedPipeServerProcessID(connection)
	if err != nil {
		return 0
	}
	return processID
}

func serverProcessMatches(pipeName string, processID uint32, expectedPath string) bool {
	if processID == 0 || serverProcessID(pipeName) != processID {
		return false
	}
	process, err := windows.OpenProcess(
		windows.PROCESS_QUERY_LIMITED_INFORMATION,
		false,
		processID,
	)
	if err != nil {
		return false
	}
	defer windows.CloseHandle(process)
	buffer := make([]uint16, 32768)
	size := uint32(len(buffer))
	if err := windows.QueryFullProcessImageName(
		process,
		0,
		&buffer[0],
		&size,
	); err != nil || size == 0 || int(size) > len(buffer) {
		return false
	}
	actualPath := filepath.Clean(windows.UTF16ToString(buffer[:size]))
	return strings.EqualFold(actualPath, filepath.Clean(expectedPath))
}

func validateActiveRecord(record activeRecord, installRoot string) error {
	if record.SchemaVersion != activeRecordSchema ||
		record.RuntimeDescriptorSHA256 == "" ||
		record.PipeName != broker.DefaultPipeName ||
		record.TrustTarget != TrustTargetName ||
		record.BrokerSHA256 == "" ||
		record.HelperSHA256 == "" {
		return fmt.Errorf("active package runtime record is invalid")
	}
	versionRoot := filepath.Join(installRoot, "versions", record.RuntimeDescriptorSHA256)
	if !pathInside(versionRoot, record.BrokerPath) ||
		!pathInside(versionRoot, record.HelperPath) ||
		filepath.Base(record.BrokerPath) != filepath.Base(BrokerTargetName) ||
		filepath.Base(record.HelperPath) != filepath.Base(HelperTargetName) {
		return fmt.Errorf("active package runtime paths are invalid")
	}
	if err := verifyFile(record.BrokerPath, record.BrokerSHA256); err != nil {
		return fmt.Errorf("verify active package broker: %w", err)
	}
	if err := verifyFile(record.HelperPath, record.HelperSHA256); err != nil {
		return fmt.Errorf("verify active transfer helper: %w", err)
	}
	if _, err := canonicalRuntimeURL(record.APIBaseURL); err != nil {
		return fmt.Errorf("active package API URL: %w", err)
	}
	if _, err := canonicalRuntimeURL(record.AuthBaseURL); err != nil {
		return fmt.Errorf("active package authorization URL: %w", err)
	}
	if _, err := canonicalRepositoryURL(record.MetadataURL); err != nil {
		return fmt.Errorf("active package metadata URL: %w", err)
	}
	if _, err := canonicalRepositoryURL(record.TargetsURL); err != nil {
		return fmt.Errorf("active package targets URL: %w", err)
	}
	return nil
}

func readActiveRecord(path string, installRoot string) (activeRecord, bool) {
	raw, err := readBounded(path, maxDescriptorBytes)
	if err != nil {
		return activeRecord{}, false
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	var record activeRecord
	if decoder.Decode(&record) != nil ||
		requireJSONEnd(decoder) != nil ||
		validateActiveRecord(record, installRoot) != nil {
		return activeRecord{}, false
	}
	return record, true
}

func writeActiveRecord(path string, record activeRecord) error {
	raw, err := json.Marshal(record)
	if err != nil {
		return fmt.Errorf("encode active package runtime record: %w", err)
	}
	if err := publishExactBytes(raw, path, digestHex(raw)); err != nil {
		return fmt.Errorf("publish active package runtime record: %w", err)
	}
	return nil
}

func resultFromRecord(record activeRecord, activePath string, started bool) Result {
	return Result{
		ActiveRecordPath:        activePath,
		BrokerPath:              record.BrokerPath,
		BrokerProcessID:         record.BrokerProcessID,
		BrokerSHA256:            record.BrokerSHA256,
		BrokerStarted:           started,
		HelperPath:              record.HelperPath,
		HelperSHA256:            record.HelperSHA256,
		RuntimeDescriptorSHA256: record.RuntimeDescriptorSHA256,
	}
}

func publishExactFile(source string, destination string, expectedSHA256 string) error {
	raw, err := os.ReadFile(source)
	if err != nil {
		return err
	}
	if digestHex(raw) != expectedSHA256 {
		return fmt.Errorf("source digest does not match signed TUF target")
	}
	return publishExactBytes(raw, destination, expectedSHA256)
}

func publishExactBytes(raw []byte, destination string, expectedSHA256 string) error {
	if digestHex(raw) != expectedSHA256 {
		return fmt.Errorf("published byte digest is invalid")
	}
	if err := verifyFile(destination, expectedSHA256); err == nil {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(destination), 0o700); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(destination), ".runtime-partial-*")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o700); err != nil {
		_ = temporary.Close()
		return err
	}
	if _, err := temporary.Write(raw); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	from, err := windows.UTF16PtrFromString(temporaryPath)
	if err != nil {
		return err
	}
	to, err := windows.UTF16PtrFromString(destination)
	if err != nil {
		return err
	}
	if err := windows.MoveFileEx(
		from,
		to,
		windows.MOVEFILE_REPLACE_EXISTING|windows.MOVEFILE_WRITE_THROUGH,
	); err != nil {
		return err
	}
	return verifyFile(destination, expectedSHA256)
}

func verifyFile(path string, expectedSHA256 string) error {
	if len(expectedSHA256) != sha256.Size*2 {
		return fmt.Errorf("expected SHA-256 is invalid")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	if digestHex(raw) != expectedSHA256 {
		return fmt.Errorf("file SHA-256 does not match")
	}
	return nil
}

func digestHex(raw []byte) string {
	digest := sha256.Sum256(raw)
	return hex.EncodeToString(digest[:])
}

func readBounded(path string, limit int64) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	raw, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil {
		return nil, err
	}
	if len(raw) == 0 || int64(len(raw)) > limit {
		return nil, fmt.Errorf("file length is invalid")
	}
	return raw, nil
}

func canonicalRuntimeURL(raw string) (string, error) {
	return canonicalURL(raw, true)
}

func canonicalRepositoryURL(raw string) (string, error) {
	return canonicalURL(raw, true)
}

func canonicalURL(raw string, allowLoopback bool) (string, error) {
	if raw != strings.TrimSpace(raw) || strings.HasSuffix(raw, "/") {
		return "", fmt.Errorf("URL is not canonical")
	}
	parsed, err := url.Parse(raw)
	if err != nil ||
		!parsed.IsAbs() ||
		parsed.Hostname() == "" ||
		parsed.User != nil ||
		parsed.RawQuery != "" ||
		parsed.Fragment != "" {
		return "", fmt.Errorf("URL is invalid")
	}
	if parsed.Scheme != "https" &&
		!(allowLoopback && parsed.Scheme == "http" && isLoopback(parsed.Hostname())) {
		return "", fmt.Errorf("URL must use HTTPS")
	}
	if parsed.String() != raw {
		return "", fmt.Errorf("URL is not canonical")
	}
	return raw, nil
}

func isLoopback(host string) bool {
	return strings.EqualFold(host, "localhost") || net.ParseIP(host).IsLoopback()
}

func absoluteDirectory(raw string, name string) (string, error) {
	if strings.TrimSpace(raw) == "" || !filepath.IsAbs(raw) {
		return "", fmt.Errorf("package runtime %s root must be absolute", name)
	}
	absolute, err := filepath.Abs(raw)
	if err != nil {
		return "", fmt.Errorf("resolve package runtime %s root: %w", name, err)
	}
	return filepath.Clean(absolute), nil
}

func samePathOrNested(parent string, candidate string) bool {
	relative, err := filepath.Rel(parent, candidate)
	return err == nil &&
		(relative == "." ||
			(relative != ".." &&
				!strings.HasPrefix(relative, ".."+string(filepath.Separator))))
}

func pathInside(parent string, candidate string) bool {
	relative, err := filepath.Rel(parent, candidate)
	return err == nil &&
		relative != "." &&
		relative != ".." &&
		!strings.HasPrefix(relative, ".."+string(filepath.Separator)) &&
		!filepath.IsAbs(relative)
}

func requireJSONEnd(decoder *json.Decoder) error {
	var extra any
	if err := decoder.Decode(&extra); errors.Is(err, io.EOF) {
		return nil
	}
	return fmt.Errorf("JSON contains trailing data")
}

type runtimeLock struct {
	file *os.File
}

func acquireRuntimeLock(ctx context.Context, path string) (*runtimeLock, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, fmt.Errorf("create package runtime lock directory: %w", err)
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, fmt.Errorf("open package runtime lock: %w", err)
	}
	overlapped := new(windows.Overlapped)
	for {
		err = windows.LockFileEx(
			windows.Handle(file.Fd()),
			windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY,
			0,
			1,
			0,
			overlapped,
		)
		if err == nil {
			return &runtimeLock{file: file}, nil
		}
		if !errors.Is(err, windows.ERROR_LOCK_VIOLATION) {
			_ = file.Close()
			return nil, fmt.Errorf("lock package runtime: %w", err)
		}
		select {
		case <-ctx.Done():
			_ = file.Close()
			return nil, fmt.Errorf("lock package runtime: %w", ctx.Err())
		case <-time.After(50 * time.Millisecond):
		}
	}
}

func (lock *runtimeLock) release() {
	if lock == nil || lock.file == nil {
		return
	}
	_ = windows.UnlockFileEx(
		windows.Handle(lock.file.Fd()),
		0,
		1,
		0,
		new(windows.Overlapped),
	)
	_ = lock.file.Close()
}

func terminateProcess(processID int) {
	if processID < 1 {
		return
	}
	process, err := os.FindProcess(processID)
	if err == nil {
		_ = process.Kill()
		_, _ = process.Wait()
	}
}
