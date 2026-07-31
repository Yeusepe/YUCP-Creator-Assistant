package telemetry

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"runtime"
	"strings"
	"time"
)

const (
	maxPayloadBytes = 12 * 1024
	maxTextLength   = 2 * 1024
	requestTimeout  = 2 * time.Second
)

var (
	diagnosticsSessionPattern = regexp.MustCompile(
		`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`,
	)
	traceparentPattern = regexp.MustCompile(
		`^00-[0-9a-f]{32}-[0-9a-f]{16}-(00|01)$`,
	)
	secretPattern = regexp.MustCompile(
		`(?i)(bearer\s+|(?:access[_-]?token|refresh[_-]?token|api[_-]?key|password|secret|authorization)\s*[:=]\s*)[^\s,;]+`,
	)
	pathPattern = regexp.MustCompile(`(?:[A-Za-z]:\\|/)[^\s,;]+`)
)

// Event contains only operational metadata. Request and response bodies,
// credentials, cookies, project paths, and signed package documents are not
// accepted by this client.
type Event struct {
	Name        string `json:"event"`
	Severity    string `json:"severity,omitempty"`
	Service     string `json:"service,omitempty"`
	Process     string `json:"process,omitempty"`
	Operation   string `json:"operation,omitempty"`
	Phase       string `json:"phase,omitempty"`
	ErrorCode   string `json:"errorCode,omitempty"`
	HTTPStatus  int    `json:"status,omitempty"`
	DurationMS  int64  `json:"durationMs,omitempty"`
	RunID       string `json:"runId,omitempty"`
	Traceparent string `json:"traceparent,omitempty"`
	ReleaseID   string `json:"releaseId,omitempty"`
	OS          string `json:"os,omitempty"`
	Arch        string `json:"arch,omitempty"`
	Message     string `json:"message,omitempty"`
}

// Client sends consented native diagnostics to the first-party API. It is
// deliberately keyless: HyperDX credentials stay in the server environment.
type Client struct {
	APIBaseURL string
	SessionID  string
	Service    string
	Process    string
	ReleaseID  string
	HTTPClient *http.Client
}

func NewClient(apiBaseURL, service, process, releaseID string) Client {
	return Client{
		APIBaseURL: strings.TrimRight(strings.TrimSpace(apiBaseURL), "/"),
		Service:    truncate(service),
		Process:    truncate(process),
		ReleaseID:  truncate(releaseID),
	}
}

// WithSession returns a copy enabled only for a valid signed diagnostics
// session identifier. Invalid or absent consent disables native telemetry.
func (client Client) WithSession(sessionID string) Client {
	client.SessionID = ""
	if diagnosticsSessionPattern.MatchString(strings.ToLower(strings.TrimSpace(sessionID))) {
		client.SessionID = strings.ToLower(strings.TrimSpace(sessionID))
	}
	return client
}

// Enabled reports whether the client may send the operational tier: anonymous
// failure records carrying a stable code and a redacted reason, but no buyer
// identity, credential, or filesystem path. The product emits redacted
// operational failures without optional consent; consent only adds
// user-associated correlation.
func (client Client) Enabled() bool {
	return client.APIBaseURL != "" && client.Service != ""
}

// Consented reports whether a signed diagnostics session permits the richer
// tier (redacted message plus diagnostics-session correlation).
func (client Client) Consented() bool {
	return client.Enabled() && client.SessionID != ""
}

// Emit is best effort. Telemetry must never make an install fail or obscure
// the original operational error.
//
// Without consent the event is downgraded to the operational tier rather than
// dropped: authentication failures happen before any install session exists, so
// a consent-gated-only channel can never report them.
func (client Client) Emit(_ context.Context, event Event) error {
	if !client.Enabled() {
		return nil
	}
	consented := client.Consented()
	// Both tiers carry the reason. A stable code alone cannot distinguish a
	// server rejection from a disk failure, which is the whole point of
	// reporting. normalizeEvent strips credentials and filesystem paths from
	// the message, and the API redacts again, so the operational tier stays
	// anonymous without becoming an unexplained error.
	endpoint, err := telemetryEndpoint(client.APIBaseURL)
	if err != nil {
		return err
	}

	event = client.normalizeEvent(event)
	payload, err := json.Marshal(event)
	if err != nil {
		return err
	}
	if len(payload) > maxPayloadBytes {
		return fmt.Errorf("native telemetry payload is too large")
	}

	requestContext, cancel := context.WithTimeout(context.Background(), requestTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(
		requestContext,
		http.MethodPost,
		endpoint,
		bytes.NewReader(payload),
	)
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	if consented {
		request.Header.Set("X-YUCP-Diagnostics-Session", client.SessionID)
		request.Header.Set("X-YUCP-Telemetry-Tier", "diagnostics")
	} else {
		request.Header.Set("X-YUCP-Telemetry-Tier", "operational")
	}
	if traceparentPattern.MatchString(event.Traceparent) {
		request.Header.Set("traceparent", event.Traceparent)
	}
	httpClient := client.HTTPClient
	if httpClient == nil {
		httpClient = http.DefaultClient
	}
	response, err := httpClient.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("native telemetry endpoint returned HTTP %d", response.StatusCode)
	}
	return nil
}

func (client Client) normalizeEvent(event Event) Event {
	event.Name = truncate(event.Name)
	event.Severity = truncate(event.Severity)
	event.Service = firstNonEmpty(truncate(event.Service), client.Service)
	event.Process = firstNonEmpty(truncate(event.Process), client.Process)
	event.Operation = truncate(event.Operation)
	event.Phase = truncate(event.Phase)
	event.ErrorCode = truncate(event.ErrorCode)
	event.RunID = truncate(event.RunID)
	event.Traceparent = strings.TrimSpace(event.Traceparent)
	event.ReleaseID = firstNonEmpty(truncate(event.ReleaseID), client.ReleaseID)
	event.OS = firstNonEmpty(truncate(event.OS), runtime.GOOS)
	event.Arch = firstNonEmpty(truncate(event.Arch), runtime.GOARCH)
	event.Message = sanitizeMessage(event.Message)
	if event.Severity == "" {
		event.Severity = "info"
	}
	return event
}

func telemetryEndpoint(base string) (string, error) {
	parsed, err := url.Parse(strings.TrimRight(strings.TrimSpace(base), "/"))
	if err != nil || parsed.Scheme == "" || parsed.Host == "" || parsed.User != nil {
		return "", fmt.Errorf("native telemetry API base URL is invalid")
	}
	if parsed.Scheme != "https" && !isLocalHTTPHost(parsed.Scheme, parsed.Hostname()) {
		return "", fmt.Errorf("native telemetry API base URL must use HTTPS")
	}
	parsed.Path = strings.TrimRight(parsed.Path, "/") + "/api/telemetry/native"
	parsed.RawQuery = ""
	parsed.Fragment = ""
	return parsed.String(), nil
}

func isLocalHTTPHost(scheme, hostname string) bool {
	if scheme != "http" {
		return false
	}
	hostname = strings.ToLower(hostname)
	return hostname == "localhost" || hostname == "127.0.0.1" || hostname == "::1"
}

func sanitizeMessage(value string) string {
	message := strings.TrimSpace(value)
	message = secretPattern.ReplaceAllString(message, "[REDACTED]")
	message = pathPattern.ReplaceAllString(message, "[PATH_REDACTED]")
	return truncate(message)
}

func truncate(value string) string {
	value = strings.TrimSpace(value)
	if len(value) <= maxTextLength {
		return value
	}
	return value[:maxTextLength]
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}
