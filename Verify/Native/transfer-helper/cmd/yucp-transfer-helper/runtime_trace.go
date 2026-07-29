package main

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"strings"
)

func runtimeTraceparent(traceID string) (string, error) {
	traceID = strings.TrimSpace(traceID)
	if traceID == "" {
		return "", nil
	}
	rawTraceID, err := hex.DecodeString(traceID)
	if err != nil ||
		len(rawTraceID) != 16 ||
		traceID != strings.ToLower(traceID) {
		return "", fmt.Errorf("package runtime trace identifier is invalid")
	}
	var spanID [8]byte
	for {
		if _, err := rand.Read(spanID[:]); err != nil {
			return "", fmt.Errorf("generate package runtime span: %w", err)
		}
		if spanID != [8]byte{} {
			break
		}
	}
	return "00-" + traceID + "-" + hex.EncodeToString(spanID[:]) + "-01", nil
}
