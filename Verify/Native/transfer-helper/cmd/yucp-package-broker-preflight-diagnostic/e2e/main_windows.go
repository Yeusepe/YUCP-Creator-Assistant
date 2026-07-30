//go:build windows

package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"time"

	"github.com/yucp/transfer-helper/internal/broker"
)

const (
	pipeName        = `\\.\pipe\yucp.package-broker.e2e`
	aliasID         = "com.lunar.druffle"
	projectPath     = `E:\Unity\yucp-e2e`
	projectIdentity = "018786cab94742abd3111d027746bd378e056f2dfa492180887d4a8b1dd58023"
	zeroRoot        = "0000000000000000000000000000000000000000000000000000000000000000"
)

func run(operation string, target string, approvedDigest string, approvedPolicy string) (broker.OperationResult, error) {
	span := make([]byte, 8)
	trace := make([]byte, 16)
	_, _ = rand.Read(span)
	_, _ = rand.Read(trace)
	runID := "e2e-" + operation + "-" + hex.EncodeToString(span)
	request := broker.OperationRequest{
		AliasID:                     aliasID,
		ApprovedActiveContentDigest: approvedDigest,
		ApprovedPolicyVersion:       approvedPolicy,
		ExpectedCurrentReleaseRoot:  zeroRoot,
		IdempotencyKey:              runID,
		Operation:                   operation,
		ProjectIdentity:             projectIdentity,
		ProjectPath:                 projectPath,
		RunID:                       runID,
		SchemaVersion:               broker.OperationRequestSchemaVersion,
		TargetReleaseRoot:           target,
		Traceparent:                 "00-" + hex.EncodeToString(trace) + "-" + hex.EncodeToString(span) + "-01",
	}
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Minute)
	defer cancel()
	return broker.Invoke(ctx, pipeName, request, func(progress broker.Progress) {
		fmt.Fprintf(
			os.Stderr,
			"[%s] CLIENT progress phase=%s completed=%d total=%d seq=%d\n",
			time.Now().UTC().Format("15:04:05.000"),
			progress.Phase,
			progress.CompletedBytes,
			progress.TotalBytes,
			progress.Sequence,
		)
	})
}

func main() {
	preflight, err := run("preflight", "", "", "")
	if err != nil {
		fmt.Fprintf(os.Stderr, "preflight invoke error: %v\n", err)
		os.Exit(1)
	}
	encoded, _ := json.Marshal(preflight)
	fmt.Printf("PREFLIGHT: %s\n", encoded)
	if preflight.Status != "succeeded" {
		os.Exit(1)
	}
	install, err := run(
		"install",
		preflight.TargetReleaseRoot,
		preflight.ActiveContentDigest,
		preflight.ActivePolicyVersion,
	)
	if err != nil {
		fmt.Fprintf(os.Stderr, "install invoke error: %v\n", err)
		os.Exit(1)
	}
	encoded, _ = json.MarshalIndent(install, "", "  ")
	fmt.Printf("INSTALL: %s\n", encoded)
	if install.Status != "succeeded" {
		os.Exit(1)
	}
}
