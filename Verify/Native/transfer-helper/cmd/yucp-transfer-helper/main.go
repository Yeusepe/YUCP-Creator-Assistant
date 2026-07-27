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
	"strings"
	"time"

	"github.com/yucp/transfer-helper/internal/deviceidentity"
	"github.com/yucp/transfer-helper/internal/reconstructor"
	"github.com/yucp/transfer-helper/internal/tufclient"
)

const (
	deviceIdentityErrorCode = "DEVICE_IDENTITY_FAILED"
	maxSignedShardBytes     = 4*1024*1024 + 2048
	maxTrustedRootBytes     = 512 * 1024
	reconstructErrorCode    = "PACKAGE_RECONSTRUCTION_FAILED"
	updateErrorCode         = "TUF_UPDATE_FAILED"
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
			Message:   "usage: yucp-transfer-helper <device-info|update|reconstruct> [options]",
			Status:    "ERROR",
		})
		return 2
	}
	switch args[0] {
	case "device-info":
		return runDeviceInfo(args)
	case "update":
		return runUpdate(args)
	case "reconstruct":
		return runReconstruct(ctx, args)
	default:
		writeOutput(commandOutput{
			ErrorCode: updateErrorCode,
			Message:   "usage: yucp-transfer-helper <device-info|update|reconstruct> [options]",
			Status:    "ERROR",
		})
		return 2
	}
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

// runUpdate is an administrative bootstrap and maintenance surface.
// Unity package operations use the broker pipe and cannot set these URLs.
// The Windows broker service owns its pinned production update configuration.
func runUpdate(args []string) int {
	flags := flag.NewFlagSet("update", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	rootPath := flags.String("root", "", "administrative trusted root metadata path")
	metadataURL := flags.String("metadata-url", "", "administrative TUF metadata base URL")
	targetsURL := flags.String("targets-url", "", "administrative TUF targets base URL")
	metadataCache := flags.String(
		"metadata-cache",
		"",
		"administrative trusted metadata cache directory",
	)
	targetName := flags.String("target", "", "administrative trusted target name")
	destination := flags.String("destination", "", "administrative verified target destination")
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
