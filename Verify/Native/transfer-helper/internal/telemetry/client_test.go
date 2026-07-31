package telemetry

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const (
	testSessionID   = "01234567-89ab-4cde-8123-456789abcdef"
	testTraceparent = "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01"
)

// Without consent the client still reports an anonymous, code-only failure:
// authentication errors happen before any install session exists, so a
// consent-gated-only channel could never report them.
func TestClientSendsOperationalTierWithoutConsent(t *testing.T) {
	received := make(chan struct {
		header http.Header
		body   []byte
	}, 1)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		body, _ := io.ReadAll(request.Body)
		received <- struct {
			header http.Header
			body   []byte
		}{header: request.Header.Clone(), body: body}
		writer.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	client := NewClient(server.URL, "yucp-native-package-broker", "package-broker", "release-1")
	client.HTTPClient = server.Client()
	if client.Consented() {
		t.Fatal("client without a diagnostics session reported consent")
	}
	if err := client.Emit(context.Background(), Event{
		Name:        "native.lifecycle.failed",
		Severity:    "error",
		Operation:   "preflight",
		ErrorCode:   "AUTHENTICATION_REQUIRED",
		Traceparent: testTraceparent,
		Message:     `failed for buyer at C:\Users\buyer\project`,
	}); err != nil {
		t.Fatalf("Emit() error = %v", err)
	}

	request := <-received
	if request.header.Get("X-YUCP-Telemetry-Tier") != "operational" {
		t.Fatalf("telemetry tier header = %q", request.header.Get("X-YUCP-Telemetry-Tier"))
	}
	if request.header.Get("X-YUCP-Diagnostics-Session") != "" {
		t.Fatal("operational tier leaked a diagnostics session header")
	}
	var event Event
	if err := json.Unmarshal(request.body, &event); err != nil {
		t.Fatalf("decode event: %v", err)
	}
	if event.ErrorCode != "AUTHENTICATION_REQUIRED" {
		t.Fatalf("error code = %q", event.ErrorCode)
	}
	// A code with no reason is still an unexplained error, so the operational
	// tier keeps the cause — with paths and credentials stripped out of it.
	if event.Message == "" {
		t.Fatal("operational tier dropped the failure reason")
	}
	if !strings.Contains(event.Message, "failed for buyer") {
		t.Fatalf("operational tier lost the reason: %q", event.Message)
	}
	if strings.Contains(event.Message, `C:\Users\buyer`) ||
		strings.Contains(event.Message, "project") {
		t.Fatalf("operational tier leaked a filesystem path: %q", event.Message)
	}
}

func TestClientWithoutAPIBaseURLStaysSilent(t *testing.T) {
	client := NewClient("", "service", "process", "release")
	if client.Enabled() {
		t.Fatal("client without an API base URL reported enabled")
	}
	if err := client.Emit(context.Background(), Event{Name: "native.test"}); err != nil {
		t.Fatalf("Emit() returned an error for disabled telemetry: %v", err)
	}
}

func TestClientSendsRedactedCorrelatedMetadata(t *testing.T) {
	received := make(chan struct {
		header http.Header
		body   []byte
	}, 1)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		body, _ := io.ReadAll(request.Body)
		received <- struct {
			header http.Header
			body   []byte
		}{header: request.Header.Clone(), body: body}
		writer.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	client := NewClient(server.URL, "yucp-native-package-broker", "package-broker", "release-1").WithSession(testSessionID)
	client.HTTPClient = server.Client()
	if err := client.Emit(context.Background(), Event{
		Name:        "native.lifecycle.failed",
		Severity:    "error",
		Operation:   "install",
		ErrorCode:   "PACKAGE_API_INTERNAL_ERROR",
		RunID:       "run-1",
		Traceparent: testTraceparent,
		Message:     `request failed bearer super-secret at C:\Users\buyer\project`,
	}); err != nil {
		t.Fatalf("Emit() error = %v", err)
	}

	request := <-received
	if request.header.Get("X-YUCP-Diagnostics-Session") != testSessionID {
		t.Fatalf("diagnostics session header = %q", request.header.Get("X-YUCP-Diagnostics-Session"))
	}
	if request.header.Get("traceparent") != testTraceparent {
		t.Fatalf("traceparent header = %q", request.header.Get("traceparent"))
	}
	var event Event
	if err := json.Unmarshal(request.body, &event); err != nil {
		t.Fatalf("decode event: %v", err)
	}
	if event.Service != "yucp-native-package-broker" || event.Process != "package-broker" {
		t.Fatalf("service/process = %q/%q", event.Service, event.Process)
	}
	if event.Message == "" || event.Message == `request failed bearer super-secret at C:\Users\buyer\project` {
		t.Fatalf("message was not sanitized: %q", event.Message)
	}
	if event.Message == "" || strings.Contains(event.Message, "super-secret") || strings.Contains(event.Message, "C:\\Users\\buyer") {
		t.Fatalf("sanitized message contains sensitive data: %q", event.Message)
	}
}

func TestClientRejectsInvalidDiagnosticsSession(t *testing.T) {
	client := NewClient("https://api.example.test", "service", "process", "release").WithSession("not-a-uuid")
	if client.Consented() {
		t.Fatal("invalid diagnostics session granted consented telemetry")
	}
	if client.SessionID != "" {
		t.Fatalf("invalid diagnostics session was retained: %q", client.SessionID)
	}
}
