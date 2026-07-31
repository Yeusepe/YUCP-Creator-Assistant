// Package diagnostics records what the runtime did and what went wrong, in a
// file a buyer can hand back to support. Nothing written here may identify the
// person running it or what is in their project: every free text field is
// redacted on the way to disk.
package diagnostics

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

const (
	maxLogBytes         = 1 << 20
	maxDetailCharacters = 2048
)

type Event struct {
	Action    string `json:"action,omitempty"`
	At        string `json:"at"`
	Bytes     int64  `json:"bytes,omitempty"`
	Code      string `json:"code,omitempty"`
	Detail    string `json:"detail,omitempty"`
	Files     int64  `json:"files,omitempty"`
	Name      string `json:"name"`
	Operation string `json:"operation,omitempty"`
	Outcome   string `json:"outcome,omitempty"`
	Phase     string `json:"phase,omitempty"`
	RunID     string `json:"runId,omitempty"`
	TraceID   string `json:"traceId,omitempty"`
}

type Writer struct {
	mu   sync.Mutex
	path string
}

func New(stateRoot string) *Writer {
	if stateRoot == "" {
		return nil
	}
	return &Writer{
		path: filepath.Join(stateRoot, "diagnostics", "operations.log"),
	}
}

// Write never reports failure: a diagnostic that cannot be recorded must not
// take an install down with it.
func (writer *Writer) Write(event Event) {
	if writer == nil || event.Name == "" {
		return
	}
	event.At = time.Now().UTC().Format(time.RFC3339Nano)
	event.Code = Redact(event.Code)
	event.Detail = Redact(event.Detail)
	line, err := json.Marshal(event)
	if err != nil {
		return
	}
	writer.mu.Lock()
	defer writer.mu.Unlock()
	if err := os.MkdirAll(filepath.Dir(writer.path), 0o700); err != nil {
		return
	}
	writer.rotate()
	file, err := os.OpenFile(writer.path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	defer file.Close()
	_, _ = file.Write(append(line, '\n'))
}

func (writer *Writer) rotate() {
	info, err := os.Stat(writer.path)
	if err != nil || info.Size() < maxLogBytes {
		return
	}
	previous := filepath.Join(filepath.Dir(writer.path), "operations.previous.log")
	_ = os.Remove(previous)
	_ = os.Rename(writer.path, previous)
}

func (writer *Writer) Failure(event Event, failure error) {
	if failure != nil {
		event.Detail = fmt.Sprintf("%v", failure)
	}
	writer.Write(event)
}

var (
	pathPattern = regexp.MustCompile(`(?i)[a-z]:\\[^\s"']*|\\\\[^\s"']+`)
	// Whatever follows one of these names is a secret whatever it is encoded
	// as, so the name is a surer signal than the shape.
	secretPattern = regexp.MustCompile(
		`(?i)\b(authorization|grant|proof|receipt|secret|session|token)=\S+`,
	)
	// A signed envelope splits into long base64url segments; hostnames and
	// versions dot up too, but never in runs this long.
	envelopePattern = regexp.MustCompile(
		`[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}(?:\.[A-Za-z0-9_-]+)?`,
	)
	// Access tokens, grants and receipts are base64url; a sha256 is hex and
	// names no one, so it stays readable.
	opaquePattern = regexp.MustCompile(`[A-Za-z0-9_-]{40,}`)
	hexPattern    = regexp.MustCompile(`^[0-9a-fA-F]+$`)
)

func Redact(message string) string {
	if message == "" {
		return ""
	}
	redacted := pathPattern.ReplaceAllString(message, "<path>")
	redacted = secretPattern.ReplaceAllStringFunc(redacted, func(assignment string) string {
		return assignment[:strings.Index(assignment, "=")+1] + "<token>"
	})
	redacted = envelopePattern.ReplaceAllString(redacted, "<token>")
	redacted = opaquePattern.ReplaceAllStringFunc(redacted, func(token string) string {
		if hexPattern.MatchString(token) {
			return token
		}
		return "<token>"
	})
	if len(redacted) > maxDetailCharacters {
		redacted = redacted[:maxDetailCharacters]
	}
	return redacted
}
