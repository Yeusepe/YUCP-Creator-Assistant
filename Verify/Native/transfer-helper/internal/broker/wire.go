package broker

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
)

const (
	BrokerProtocolSchemaVersion = 1
	maxBrokerFrameBytes         = 1024 * 1024
)

type ClientIdentity struct {
	ProcessID uint32
	UserSID   string
}

type OperationResultFile struct {
	Bytes          int64  `json:"bytes"`
	NormalizedPath string `json:"normalizedPath"`
	SHA256         string `json:"sha256"`
}

type OperationResult struct {
	ActiveContentDigest string                `json:"activeContentDigest"`
	ActivePolicyVersion string                `json:"activePolicyVersion"`
	ErrorCode           string                `json:"errorCode"`
	ErrorMessage        string                `json:"errorMessage"`
	ExitCode            int                   `json:"exitCode"`
	Files               []OperationResultFile `json:"files"`
	JournalState        string                `json:"journalState"`
	LogicalBytes        int64                 `json:"logicalBytes"`
	LogicalFiles        int                   `json:"logicalFiles"`
	Operation           string                `json:"operation"`
	ReceiptID           string                `json:"receiptId,omitempty"`
	ReceiptPath         string                `json:"receiptPath,omitempty"`
	RunID               string                `json:"runId"`
	SchemaVersion       int                   `json:"schemaVersion"`
	StagingTree         string                `json:"stagingTree"`
	Status              string                `json:"status"`
	TargetReleaseRoot   string                `json:"targetReleaseRoot"`
	TraceID             string                `json:"traceId"`
	VersionID           string                `json:"versionId"`
}

type ProgressReporter func(
	phase string,
	completedBytes int64,
	totalBytes int64,
	completedFiles int64,
	totalFiles int64,
) error

type Handler interface {
	Handle(
		ctx context.Context,
		identity ClientIdentity,
		request OperationRequest,
		report ProgressReporter,
	) (OperationResult, error)
}

type AuthenticationResult struct {
	ErrorCode    string `json:"errorCode,omitempty"`
	ErrorMessage string `json:"errorMessage,omitempty"`
	SignedIn     bool   `json:"signedIn"`
}

type AuthenticationHandler interface {
	HandleAuthentication(
		ctx context.Context,
		identity ClientIdentity,
		action string,
	) (AuthenticationResult, error)
}

type HandlerFunc func(
	ctx context.Context,
	identity ClientIdentity,
	request OperationRequest,
	report ProgressReporter,
) (OperationResult, error)

func (handler HandlerFunc) Handle(
	ctx context.Context,
	identity ClientIdentity,
	request OperationRequest,
	report ProgressReporter,
) (OperationResult, error) {
	return handler(ctx, identity, request, report)
}

type beginFrame struct {
	ClientNonce   string `json:"clientNonce"`
	Kind          string `json:"kind"`
	SchemaVersion int    `json:"schemaVersion"`
}

type challengeFrame struct {
	ClientNonce    string `json:"clientNonce"`
	ExpiresAt      string `json:"expiresAt"`
	Kind           string `json:"kind"`
	OperationToken string `json:"operationToken"`
	SchemaVersion  int    `json:"schemaVersion"`
}

type operateFrame struct {
	Kind           string           `json:"kind"`
	OperationToken string           `json:"operationToken"`
	Request        OperationRequest `json:"request"`
	SchemaVersion  int              `json:"schemaVersion"`
}

type authenticationFrame struct {
	Action         string `json:"action"`
	Kind           string `json:"kind"`
	OperationToken string `json:"operationToken"`
	SchemaVersion  int    `json:"schemaVersion"`
}

type progressFrame struct {
	Kind          string   `json:"kind"`
	Progress      Progress `json:"progress"`
	SchemaVersion int      `json:"schemaVersion"`
}

type resultFrame struct {
	Kind          string          `json:"kind"`
	Result        OperationResult `json:"result"`
	SchemaVersion int             `json:"schemaVersion"`
}

type authenticationResultFrame struct {
	Authentication AuthenticationResult `json:"authentication"`
	Kind           string               `json:"kind"`
	SchemaVersion  int                  `json:"schemaVersion"`
}

type frameHeader struct {
	Kind          string `json:"kind"`
	SchemaVersion int    `json:"schemaVersion"`
}

func readFrame(reader *bufio.Reader, destination any) error {
	line, err := reader.ReadBytes('\n')
	if err != nil {
		if err == io.EOF && len(line) > 0 {
			return fmt.Errorf("broker frame is not newline terminated")
		}
		return fmt.Errorf("read broker frame: %w", err)
	}
	if len(line) > maxBrokerFrameBytes || len(bytes.TrimSpace(line)) == 0 {
		return fmt.Errorf("broker frame size is invalid")
	}
	decoder := json.NewDecoder(bytes.NewReader(line))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return fmt.Errorf("decode broker frame: %w", err)
	}
	if err := requireJSONEnd(decoder); err != nil {
		return err
	}
	return nil
}

func writeFrame(writer io.Writer, frame any) error {
	encoded, err := json.Marshal(frame)
	if err != nil {
		return fmt.Errorf("encode broker frame: %w", err)
	}
	if len(encoded)+1 > maxBrokerFrameBytes {
		return fmt.Errorf("broker frame is too large")
	}
	encoded = append(encoded, '\n')
	if _, err := writer.Write(encoded); err != nil {
		return fmt.Errorf("write broker frame: %w", err)
	}
	return nil
}

func validateProgress(event Progress) error {
	if event.SchemaVersion != BrokerProtocolSchemaVersion ||
		!safeIdentifierPattern.MatchString(event.RunID) ||
		event.Sequence <= 0 ||
		event.CompletedBytes < 0 ||
		event.TotalBytes < 0 ||
		(event.TotalBytes > 0 && event.CompletedBytes > event.TotalBytes) ||
		event.CompletedFiles < 0 ||
		event.TotalFiles < 0 ||
		(event.TotalFiles > 0 && event.CompletedFiles > event.TotalFiles) {
		return fmt.Errorf("broker progress event is invalid")
	}
	switch event.Phase {
	case "preparing", "signing-in", "verifying-access", "downloading", "personalizing",
		"verifying", "assembling", "finalizing":
		return nil
	default:
		return fmt.Errorf("broker progress phase is invalid")
	}
}

func validateAuthenticationAction(action string) error {
	switch action {
	case "sign-in", "sign-out", "status":
		return nil
	default:
		return fmt.Errorf("broker authentication action is invalid")
	}
}

func validateAuthenticationResult(result AuthenticationResult) error {
	if result.ErrorCode == "" {
		if result.ErrorMessage != "" {
			return fmt.Errorf("broker authentication result is invalid")
		}
		return nil
	}
	if !stableErrorCodePattern.MatchString(result.ErrorCode) ||
		result.ErrorMessage == "" ||
		result.SignedIn {
		return fmt.Errorf("broker authentication result is invalid")
	}
	return nil
}
