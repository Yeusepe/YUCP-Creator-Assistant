//go:build windows

package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/yucp/transfer-helper/internal/runtimeinstaller"
)

func runRuntimeEnsure(ctx context.Context, args []string) int {
	flags := flag.NewFlagSet("runtime-ensure", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	rootPath := flags.String("root", "", "reviewed package TUF root")
	metadataURL := flags.String("metadata-url", "", "package TUF metadata URL")
	targetsURL := flags.String("targets-url", "", "package TUF targets URL")
	installRoot := flags.String("install-root", "", "per-user package runtime install root")
	stateRoot := flags.String("state-root", "", "per-user package runtime state root")
	httpTimeout := flags.Duration("http-timeout", 30*time.Second, "TUF HTTP timeout")
	startupTimeout := flags.Duration("startup-timeout", 20*time.Second, "broker readiness timeout")
	traceID := flags.String("trace-id", "", "correlated trace identifier")
	if err := flags.Parse(args[1:]); err != nil || flags.NArg() != 0 {
		writeOutput(commandOutput{
			ErrorCode: runtimeInstallErrorCode,
			Message:   "invalid runtime-ensure arguments",
			Status:    "ERROR",
			TraceID:   strings.TrimSpace(*traceID),
		})
		return 2
	}
	root, err := readBoundedFile(*rootPath, maxTrustedRootBytes)
	if err != nil {
		return writeFailure(
			*traceID,
			runtimeInstallErrorCode,
			fmt.Errorf("read reviewed package TUF root: %w", err),
		)
	}
	result, err := runtimeinstaller.Ensure(ctx, runtimeinstaller.Config{
		HTTPTimeout:       *httpTimeout,
		InstallRoot:       *installRoot,
		RemoteMetadataURL: *metadataURL,
		RemoteTargetsURL:  *targetsURL,
		RuntimeTarget:     runtimeinstaller.RuntimeTargetName,
		StartupTimeout:    *startupTimeout,
		StateRoot:         *stateRoot,
		TrustedRoot:       root,
	})
	if err != nil {
		return writeFailure(*traceID, runtimeInstallErrorCode, err)
	}
	writeOutput(commandOutput{
		ActiveRecordPath:        result.ActiveRecordPath,
		BrokerPath:              result.BrokerPath,
		BrokerProcessID:         result.BrokerProcessID,
		BrokerSHA256:            result.BrokerSHA256,
		BrokerStarted:           result.BrokerStarted,
		HelperPath:              result.HelperPath,
		HelperSHA256:            result.HelperSHA256,
		RuntimeDescriptorSHA256: result.RuntimeDescriptorSHA256,
		SchemaVersion:           1,
		Status:                  "OK",
		TraceID:                 strings.TrimSpace(*traceID),
	})
	return 0
}
