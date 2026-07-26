package main

import (
	"context"
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"time"

	"github.com/yucp/transfer-helper/internal/deviceidentity"
	"github.com/yucp/transfer-helper/internal/lifecycle"
	"github.com/yucp/transfer-helper/internal/reconstructor"
	"github.com/yucp/transfer-helper/internal/trust"
	"github.com/yucp/transfer-helper/internal/tufclient"
)

const (
	deviceIdentityErrorCode  = "DEVICE_IDENTITY_FAILED"
	lifecycleErrorCode       = "PACKAGE_LIFECYCLE_FAILED"
	maxSignedShardBytes      = 4*1024*1024 + 2048
	maxTrustedRootBytes      = 512 * 1024
	maxLifecycleRequestBytes = 1024 * 1024
	reconstructErrorCode     = "PACKAGE_RECONSTRUCTION_FAILED"
	updateErrorCode          = "TUF_UPDATE_FAILED"
)

type commandOutput struct {
	ByteLength          int64  `json:"byteLength,omitempty"`
	Cached              bool   `json:"cached,omitempty"`
	ChunkObjects        int    `json:"chunkObjects,omitempty"`
	ChunkReferences     int    `json:"chunkReferences,omitempty"`
	DeviceKeyThumbprint string `json:"deviceKeyThumbprint,omitempty"`
	ErrorCode           string `json:"errorCode,omitempty"`
	FileCount           int    `json:"fileCount,omitempty"`
	LogicalBytes        int64  `json:"logicalBytes,omitempty"`
	Message             string `json:"message,omitempty"`
	Path                string `json:"path,omitempty"`
	ReleaseRoot         string `json:"releaseRoot,omitempty"`
	SHA256              string `json:"sha256,omitempty"`
	SchemaVersion       int    `json:"schemaVersion,omitempty"`
	Status              string `json:"status"`
	Target              string `json:"target,omitempty"`
	TraceID             string `json:"traceId,omitempty"`
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	os.Exit(run(ctx, os.Args[1:]))
}

func run(ctx context.Context, args []string) int {
	if len(args) == 0 {
		writeOutput(commandOutput{
			ErrorCode: updateErrorCode,
			Message:   "usage: yucp-transfer-helper <device-info|execute|update|reconstruct> [options]",
			Status:    "ERROR",
		})
		return 2
	}
	switch args[0] {
	case "device-info":
		return runDeviceInfo(args)
	case "execute":
		return runExecute(ctx, args)
	case "update":
		return runUpdate(args)
	case "reconstruct":
		return runReconstruct(ctx, args)
	default:
		writeOutput(commandOutput{
			ErrorCode: updateErrorCode,
			Message:   "usage: yucp-transfer-helper <device-info|execute|update|reconstruct> [options]",
			Status:    "ERROR",
		})
		return 2
	}
}

func runExecute(ctx context.Context, args []string) int {
	if len(args) != 1 {
		writeOutput(commandOutput{
			ErrorCode: lifecycleErrorCode,
			Message:   "execute does not accept command-line arguments",
			Status:    "ERROR",
		})
		return 2
	}
	request, err := readLifecycleRequest(os.Stdin)
	if err != nil {
		return writeFailure("", lifecycleErrorCode, err)
	}
	if existing, ok := readExistingLifecycleResult(request); ok {
		if existing.Status == "succeeded" && existing.ExitCode == 0 {
			return 0
		}
		return 1
	}
	result := lifecycle.Result{
		ErrorCode:         lifecycleErrorCode,
		ErrorMessage:      "",
		ExitCode:          1,
		Files:             []lifecycle.ResultFile{},
		JournalState:      "failed-before-project-mutation",
		Operation:         request.Operation,
		RunID:             request.RunID,
		SchemaVersion:     lifecycle.SchemaVersion,
		Status:            "failed",
		TargetReleaseRoot: request.TargetReleaseRoot,
		TraceID:           request.RunID,
	}
	identity, err := deviceidentity.LoadOrCreate(request.StateRoot)
	if err == nil {
		err = validateExecuteTrustRequest(request)
	}
	var trustDocument trust.Document
	if err == nil {
		trustDocument, err = loadTrustDocument(request)
	}
	if err == nil {
		executedResult, executeErr := lifecycle.Execute(ctx, request, identity, trustDocument)
		result = mergeLifecycleExecutionResult(result, executedResult, executeErr)
		err = executeErr
	} else {
		result = mergeLifecycleExecutionResult(result, lifecycle.Result{}, err)
	}
	if writeErr := writeAtomicLifecycleResult(request, result); writeErr != nil {
		return writeFailure(request.RunID, lifecycleErrorCode, writeErr)
	}
	if err != nil {
		return 1
	}
	return 0
}

func mergeLifecycleExecutionResult(
	failure lifecycle.Result,
	executed lifecycle.Result,
	err error,
) lifecycle.Result {
	if err == nil {
		return executed
	}
	if code := lifecycle.ErrorCode(err); code != "" {
		failure.ErrorCode = code
	}
	failure.ErrorMessage = err.Error()
	return failure
}

func readLifecycleRequest(reader io.Reader) (lifecycle.Request, error) {
	decoder := json.NewDecoder(io.LimitReader(reader, maxLifecycleRequestBytes+1))
	decoder.DisallowUnknownFields()
	var request lifecycle.Request
	if err := decoder.Decode(&request); err != nil {
		return lifecycle.Request{}, fmt.Errorf("decode package lifecycle request: %w", err)
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return lifecycle.Request{}, fmt.Errorf("package lifecycle request contains trailing JSON")
	}
	return request, nil
}

func validateExecuteTrustRequest(request lifecycle.Request) error {
	for name, value := range map[string]string{
		"TUF metadata URL": request.TUFMetadataURL,
		"TUF targets URL":  request.TUFTargetsURL,
		"TUF trust target": request.TUFTrustTarget,
		"TUF root path":    request.TUFRootPath,
	} {
		if strings.TrimSpace(value) == "" {
			return fmt.Errorf("%s is required", name)
		}
	}
	if !filepath.IsAbs(request.TUFRootPath) ||
		filepath.Base(request.TUFTrustTarget) != request.TUFTrustTarget ||
		strings.ContainsAny(request.TUFTrustTarget, `/\`) {
		return fmt.Errorf("package installer trust paths are invalid")
	}
	return validateResultPath(request)
}

func loadTrustDocument(request lifecycle.Request) (trust.Document, error) {
	rootBytes, err := readBoundedFile(request.TUFRootPath, maxTrustedRootBytes)
	if err != nil {
		return trust.Document{}, fmt.Errorf("read pinned TUF root: %w", err)
	}
	targetPath := filepath.Join(
		request.StateRoot,
		"tuf",
		"targets",
		request.TUFTrustTarget,
	)
	if _, err := tufclient.InstallTarget(tufclient.Config{
		LocalMetadataDir:  filepath.Join(request.StateRoot, "tuf", "metadata"),
		RemoteMetadataURL: request.TUFMetadataURL,
		RemoteTargetsURL:  request.TUFTargetsURL,
		TrustedRoot:       rootBytes,
	}, request.TUFTrustTarget, targetPath); err != nil {
		return trust.Document{}, fmt.Errorf("refresh package installer trust: %w", err)
	}
	targetBytes, err := readBoundedFile(targetPath, 64*1024)
	if err != nil {
		return trust.Document{}, fmt.Errorf("read package installer trust target: %w", err)
	}
	return trust.Parse(targetBytes)
}

func validateResultPath(request lifecycle.Request) error {
	if !filepath.IsAbs(request.ResultPath) || !filepath.IsAbs(request.StateRoot) {
		return fmt.Errorf("package lifecycle result path must be absolute")
	}
	resultRoot := filepath.Join(request.StateRoot, "results")
	relative, err := filepath.Rel(resultRoot, request.ResultPath)
	if err != nil ||
		relative != request.RunID+".json" ||
		strings.HasPrefix(relative, "..") {
		return fmt.Errorf("package lifecycle result path escapes its state directory")
	}
	return nil
}

func readExistingLifecycleResult(request lifecycle.Request) (lifecycle.Result, bool) {
	if validateResultPath(request) != nil {
		return lifecycle.Result{}, false
	}
	data, err := os.ReadFile(request.ResultPath)
	if err != nil {
		return lifecycle.Result{}, false
	}
	var result lifecycle.Result
	if json.Unmarshal(data, &result) != nil ||
		result.SchemaVersion != lifecycle.SchemaVersion ||
		result.RunID != request.RunID ||
		result.Operation != request.Operation {
		return lifecycle.Result{}, false
	}
	return result, true
}

func writeAtomicLifecycleResult(request lifecycle.Request, result lifecycle.Result) error {
	if err := validateResultPath(request); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(request.ResultPath), 0o700); err != nil {
		return fmt.Errorf("create package lifecycle result directory: %w", err)
	}
	data, err := json.Marshal(result)
	if err != nil {
		return fmt.Errorf("encode package lifecycle result: %w", err)
	}
	data = append(data, '\n')
	temporary, err := os.CreateTemp(
		filepath.Dir(request.ResultPath),
		"."+filepath.Base(request.ResultPath)+".partial-*",
	)
	if err != nil {
		return fmt.Errorf("create package lifecycle result temporary file: %w", err)
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o600); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("set package lifecycle result permissions: %w", err)
	}
	if _, err := temporary.Write(data); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("write package lifecycle result: %w", err)
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("synchronize package lifecycle result: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("close package lifecycle result: %w", err)
	}
	if err := os.Rename(temporaryPath, request.ResultPath); err != nil {
		return fmt.Errorf("publish package lifecycle result atomically: %w", err)
	}
	return nil
}

func runDeviceInfo(args []string) int {
	flags := flag.NewFlagSet("device-info", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	stateRoot := flags.String("state-root", "", "secure device state root")
	if err := flags.Parse(args[1:]); err != nil || flags.NArg() != 0 {
		return writeFailure("", deviceIdentityErrorCode, fmt.Errorf("invalid device-info arguments"))
	}
	identity, err := deviceidentity.LoadOrCreate(*stateRoot)
	if err != nil {
		return writeFailure("", deviceIdentityErrorCode, err)
	}
	writeOutput(commandOutput{
		DeviceKeyThumbprint: identity.Thumbprint,
		SchemaVersion:       1,
		Status:              "OK",
	})
	return 0
}

func runUpdate(args []string) int {
	flags := flag.NewFlagSet("update", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	rootPath := flags.String("root", "", "trusted root metadata path")
	metadataURL := flags.String("metadata-url", "", "TUF metadata base URL")
	targetsURL := flags.String("targets-url", "", "TUF targets base URL")
	metadataCache := flags.String("metadata-cache", "", "trusted metadata cache directory")
	targetName := flags.String("target", "", "trusted target name")
	destination := flags.String("destination", "", "verified target destination")
	traceID := flags.String("trace-id", "", "correlated trace identifier")
	timeout := flags.Duration("timeout", 30*time.Second, "HTTP timeout")
	if err := flags.Parse(args[1:]); err != nil {
		writeOutput(commandOutput{
			ErrorCode: updateErrorCode,
			Message:   "invalid update arguments",
			Status:    "ERROR",
		})
		return 2
	}
	if flags.NArg() != 0 {
		writeOutput(commandOutput{
			ErrorCode: updateErrorCode,
			Message:   "update received unexpected positional arguments",
			Status:    "ERROR",
			TraceID:   strings.TrimSpace(*traceID),
		})
		return 2
	}

	rootBytes, err := readBoundedFile(*rootPath, maxTrustedRootBytes)
	if err != nil {
		return writeFailure(*traceID, updateErrorCode, fmt.Errorf("read trusted TUF root: %w", err))
	}
	result, err := tufclient.InstallTarget(tufclient.Config{
		HTTPTimeout:       *timeout,
		LocalMetadataDir:  *metadataCache,
		RemoteMetadataURL: *metadataURL,
		RemoteTargetsURL:  *targetsURL,
		TrustedRoot:       rootBytes,
	}, *targetName, *destination)
	if err != nil {
		return writeFailure(*traceID, updateErrorCode, err)
	}
	writeOutput(commandOutput{
		ByteLength: result.ByteLength,
		Cached:     result.Cached,
		Path:       result.Path,
		SHA256:     result.SHA256,
		Status:     "OK",
		Target:     result.Target,
		TraceID:    strings.TrimSpace(*traceID),
	})
	return 0
}

func runReconstruct(ctx context.Context, args []string) int {
	flags := flag.NewFlagSet("reconstruct", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	signedShardPath := flags.String("signed-shard", "", "signed FileTableShardV2 path")
	publicKeyHex := flags.String("public-key", "", "trusted Ed25519 public key in hexadecimal")
	expectedKeyID := flags.String("key-id", "", "trusted signing key identifier")
	chunkCache := flags.String("chunk-cache", "", "verified encoded chunk cache directory")
	destination := flags.String("destination", "", "new verified staging-tree path")
	encodingProfile := flags.String(
		"encoding-profile",
		reconstructor.DesyncUncompressedSHA256V1,
		"signed release encoding profile",
	)
	traceID := flags.String("trace-id", "", "correlated trace identifier")
	if err := flags.Parse(args[1:]); err != nil {
		writeOutput(commandOutput{
			ErrorCode: reconstructErrorCode,
			Message:   "invalid reconstruct arguments",
			Status:    "ERROR",
		})
		return 2
	}
	if flags.NArg() != 0 {
		writeOutput(commandOutput{
			ErrorCode: reconstructErrorCode,
			Message:   "reconstruct received unexpected positional arguments",
			Status:    "ERROR",
			TraceID:   strings.TrimSpace(*traceID),
		})
		return 2
	}
	signedShard, err := readBoundedFile(*signedShardPath, maxSignedShardBytes)
	if err != nil {
		return writeFailure(
			*traceID,
			reconstructErrorCode,
			fmt.Errorf("read signed file-table shard: %w", err),
		)
	}
	publicKeyBytes, err := hex.DecodeString(strings.TrimSpace(*publicKeyHex))
	if err != nil || len(publicKeyBytes) != ed25519.PublicKeySize {
		return writeFailure(
			*traceID,
			reconstructErrorCode,
			fmt.Errorf("trusted Ed25519 public key must contain %d hexadecimal bytes", ed25519.PublicKeySize),
		)
	}
	result, err := reconstructor.Reconstruct(ctx, reconstructor.Config{
		ChunkCacheRoot:  *chunkCache,
		Destination:     *destination,
		EncodingProfile: strings.TrimSpace(*encodingProfile),
		ExpectedKeyID:   []byte(strings.TrimSpace(*expectedKeyID)),
		PublicKey:       ed25519.PublicKey(publicKeyBytes),
		SignedShard:     signedShard,
	})
	if err != nil {
		return writeFailure(*traceID, reconstructErrorCode, err)
	}
	writeOutput(commandOutput{
		ChunkObjects:    result.ChunkObjects,
		ChunkReferences: result.ChunkReferences,
		FileCount:       result.FileCount,
		LogicalBytes:    result.LogicalBytes,
		Path:            result.Path,
		ReleaseRoot:     result.ReleaseRoot,
		Status:          "OK",
		TraceID:         strings.TrimSpace(*traceID),
	})
	return 0
}

func readBoundedFile(path string, maxBytes int64) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, maxBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > maxBytes {
		return nil, fmt.Errorf("file exceeds %d bytes", maxBytes)
	}
	return data, nil
}

func writeFailure(traceID string, errorCode string, err error) int {
	if err == nil {
		err = errors.New("unknown helper failure")
	}
	writeOutput(commandOutput{
		ErrorCode: errorCode,
		Message:   err.Error(),
		Status:    "ERROR",
		TraceID:   strings.TrimSpace(traceID),
	})
	return 1
}

func writeOutput(output commandOutput) {
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetEscapeHTML(true)
	if err := encoder.Encode(output); err != nil {
		_, _ = fmt.Fprintln(os.Stderr, "could not encode helper result")
	}
}
