//go:build windows && integrationharness

package main

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/yucp/transfer-helper/internal/broker"
)

func TestPreflightHandlerReturnsACompleteBoundTerminalResult(t *testing.T) {
	request := validPreflightRequest(t)
	result, err := preflightHandler{}.Handle(
		context.Background(),
		broker.ClientIdentity{ProcessID: 42, UserSID: "S-1-5-21-test"},
		request,
		func(string, int64, int64) error { return nil },
	)
	assertValidPreflightResult(t, request, result, err)
}

func TestHarnessRunsTheProductionNamedPipeProtocol(t *testing.T) {
	pipeName := `\\.\pipe\yucp-package-broker-harness-` + strings.ReplaceAll(
		t.Name(),
		"/",
		"-",
	)
	server, err := broker.Listen(pipeName, preflightHandler{})
	if err != nil {
		t.Fatalf("Listen() error = %v", err)
	}
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	go func() {
		_ = server.Serve(ctx)
	}()

	request := validPreflightRequest(t)
	var phases []string
	result, err := broker.Invoke(ctx, pipeName, request, func(progress broker.Progress) {
		phases = append(phases, progress.Phase)
	})
	assertValidPreflightResult(t, request, result, err)
	if strings.Join(phases, ",") != "preparing,verifying,finalizing" {
		t.Fatalf("progress phases = %#v", phases)
	}
}

func validPreflightRequest(t *testing.T) broker.OperationRequest {
	t.Helper()
	return broker.OperationRequest{
		AliasID:                    "jammr",
		ExpectedCurrentReleaseRoot: strings.Repeat("00", 32),
		IdempotencyKey:             "preflight-jammr-1",
		Operation:                  "preflight",
		ProjectIdentity:            strings.Repeat("22", 32),
		ProjectPath:                t.TempDir(),
		RunID:                      "run-jammr-preflight-1",
		SchemaVersion:              broker.OperationRequestSchemaVersion,
		Traceparent:                "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
	}
}

func assertValidPreflightResult(
	t *testing.T,
	request broker.OperationRequest,
	result broker.OperationResult,
	err error,
) {
	t.Helper()
	if err != nil {
		t.Fatalf("Handle() error = %v", err)
	}
	if result.SchemaVersion != broker.OperationRequestSchemaVersion ||
		result.RunID != request.RunID ||
		result.Operation != request.Operation ||
		result.TraceID != request.Traceparent[3:35] ||
		result.Status != "succeeded" ||
		result.ExitCode != 0 ||
		result.Files == nil ||
		len(result.Files) != 0 {
		t.Fatalf("result = %#v", result)
	}
}
