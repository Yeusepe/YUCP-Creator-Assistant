package broker

import (
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestResultStorePersistsOnlyAnExactlyBoundTerminalResult(t *testing.T) {
	store, err := NewResultStore(t.TempDir())
	if err != nil {
		t.Fatalf("NewResultStore() error = %v", err)
	}
	request := OperationRequest{
		AliasID:                    "jammr",
		ExpectedCurrentReleaseRoot: strings.Repeat("00", 32),
		IdempotencyKey:             "preflight-jammr-1",
		Operation:                  "preflight",
		ProjectIdentity:            strings.Repeat("22", 32),
		ProjectPath:                t.TempDir(),
		RunID:                      "run-jammr-preflight-1",
		SchemaVersion:              OperationRequestSchemaVersion,
		Traceparent:                "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
	}
	result := OperationResult{
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
	}
	if err := store.Save("S-1-5-21-test", request, result); err != nil {
		t.Fatalf("Save() error = %v", err)
	}
	if err := store.Save("S-1-5-21-test", request, result); err != nil {
		t.Fatalf("idempotent Save() error = %v", err)
	}
	loaded, found, err := store.Load("S-1-5-21-test", request)
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if !found || !reflect.DeepEqual(loaded, result) {
		t.Fatalf("Load() = %#v, %t, want %#v", loaded, found, result)
	}
	changed := request
	changed.Traceparent = "00-1123456789abcdef0123456789abcdef-0123456789abcdef-01"
	if _, _, err := store.Load("S-1-5-21-test", changed); err == nil {
		t.Fatal("Load() accepted a run ID with different request bindings")
	}
}

func TestValidateOperationResultMatchesUnityTerminalContract(t *testing.T) {
	request := OperationRequest{
		AliasID:                     "jammr",
		ExpectedCurrentReleaseRoot:  strings.Repeat("00", 32),
		IdempotencyKey:              "install-jammr-1",
		Operation:                   "install",
		ProjectIdentity:             strings.Repeat("22", 32),
		ProjectPath:                 t.TempDir(),
		RunID:                       "run-jammr-install-1",
		SchemaVersion:               OperationRequestSchemaVersion,
		Traceparent:                 "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
		ApprovedActiveContentDigest: strings.Repeat("33", 32),
		ApprovedPolicyVersion:       "policy-v1",
	}
	valid := OperationResult{
		ActiveContentDigest: strings.Repeat("33", 32),
		ActivePolicyVersion: "policy-v1",
		ExitCode:            0,
		Files: []OperationResultFile{{
			Bytes:          42,
			NormalizedPath: "Assets/JAMMR/file.png",
			SHA256:         strings.Repeat("44", 32),
		}},
		JournalState:      "committed",
		LogicalBytes:      42,
		LogicalFiles:      1,
		Operation:         request.Operation,
		ReceiptPath:       filepath.Join(t.TempDir(), "receipt.cbor"),
		RunID:             request.RunID,
		SchemaVersion:     OperationRequestSchemaVersion,
		StagingTree:       filepath.Join(t.TempDir(), "staging"),
		Status:            "succeeded",
		TargetReleaseRoot: strings.Repeat("11", 32),
		TraceID:           request.Traceparent[3:35],
	}
	tests := []struct {
		name   string
		mutate func(*OperationResult)
	}{
		{"negative exit", func(result *OperationResult) { result.ExitCode = -1 }},
		{"missing target", func(result *OperationResult) { result.TargetReleaseRoot = "" }},
		{"missing active digest", func(result *OperationResult) { result.ActiveContentDigest = "" }},
		{"missing policy", func(result *OperationResult) { result.ActivePolicyVersion = "" }},
		{"negative logical bytes", func(result *OperationResult) { result.LogicalBytes = -1 }},
		{"negative logical files", func(result *OperationResult) { result.LogicalFiles = -1 }},
		{"nil files", func(result *OperationResult) { result.Files = nil }},
		{"negative file bytes", func(result *OperationResult) { result.Files[0].Bytes = -1 }},
		{"invalid file digest", func(result *OperationResult) { result.Files[0].SHA256 = "invalid" }},
		{"missing file path", func(result *OperationResult) { result.Files[0].NormalizedPath = " " }},
		{"relative staging path", func(result *OperationResult) { result.StagingTree = "staging" }},
		{"relative receipt path", func(result *OperationResult) { result.ReceiptPath = "receipt.cbor" }},
		{
			"missing failure code",
			func(result *OperationResult) {
				result.Status = "failed"
				result.ExitCode = 1
				result.ErrorCode = ""
				result.ActiveContentDigest = ""
				result.ActivePolicyVersion = ""
				result.TargetReleaseRoot = ""
			},
		},
		{
			"unstable failure code",
			func(result *OperationResult) {
				result.Status = "failed"
				result.ExitCode = 1
				result.ErrorCode = "not stable"
				result.ActiveContentDigest = ""
				result.ActivePolicyVersion = ""
				result.TargetReleaseRoot = ""
			},
		},
	}
	if err := validateOperationResult(valid, request); err != nil {
		t.Fatalf("validateOperationResult(valid) error = %v", err)
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			result := valid
			result.Files = append([]OperationResultFile(nil), valid.Files...)
			test.mutate(&result)
			if err := validateOperationResult(result, request); err == nil {
				t.Fatal("validateOperationResult() accepted an incompatible result")
			}
		})
	}
}
