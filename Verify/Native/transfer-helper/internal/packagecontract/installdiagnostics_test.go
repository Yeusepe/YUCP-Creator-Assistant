package packagecontract

import (
	"os"
	"testing"
)

func TestExactLabelsRejectTheDiagnosticsClaim(t *testing.T) {
	labels := make([]int64, 22)
	for index := range labels {
		labels[index] = int64(index)
	}
	mapped := map[any]any{}
	for _, label := range labels {
		mapped[label] = int64(0)
	}
	if err := requireExactIntegerLabels(mapped, labels, "InstallSessionV2"); err != nil {
		t.Fatalf("session without the claim must stay readable: %v", err)
	}
	mapped[installSessionDiagnosticsLabel] = map[any]any{int64(0): true}
	if err := requireExactIntegerLabels(mapped, labels, "InstallSessionV2"); err == nil {
		t.Fatal("expected the pre-tolerance label check to reject the diagnostics claim")
	}
}

func TestParseInstallSessionAcceptsIssuerAddedDiagnostics(t *testing.T) {
	for _, testCase := range []struct {
		file            string
		name            string
		wantEnabled     bool
		wantDiagSession string
	}{
		{
			file: os.Getenv("YUCP_SESSION_PLAIN"),
			name: "without the claim",
		},
		{
			file:            os.Getenv("YUCP_SESSION_DIAGNOSTICS"),
			name:            "with the claim",
			wantEnabled:     true,
			wantDiagSession: "e8974a3f-0128-471f-8b7c-0b4386023610",
		},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			if testCase.file == "" {
				t.Skip("session vector path is not configured")
			}
			payload, err := os.ReadFile(testCase.file)
			if err != nil {
				t.Fatalf("read vector: %v", err)
			}
			session, err := ParseInstallSession(payload)
			if err != nil {
				t.Fatalf("parse session: %v", err)
			}
			if session.Diagnostics.Enabled != testCase.wantEnabled {
				t.Fatalf(
					"diagnostics enabled = %v, want %v",
					session.Diagnostics.Enabled,
					testCase.wantEnabled,
				)
			}
			if session.Diagnostics.SessionID != testCase.wantDiagSession {
				t.Fatalf(
					"diagnostics session = %q, want %q",
					session.Diagnostics.SessionID,
					testCase.wantDiagSession,
				)
			}
			if session.AliasID != "com.example.alias" {
				t.Fatalf("aliasId = %q", session.AliasID)
			}
		})
	}
}
