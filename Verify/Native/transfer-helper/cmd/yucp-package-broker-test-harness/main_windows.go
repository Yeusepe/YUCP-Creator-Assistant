//go:build windows && integrationharness

// The integrationharness tag excludes this process from production builds.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"strings"

	"github.com/yucp/transfer-helper/internal/broker"
)

type preflightHandler struct{}

func (preflightHandler) Handle(
	_ context.Context,
	_ broker.ClientIdentity,
	request broker.OperationRequest,
	report broker.ProgressReporter,
) (broker.OperationResult, error) {
	if request.Operation != "preflight" {
		return broker.OperationResult{}, fmt.Errorf(
			"test harness accepts preflight operations only",
		)
	}
	for _, phase := range []string{"preparing", "verifying", "finalizing"} {
		if err := report(phase, 0, 0); err != nil {
			return broker.OperationResult{}, err
		}
	}
	return broker.OperationResult{
		ActiveContentDigest: strings.Repeat("33", 32),
		ActivePolicyVersion: "integration-test-policy-v1",
		ExitCode:            0,
		Files:               []broker.OperationResultFile{},
		JournalState:        "preflight-complete",
		Operation:           request.Operation,
		RunID:               request.RunID,
		SchemaVersion:       broker.OperationRequestSchemaVersion,
		Status:              "succeeded",
		TargetReleaseRoot:   strings.Repeat("11", 32),
		TraceID:             request.Traceparent[3:35],
		VersionID:           "integration-test-version",
	}, nil
}

func main() {
	pipeName := flag.String(
		"pipe",
		broker.DefaultPipeName,
		"test-only package broker pipe",
	)
	flag.Parse()
	if flag.NArg() != 0 {
		_, _ = fmt.Fprintln(os.Stderr, "test harness arguments are invalid")
		os.Exit(2)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	server, err := broker.Listen(*pipeName, preflightHandler{})
	if err != nil {
		_, _ = fmt.Fprintln(os.Stderr, "start test package broker:", err)
		os.Exit(1)
	}
	defer server.Close()
	if err := server.Serve(ctx); err != nil {
		_, _ = fmt.Fprintln(os.Stderr, "serve test package broker:", err)
		os.Exit(1)
	}
}
