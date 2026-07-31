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

func main() {
	span := make([]byte, 8)
	trace := make([]byte, 16)
	_, _ = rand.Read(span)
	_, _ = rand.Read(trace)
	runID := "preflight-diagnostic-" + hex.EncodeToString(span)
	aliasID := "com.lunararray.druffle"
	operation := "preflight"
	if len(os.Args) > 1 {
		aliasID = os.Args[1]
	}
	if len(os.Args) > 2 {
		operation = os.Args[2]
	}
	request := broker.OperationRequest{
		AliasID:                    aliasID,
		ExpectedCurrentReleaseRoot: "0000000000000000000000000000000000000000000000000000000000000000",
		IdempotencyKey:             runID,
		Operation:                  operation,
		ProjectIdentity:            "deca070897d28139d38e70be2c079eca746b66a7dc7b5c9b3c6ad06eef264ff5",
		ProjectPath:                `E:\Unity\ImportTesting`,
		RunID:                      runID,
		SchemaVersion:              broker.OperationRequestSchemaVersion,
		Traceparent:                "00-" + hex.EncodeToString(trace) + "-" + hex.EncodeToString(span) + "-01",
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	result, err := broker.Invoke(
		ctx,
		`\\.\pipe\yucp.package-broker.v1`,
		request,
		func(progress broker.Progress) {
			fmt.Fprintf(os.Stderr, "progress: %+v\n", progress)
		},
	)
	if err != nil {
		fmt.Fprintf(os.Stderr, "invoke error: %v\n", err)
		os.Exit(1)
	}
	encoded, _ := json.MarshalIndent(result, "", "  ")
	fmt.Println(string(encoded))
}
