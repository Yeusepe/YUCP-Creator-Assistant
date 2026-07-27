//go:build !windows

package main

import (
	"context"
	"fmt"
)

func runRuntimeEnsure(_ context.Context, _ []string) int {
	return writeFailure(
		"",
		runtimeInstallErrorCode,
		fmt.Errorf("package runtime installation requires Windows x64"),
	)
}
