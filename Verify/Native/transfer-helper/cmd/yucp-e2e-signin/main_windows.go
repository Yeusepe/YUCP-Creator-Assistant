//go:build windows

// Throwaway prod-acceptance driver: triggers the broker's interactive sign-in.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"time"

	"github.com/yucp/transfer-helper/internal/broker"
)

func main() {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	result, err := broker.InvokeAuthentication(
		ctx,
		`\\.\pipe\yucp.package-broker.e2e`,
		"sign-in",
	)
	if err != nil {
		fmt.Fprintf(os.Stderr, "sign-in error: %v\n", err)
		os.Exit(1)
	}
	encoded, _ := json.MarshalIndent(result, "", "  ")
	fmt.Println(string(encoded))
}
