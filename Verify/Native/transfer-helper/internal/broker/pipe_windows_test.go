//go:build windows

package broker

import (
	"context"
	"errors"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestNamedPipeInvokesOneHighLevelOperationForAuthenticatedClient(t *testing.T) {
	pipeName := `\\.\pipe\yucp-package-broker-test-` + strings.ReplaceAll(
		t.Name(),
		"/",
		"-",
	)
	request := OperationRequest{
		AliasID:                    "jammr",
		ExpectedCurrentReleaseRoot: strings.Repeat("00", 32),
		IdempotencyKey:             "preflight-jammr-1",
		Operation:                  "preflight",
		ProjectIdentity:            strings.Repeat("22", 32),
		ProjectPath:                `C:\Unity\Project`,
		RunID:                      "run-jammr-preflight-1",
		SchemaVersion:              OperationRequestSchemaVersion,
		Traceparent:                "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
	}
	var receivedIdentity ClientIdentity
	server, err := Listen(pipeName, HandlerFunc(func(
		_ context.Context,
		identity ClientIdentity,
		received OperationRequest,
		report ProgressReporter,
	) (OperationResult, error) {
		receivedIdentity = identity
		if received != request {
			t.Fatalf("received request = %#v, want %#v", received, request)
		}
		if err := report("preparing", 0, 100); err != nil {
			return OperationResult{}, err
		}
		if err := report("finalizing", 100, 100); err != nil {
			return OperationResult{}, err
		}
		return OperationResult{
			ActiveContentDigest: strings.Repeat("33", 32),
			ActivePolicyVersion: "policy-v1",
			ExitCode:            0,
			Files:               []OperationResultFile{},
			JournalState:        "preflight-complete",
			Operation:           request.Operation,
			RunID:               request.RunID,
			SchemaVersion:       3,
			Status:              "succeeded",
			TargetReleaseRoot:   strings.Repeat("11", 32),
		}, nil
	}))
	if err != nil {
		t.Fatalf("Listen() error = %v", err)
	}
	defer server.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	go func() {
		_ = server.Serve(ctx)
	}()

	var progress []Progress
	result, err := Invoke(ctx, pipeName, request, func(event Progress) {
		progress = append(progress, event)
	})
	if err != nil {
		t.Fatalf("Invoke() error = %v", err)
	}
	if result.Status != "succeeded" || result.RunID != request.RunID {
		t.Fatalf("Invoke() result = %#v", result)
	}
	if len(progress) != 2 ||
		progress[0].Sequence != 1 ||
		progress[1].Sequence != 2 ||
		progress[1].CompletedBytes != 100 {
		t.Fatalf("progress = %#v", progress)
	}
	if receivedIdentity.ProcessID != uint32(os.Getpid()) || receivedIdentity.UserSID == "" {
		t.Fatalf("client identity = %#v", receivedIdentity)
	}
}

func TestNamedPipeReturnsBoundBusyResultAfterAuthenticatedRequest(t *testing.T) {
	pipeName := `\\.\pipe\yucp-package-broker-test-` + strings.ReplaceAll(
		t.Name(),
		"/",
		"-",
	)
	started := make(chan struct{}, maxConcurrentOperations)
	release := make(chan struct{})
	server, err := Listen(pipeName, HandlerFunc(func(
		ctx context.Context,
		_ ClientIdentity,
		request OperationRequest,
		_ ProgressReporter,
	) (OperationResult, error) {
		started <- struct{}{}
		select {
		case <-release:
			return succeededResult(request), nil
		case <-ctx.Done():
			return OperationResult{}, ctx.Err()
		}
	}))
	if err != nil {
		t.Fatalf("Listen() error = %v", err)
	}
	defer server.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	go func() {
		_ = server.Serve(ctx)
	}()

	var wait sync.WaitGroup
	wait.Add(maxConcurrentOperations)
	firstResults := make(chan error, maxConcurrentOperations)
	for index := 0; index < maxConcurrentOperations; index++ {
		request := validPipeRequest(t, "occupied-"+string(rune('a'+index)))
		go func() {
			defer wait.Done()
			_, invokeErr := Invoke(ctx, pipeName, request, nil)
			firstResults <- invokeErr
		}()
	}
	for index := 0; index < maxConcurrentOperations; index++ {
		select {
		case <-started:
		case <-ctx.Done():
			t.Fatal("timed out waiting for occupied broker slots")
		}
	}

	busyRequest := validPipeRequest(t, "busy")
	busy, err := Invoke(ctx, pipeName, busyRequest, nil)
	if err != nil {
		t.Fatalf("Invoke() busy error = %v", err)
	}
	if busy.ErrorCode != "BROKER_BUSY" ||
		busy.RunID != busyRequest.RunID ||
		busy.Operation != busyRequest.Operation ||
		busy.TraceID != busyRequest.Traceparent[3:35] ||
		busy.SchemaVersion != OperationRequestSchemaVersion ||
		busy.Status != "failed" ||
		busy.ExitCode != 1 ||
		busy.Files == nil ||
		len(busy.Files) != 0 {
		t.Fatalf("busy result = %#v", busy)
	}

	close(release)
	wait.Wait()
	close(firstResults)
	for invokeErr := range firstResults {
		if invokeErr != nil {
			t.Fatalf("occupied Invoke() error = %v", invokeErr)
		}
	}
}

func TestNamedPipeRedactsHandlerFailureAndReturnsCompleteTerminalResult(t *testing.T) {
	pipeName := `\\.\pipe\yucp-package-broker-test-` + strings.ReplaceAll(
		t.Name(),
		"/",
		"-",
	)
	const privateDetail = "secret provider response and filesystem path"
	server, err := Listen(pipeName, HandlerFunc(func(
		context.Context,
		ClientIdentity,
		OperationRequest,
		ProgressReporter,
	) (OperationResult, error) {
		return OperationResult{}, errors.New(privateDetail)
	}))
	if err != nil {
		t.Fatalf("Listen() error = %v", err)
	}
	defer server.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	go func() {
		_ = server.Serve(ctx)
	}()

	request := validPipeRequest(t, "handler-failure")
	result, err := Invoke(ctx, pipeName, request, nil)
	if err != nil {
		t.Fatalf("Invoke() error = %v", err)
	}
	if result.ErrorCode != "PACKAGE_LIFECYCLE_FAILED" ||
		result.ErrorMessage == "" ||
		strings.Contains(result.ErrorMessage, privateDetail) ||
		result.RunID != request.RunID ||
		result.Operation != request.Operation ||
		result.TraceID != request.Traceparent[3:35] ||
		result.TargetReleaseRoot != request.ExpectedCurrentReleaseRoot ||
		result.SchemaVersion != OperationRequestSchemaVersion ||
		result.Status != "failed" ||
		result.ExitCode != 1 ||
		result.Files == nil ||
		len(result.Files) != 0 {
		t.Fatalf("failure result = %#v", result)
	}
}

func validPipeRequest(t *testing.T, suffix string) OperationRequest {
	t.Helper()
	return OperationRequest{
		AliasID:                    "jammr",
		ExpectedCurrentReleaseRoot: strings.Repeat("00", 32),
		IdempotencyKey:             "operation-" + suffix,
		Operation:                  "preflight",
		ProjectIdentity:            strings.Repeat("22", 32),
		ProjectPath:                t.TempDir(),
		RunID:                      "run-" + suffix,
		SchemaVersion:              OperationRequestSchemaVersion,
		Traceparent:                "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
	}
}

func succeededResult(request OperationRequest) OperationResult {
	return OperationResult{
		ActiveContentDigest: strings.Repeat("33", 32),
		ActivePolicyVersion: "policy-v1",
		ExitCode:            0,
		Files:               []OperationResultFile{},
		JournalState:        "preflight-complete",
		Operation:           request.Operation,
		RunID:               request.RunID,
		SchemaVersion:       OperationRequestSchemaVersion,
		Status:              "succeeded",
		TargetReleaseRoot:   strings.Repeat("11", 32),
		TraceID:             request.Traceparent[3:35],
	}
}
