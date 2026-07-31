package diagnostics

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRedactRemovesEverythingThatNamesTheBuyer(t *testing.T) {
	redacted := Redact(
		`open C:\Users\jordan\AppData\Local\YUCP\state\x.json: not found ` +
			`grant=eyJhbGciOiJFUzI1NiJ9.abcdefghijklmnopqrstuvwxyz012345678 ` +
			`sha256=3c1f5acb8089d990d941b02cc05a3e582279c9a45543321b3d95bf8ede94f8d3`,
	)
	if strings.Contains(redacted, "jordan") ||
		strings.Contains(redacted, `C:\Users`) {
		t.Fatalf("Redact() kept a user path: %q", redacted)
	}
	if strings.Contains(redacted, "eyJhbGciOiJFUzI1NiJ9") {
		t.Fatalf("Redact() kept a token: %q", redacted)
	}
	if !strings.Contains(
		redacted,
		"3c1f5acb8089d990d941b02cc05a3e582279c9a45543321b3d95bf8ede94f8d3",
	) {
		t.Fatalf("Redact() dropped the content digest: %q", redacted)
	}
	if !strings.Contains(redacted, "not found") {
		t.Fatalf("Redact() dropped the failure itself: %q", redacted)
	}
}

func TestWriteAppendsRedactedEventsAndRotates(t *testing.T) {
	stateRoot := t.TempDir()
	writer := New(stateRoot)
	writer.Write(Event{
		Name:      "operation.started",
		Operation: "install",
		RunID:     "run-1",
	})
	writer.Failure(
		Event{
			Code:      "PACKAGE_LIFECYCLE_FAILED",
			Name:      "operation.failed",
			Operation: "install",
			Phase:     "personalizing",
			RunID:     "run-1",
		},
		os.ErrNotExist,
	)

	path := filepath.Join(stateRoot, "diagnostics", "operations.log")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile() error = %v", err)
	}
	lines := strings.Split(strings.TrimSpace(string(raw)), "\n")
	if len(lines) != 2 {
		t.Fatalf("log lines = %d, want 2", len(lines))
	}
	var failed Event
	if err := json.Unmarshal([]byte(lines[1]), &failed); err != nil {
		t.Fatalf("Unmarshal() error = %v", err)
	}
	if failed.Phase != "personalizing" ||
		failed.Code != "PACKAGE_LIFECYCLE_FAILED" ||
		failed.Detail != os.ErrNotExist.Error() ||
		failed.At == "" {
		t.Fatalf("failure event = %+v", failed)
	}

	if err := os.WriteFile(path, make([]byte, maxLogBytes), 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}
	writer.Write(Event{Name: "operation.started", RunID: "run-2"})
	rotated, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile() after rotation error = %v", err)
	}
	if len(strings.Split(strings.TrimSpace(string(rotated)), "\n")) != 1 {
		t.Fatal("rotation did not start a new log")
	}
	if _, err := os.Stat(filepath.Join(
		stateRoot,
		"diagnostics",
		"operations.previous.log",
	)); err != nil {
		t.Fatalf("previous log missing: %v", err)
	}
}
