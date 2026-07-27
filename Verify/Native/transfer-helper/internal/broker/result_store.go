package broker

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const resultEnvelopeSchemaVersion = 1

type ResultStore struct {
	root string
}

type resultEnvelope struct {
	RequestSHA256 string          `json:"requestSha256"`
	Result        OperationResult `json:"result"`
	SchemaVersion int             `json:"schemaVersion"`
}

func NewResultStore(stateRoot string) (*ResultStore, error) {
	if !filepath.IsAbs(stateRoot) {
		return nil, fmt.Errorf("package broker state root must be absolute")
	}
	root := filepath.Join(stateRoot, "results")
	if err := os.MkdirAll(root, 0o700); err != nil {
		return nil, fmt.Errorf("create package broker result directory: %w", err)
	}
	return &ResultStore{root: root}, nil
}

func (store *ResultStore) Load(
	userSID string,
	request OperationRequest,
) (OperationResult, bool, error) {
	if store == nil || strings.TrimSpace(userSID) == "" {
		return OperationResult{}, false, fmt.Errorf("package broker result owner is invalid")
	}
	requestDigest, err := operationRequestDigest(request)
	if err != nil {
		return OperationResult{}, false, err
	}
	data, err := os.ReadFile(store.path(userSID, request.RunID))
	if errors.Is(err, os.ErrNotExist) {
		return OperationResult{}, false, nil
	}
	if err != nil {
		return OperationResult{}, false, fmt.Errorf("read package broker result: %w", err)
	}
	if len(data) == 0 || len(data) > maxBrokerFrameBytes {
		return OperationResult{}, false, fmt.Errorf("package broker result file size is invalid")
	}
	var envelope resultEnvelope
	if err := json.Unmarshal(data, &envelope); err != nil ||
		envelope.SchemaVersion != resultEnvelopeSchemaVersion ||
		envelope.RequestSHA256 != requestDigest ||
		validateOperationResult(envelope.Result, request) != nil {
		return OperationResult{}, false, fmt.Errorf("package broker result binding is invalid")
	}
	return envelope.Result, true, nil
}

func (store *ResultStore) Save(
	userSID string,
	request OperationRequest,
	result OperationResult,
) error {
	if store == nil || strings.TrimSpace(userSID) == "" {
		return fmt.Errorf("package broker result owner is invalid")
	}
	if err := validateOperationResult(result, request); err != nil {
		return err
	}
	requestDigest, err := operationRequestDigest(request)
	if err != nil {
		return err
	}
	envelope := resultEnvelope{
		RequestSHA256: requestDigest,
		Result:        result,
		SchemaVersion: resultEnvelopeSchemaVersion,
	}
	data, err := json.Marshal(envelope)
	if err != nil {
		return fmt.Errorf("encode package broker result: %w", err)
	}
	data = append(data, '\n')
	userRoot := store.userRoot(userSID)
	if err := os.MkdirAll(userRoot, 0o700); err != nil {
		return fmt.Errorf("create package broker user result directory: %w", err)
	}
	temporary, err := os.CreateTemp(userRoot, ".result-*.partial")
	if err != nil {
		return fmt.Errorf("create package broker result temporary file: %w", err)
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o600); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("restrict package broker result file: %w", err)
	}
	if _, err := temporary.Write(data); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("write package broker result: %w", err)
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("synchronize package broker result: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("close package broker result: %w", err)
	}
	destination := store.path(userSID, request.RunID)
	if err := os.Link(temporaryPath, destination); err != nil {
		if !errors.Is(err, os.ErrExist) {
			return fmt.Errorf("publish package broker result: %w", err)
		}
		existing, found, loadErr := store.Load(userSID, request)
		if loadErr != nil || !found {
			return fmt.Errorf("read concurrently published package broker result")
		}
		existingData, _ := json.Marshal(existing)
		resultData, _ := json.Marshal(result)
		if string(existingData) != string(resultData) {
			return fmt.Errorf("package broker result already exists with different content")
		}
	}
	return nil
}

func operationRequestDigest(request OperationRequest) (string, error) {
	if err := validateOperationRequest(request); err != nil {
		return "", err
	}
	data, err := json.Marshal(request)
	if err != nil {
		return "", fmt.Errorf("encode package operation request binding: %w", err)
	}
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:]), nil
}

func validateOperationResult(result OperationResult, request OperationRequest) error {
	if result.SchemaVersion != OperationRequestSchemaVersion ||
		result.RunID != request.RunID ||
		result.Operation != request.Operation ||
		(result.Status != "succeeded" && result.Status != "failed") ||
		result.ExitCode < 0 ||
		(result.Status == "succeeded" && result.ExitCode != 0) ||
		(result.Status == "failed" && result.ExitCode == 0) ||
		(result.Status == "failed" &&
			!stableErrorCodePattern.MatchString(result.ErrorCode)) ||
		(result.Status == "succeeded" &&
			(!isDigest(result.TargetReleaseRoot) ||
				!isDigest(result.ActiveContentDigest) ||
				strings.TrimSpace(result.ActivePolicyVersion) == "")) ||
		(result.Status == "failed" &&
			result.TargetReleaseRoot != "" &&
			!isDigest(result.TargetReleaseRoot)) ||
		result.LogicalBytes < 0 ||
		result.LogicalFiles < 0 ||
		result.Files == nil ||
		!safeTerminalPath(result.StagingTree) ||
		!safeTerminalPath(result.ReceiptPath) {
		return fmt.Errorf("package broker terminal result is invalid")
	}
	for _, file := range result.Files {
		if file.Bytes < 0 ||
			!isDigest(file.SHA256) ||
			strings.TrimSpace(file.NormalizedPath) == "" {
			return fmt.Errorf("package broker terminal result file is invalid")
		}
	}
	return nil
}

func safeTerminalPath(value string) bool {
	return value == "" ||
		(filepath.IsAbs(value) && !strings.ContainsRune(value, '\x00'))
}

func (store *ResultStore) userRoot(userSID string) string {
	digest := sha256.Sum256([]byte(userSID))
	return filepath.Join(store.root, hex.EncodeToString(digest[:]))
}

func (store *ResultStore) path(userSID string, runID string) string {
	return filepath.Join(store.userRoot(userSID), runID+".json")
}
