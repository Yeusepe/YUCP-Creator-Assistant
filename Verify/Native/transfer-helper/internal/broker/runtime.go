package broker

import (
	"context"
	"crypto/ecdsa"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"time"

	"github.com/yucp/transfer-helper/internal/deviceidentity"
	"github.com/yucp/transfer-helper/internal/diagnostics"
	"github.com/yucp/transfer-helper/internal/lifecycle"
	"github.com/yucp/transfer-helper/internal/telemetry"
	"github.com/yucp/transfer-helper/internal/trust"
)

const verificationWaitLimit = 5 * time.Minute

type CredentialProvider interface {
	Access(
		ctx context.Context,
		identity ClientIdentity,
		mode CredentialAccessMode,
		report ProgressReporter,
	) (OAuthTokens, deviceidentity.Identity, error)
}

type AuthenticationCredentialProvider interface {
	CredentialProvider
	Status(ctx context.Context, identity ClientIdentity) (bool, error)
	SignOut(ctx context.Context, identity ClientIdentity) error
}

type RemoteExchange interface {
	AuthorizeAndExchange(
		ctx context.Context,
		request OperationRequest,
		tokens OAuthTokens,
		privateKey *ecdsa.PrivateKey,
	) (AuthorizedOperation, error)
	Renew(
		ctx context.Context,
		renewal AuthorizationRenewal,
		tokens OAuthTokens,
		privateKey *ecdsa.PrivateKey,
	) (AuthorizedOperation, error)
}

type LifecycleExecutor interface {
	Execute(
		ctx context.Context,
		request lifecycle.AuthorizedRequest,
		identity deviceidentity.Identity,
		document trust.Document,
		report lifecycle.ProgressReporter,
	) (lifecycle.Result, error)
}

type Runtime struct {
	Credentials              CredentialProvider
	Exchange                 RemoteExchange
	Executor                 LifecycleExecutor
	LaunchURL                func(ClientIdentity, string) error
	Results                  *ResultStore
	StateRoot                string
	TrustDocument            trust.Document
	Telemetry                *telemetry.Client
	VerificationPollInterval time.Duration
}

func (runtime Runtime) HandleAuthentication(
	ctx context.Context,
	clientIdentity ClientIdentity,
	action string,
) (AuthenticationResult, error) {
	credentials, ok := runtime.Credentials.(AuthenticationCredentialProvider)
	if !ok {
		return AuthenticationResult{}, fmt.Errorf(
			"package broker authentication is not configured",
		)
	}
	record := diagnostics.New(runtime.StateRoot)
	switch action {
	case "status":
		signedIn, err := credentials.Status(ctx, clientIdentity)
		record.Failure(
			diagnostics.Event{
				Action:  action,
				Name:    "authentication",
				Outcome: signedInOutcome(signedIn, err),
			},
			err,
		)
		return AuthenticationResult{SignedIn: signedIn}, err
	case "sign-in":
		_, _, err := credentials.Access(
			ctx,
			clientIdentity,
			CredentialAccessInteractive,
			func(string, int64, int64, int64, int64) error { return nil },
		)
		record.Failure(
			diagnostics.Event{
				Action:  action,
				Name:    "authentication",
				Outcome: signedInOutcome(err == nil, err),
			},
			err,
		)
		return AuthenticationResult{SignedIn: err == nil}, err
	case "sign-out":
		err := credentials.SignOut(ctx, clientIdentity)
		record.Failure(
			diagnostics.Event{
				Action:  action,
				Name:    "authentication",
				Outcome: signedInOutcome(false, err),
			},
			err,
		)
		return AuthenticationResult{SignedIn: false}, err
	default:
		return AuthenticationResult{}, fmt.Errorf(
			"package broker authentication action is invalid",
		)
	}
}

func signedInOutcome(signedIn bool, failure error) string {
	if failure != nil {
		return "error"
	}
	if signedIn {
		return "signed-in"
	}
	return "signed-out"
}

func (runtime Runtime) Handle(
	ctx context.Context,
	clientIdentity ClientIdentity,
	request OperationRequest,
	report ProgressReporter,
) (OperationResult, error) {
	if runtime.Credentials == nil ||
		runtime.Exchange == nil ||
		runtime.Executor == nil ||
		runtime.LaunchURL == nil ||
		runtime.Results == nil ||
		runtime.StateRoot == "" {
		return OperationResult{}, fmt.Errorf("package broker runtime is not configured")
	}
	existing, found, err := runtime.Results.Load(clientIdentity.UserSID, request)
	if err != nil {
		return OperationResult{}, err
	}
	if found {
		return existing.withClientSchemaVersion(request), nil
	}
	record := diagnostics.New(runtime.StateRoot)
	startedAt := time.Now()
	traceID := ""
	if len(request.Traceparent) == 55 {
		traceID = request.Traceparent[3:35]
	}
	record.Write(diagnostics.Event{
		Name:      "operation.started",
		Operation: request.Operation,
		RunID:     request.RunID,
		TraceID:   traceID,
	})
	// The phase a run reached separates "never got authorized" from "died
	// halfway through the download".
	reached := ""
	result, operationErr := runtime.handleNew(
		ctx,
		clientIdentity,
		request,
		func(
			phase string,
			completedBytes int64,
			totalBytes int64,
			completedFiles int64,
			totalFiles int64,
		) error {
			if phase != reached {
				reached = phase
				record.Write(diagnostics.Event{
					Bytes:     completedBytes,
					Files:     completedFiles,
					Name:      "operation.phase",
					Operation: request.Operation,
					Phase:     phase,
					RunID:     request.RunID,
					TraceID:   traceID,
				})
			}
			return report(phase, completedBytes, totalBytes, completedFiles, totalFiles)
		},
	)
	if operationErr != nil {
		result = failedOperationResult(request, operationErr)
		record.Failure(
			diagnostics.Event{
				Code:      result.ErrorCode,
				Name:      "operation.failed",
				Operation: request.Operation,
				Phase:     reached,
				RunID:     request.RunID,
				TraceID:   traceID,
			},
			operationErr,
		)
		// Terminal failures reach here whether or not an install session was ever
		// issued, so this is the only funnel that can report pre-session failures
		// such as ErrAuthenticationRequired. Best effort: never alter the result.
		runtime.emitOperationalFailure(
			ctx,
			request,
			result,
			reached,
			operationErr,
			startedAt,
		)
	} else {
		record.Write(diagnostics.Event{
			Bytes:     result.LogicalBytes,
			Files:     int64(result.LogicalFiles),
			Name:      "operation.completed",
			Operation: request.Operation,
			Phase:     reached,
			RunID:     request.RunID,
			TraceID:   traceID,
		})
		runtime.emitOperationalCompletion(ctx, request, result, startedAt)
	}
	if result.Files == nil {
		result.Files = []OperationResultFile{}
	}
	if err := runtime.Results.Save(clientIdentity.UserSID, request, result); err != nil {
		return OperationResult{}, err
	}
	return result.withClientSchemaVersion(request), nil
}

func (runtime Runtime) handleNew(
	ctx context.Context,
	clientIdentity ClientIdentity,
	request OperationRequest,
	report ProgressReporter,
) (OperationResult, error) {
	if err := report("preparing", 0, 0, 0, 0); err != nil {
		return OperationResult{}, err
	}
	tokens, device, err := runtime.Credentials.Access(
		ctx,
		clientIdentity,
		CredentialAccessReuse,
		report,
	)
	// The local store reports signed out: either this device never signed in,
	// or its refresh token is expired or revoked. Nothing downstream can
	// recover from that, and failing here left the buyer with an
	// "authentication is required" error and no prompt. Sign in interactively
	// instead; the client already renders the "signing-in" phase this reports.
	// This is a local-state decision, so it cannot loop on a server rejection.
	if errors.Is(err, ErrAuthenticationRequired) {
		tokens, device, err = runtime.Credentials.Access(
			ctx,
			clientIdentity,
			CredentialAccessInteractive,
			report,
		)
	}
	if err != nil {
		return OperationResult{}, err
	}
	authorized, err := runtime.Exchange.AuthorizeAndExchange(
		ctx,
		request,
		tokens,
		device.PrivateKey,
	)
	// The server rejected a token the local store still considered current.
	// Refresh once and retry. Deliberately never escalate to interactive here:
	// a persistent server-side rejection would reopen the browser on every
	// attempt, which is the OAuth replay loop removed in 4cf7bbb1. Local
	// signed-out state is handled before this, where interactive is correct.
	if errors.Is(err, ErrAuthenticationRequired) {
		tokens, device, err = runtime.Credentials.Access(
			ctx,
			clientIdentity,
			CredentialAccessRefresh,
			report,
		)
		if err == nil {
			authorized, err = runtime.Exchange.AuthorizeAndExchange(
				ctx,
				request,
				tokens,
				device.PrivateKey,
			)
		}
	}
	var verification *VerificationRequiredError
	if errors.As(err, &verification) {
		authorized, tokens, device, err = runtime.waitForVerification(
			ctx,
			clientIdentity,
			request,
			tokens,
			device,
			verification,
			report,
		)
	}
	if err != nil {
		return OperationResult{}, err
	}
	targetRequest := request
	targetRequest.TargetReleaseRoot = authorized.ReleaseRoot
	lifecycleRequest, err := lifecycle.NewAuthorizedRequest(
		lifecycle.OperationInput{
			AliasID:                     targetRequest.AliasID,
			ApprovedActiveContentDigest: targetRequest.ApprovedActiveContentDigest,
			ApprovedPolicyVersion:       targetRequest.ApprovedPolicyVersion,
			ExpectedCurrentReleaseRoot:  targetRequest.ExpectedCurrentReleaseRoot,
			IdempotencyKey:              targetRequest.IdempotencyKey,
			Operation:                   targetRequest.Operation,
			ProjectIdentity:             targetRequest.ProjectIdentity,
			ProjectPath:                 targetRequest.ProjectPath,
			RunID:                       targetRequest.RunID,
			StateRoot:                   runtime.StateRoot,
			TargetReleaseRoot:           targetRequest.TargetReleaseRoot,
			Traceparent:                 targetRequest.Traceparent,
		},
		authorized.InstallSession,
		authorized.DeliveryGrant,
	)
	if err != nil {
		return OperationResult{}, err
	}
	lifecycleRequest = lifecycleRequest.WithTelemetry(runtime.Telemetry)
	lifecycleRequest, err = lifecycleRequest.WithRenewal(func(
		renewalContext context.Context,
		currentGrant string,
		currentSession string,
	) (string, string, error) {
		renewalTraceparent, traceErr := childTraceparent(request.Traceparent)
		if traceErr != nil {
			return "", "", traceErr
		}
		renewal := AuthorizationRenewal{
			DeliveryGrant:  currentGrant,
			InstallSession: currentSession,
			ReleaseRoot:    authorized.ReleaseRoot,
			Traceparent:    renewalTraceparent,
			VersionID:      authorized.VersionID,
		}
		renewed, renewErr := runtime.Exchange.Renew(
			renewalContext,
			renewal,
			tokens,
			device.PrivateKey,
		)
		if errors.Is(renewErr, ErrAuthenticationRequired) {
			refreshedTokens, refreshedDevice, refreshErr := runtime.Credentials.Access(
				renewalContext,
				clientIdentity,
				CredentialAccessRefresh,
				report,
			)
			if refreshErr != nil {
				return "", "", refreshErr
			}
			if refreshedDevice.Thumbprint != device.Thumbprint {
				return "", "", fmt.Errorf("renewed credentials changed the bound device")
			}
			tokens = refreshedTokens
			device = refreshedDevice
			renewed, renewErr = runtime.Exchange.Renew(
				renewalContext,
				renewal,
				tokens,
				device.PrivateKey,
			)
		}
		if renewErr != nil {
			return "", "", renewErr
		}
		authorized = renewed
		return renewed.InstallSession, renewed.DeliveryGrant, nil
	})
	if err != nil {
		return OperationResult{}, err
	}
	result, err := runtime.Executor.Execute(
		ctx,
		lifecycleRequest,
		device,
		runtime.TrustDocument,
		lifecycle.ProgressReporter(report),
	)
	if err != nil {
		return OperationResult{}, err
	}
	terminal := operationResultFromLifecycle(result)
	terminal.TraceID = request.Traceparent[3:35]
	return terminal, nil
}

func childTraceparent(parent string) (string, error) {
	if len(parent) != 55 {
		return "", fmt.Errorf("package operation trace context is invalid")
	}
	spanID := make([]byte, 8)
	if _, err := rand.Read(spanID); err != nil {
		return "", fmt.Errorf("create package renewal trace context: %w", err)
	}
	return parent[:36] + hex.EncodeToString(spanID) + parent[52:], nil
}

// emitOperationalFailure reports an anonymous failure record: a stable code and
// the redacted reason behind it, with no buyer identity, credential, or
// filesystem path, so it needs no diagnostics consent. A code without a reason
// is still an unexplained error, so the cause travels with it. Delivery is best
// effort and can never change the install result.
func (runtime Runtime) emitOperationalFailure(
	ctx context.Context,
	request OperationRequest,
	result OperationResult,
	phase string,
	operationErr error,
	startedAt time.Time,
) {
	if runtime.Telemetry == nil || !runtime.Telemetry.Enabled() {
		return
	}
	message := ""
	if operationErr != nil {
		message = operationErr.Error()
	}
	_ = runtime.Telemetry.Emit(ctx, telemetry.Event{
		DurationMS:  time.Since(startedAt).Milliseconds(),
		ErrorCode:   result.ErrorCode,
		Message:     message,
		Name:        "native.lifecycle.failed",
		Operation:   request.Operation,
		Phase:       phase,
		RunID:       request.RunID,
		Severity:    "error",
		Traceparent: request.Traceparent,
	})
}

// emitOperationalCompletion records how long a successful operation took. The
// client is the only vantage point that observes a whole install, so without it
// a slow install cannot be attributed between the server and local staging.
func (runtime Runtime) emitOperationalCompletion(
	ctx context.Context,
	request OperationRequest,
	result OperationResult,
	startedAt time.Time,
) {
	if runtime.Telemetry == nil || !runtime.Telemetry.Enabled() {
		return
	}
	_ = runtime.Telemetry.Emit(ctx, telemetry.Event{
		DurationMS:  time.Since(startedAt).Milliseconds(),
		Name:        "native.lifecycle.completed",
		Operation:   request.Operation,
		Phase:       result.JournalState,
		RunID:       request.RunID,
		Severity:    "info",
		Traceparent: request.Traceparent,
	})
}

func failedOperationResult(
	request OperationRequest,
	operationErr error,
) OperationResult {
	// The result carries only a stable code and a user-safe message; without
	// this line the underlying cause is unrecoverable from any log.
	fmt.Fprintf(
		os.Stderr,
		"package operation failed run=%s trace=%s: %v\n",
		request.RunID,
		request.Traceparent,
		operationErr,
	)
	code := lifecycle.ErrorCode(operationErr)
	message := "Package delivery failed. Try again. If the problem continues, contact support."
	switch {
	case errors.Is(operationErr, context.Canceled),
		errors.Is(operationErr, context.DeadlineExceeded):
		code = "OPERATION_CANCELLED"
		message = "The package operation was cancelled. Try again."
	case errors.Is(operationErr, ErrAuthenticationRequired):
		code = "AUTHENTICATION_REQUIRED"
		message = "Sign in to YUCP, then try again."
	case code == "":
		code = "PACKAGE_LIFECYCLE_FAILED"
	}
	return failedOperationResultWithCode(request, code, message)
}

// A client only accepts a result whose schemaVersion matches the request it sent,
// so every result is reported in the caller's version rather than the broker's.
func (result OperationResult) withClientSchemaVersion(
	request OperationRequest,
) OperationResult {
	if request.SchemaVersion >= MinimumOperationRequestSchemaVersion &&
		request.SchemaVersion <= OperationRequestSchemaVersion {
		result.SchemaVersion = request.SchemaVersion
	}
	return result
}

func failedOperationResultWithCode(
	request OperationRequest,
	code string,
	message string,
) OperationResult {
	// A rejected frame can reach here before the traceparent was validated, so the
	// span is sliced only when it is actually present.
	traceID := ""
	if len(request.Traceparent) >= 35 {
		traceID = request.Traceparent[3:35]
	}
	return OperationResult{
		ErrorCode:         code,
		ErrorMessage:      message,
		ExitCode:          1,
		Files:             []OperationResultFile{},
		JournalState:      "failed-before-project-mutation",
		Operation:         request.Operation,
		RunID:             request.RunID,
		SchemaVersion:     OperationRequestSchemaVersion,
		Status:            "failed",
		TargetReleaseRoot: request.ExpectedCurrentReleaseRoot,
		TraceID:           traceID,
	}.withClientSchemaVersion(request)
}

func (runtime Runtime) waitForVerification(
	ctx context.Context,
	clientIdentity ClientIdentity,
	request OperationRequest,
	tokens OAuthTokens,
	device deviceidentity.Identity,
	required *VerificationRequiredError,
	report ProgressReporter,
) (AuthorizedOperation, OAuthTokens, deviceidentity.Identity, error) {
	if required == nil || !validBrowserURL(required.URL) {
		return AuthorizedOperation{}, tokens, device, fmt.Errorf(
			"package verification URL is invalid",
		)
	}
	if err := runtime.LaunchURL(clientIdentity, required.URL); err != nil {
		return AuthorizedOperation{}, tokens, device, fmt.Errorf(
			"open package verification page: %w",
			err,
		)
	}
	if err := report("verifying-access", 0, 0, 0, 0); err != nil {
		return AuthorizedOperation{}, tokens, device, err
	}
	interval := runtime.VerificationPollInterval
	if interval <= 0 {
		interval = 2 * time.Second
	}
	waitContext, cancel := context.WithTimeout(ctx, verificationWaitLimit)
	defer cancel()
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	refreshedAfterAuthenticationFailure := false
	for {
		select {
		case <-waitContext.Done():
			return AuthorizedOperation{}, tokens, device, fmt.Errorf(
				"package ownership verification timed out",
			)
		case <-ticker.C:
			authorized, err := runtime.Exchange.AuthorizeAndExchange(
				waitContext,
				request,
				tokens,
				device.PrivateKey,
			)
			if err == nil {
				return authorized, tokens, device, nil
			}
			if errors.Is(err, ErrAuthenticationRequired) {
				if refreshedAfterAuthenticationFailure {
					return AuthorizedOperation{}, tokens, device, err
				}
				tokens, device, err = runtime.Credentials.Access(
					waitContext,
					clientIdentity,
					CredentialAccessRefresh,
					report,
				)
				if err != nil {
					return AuthorizedOperation{}, tokens, device, err
				}
				refreshedAfterAuthenticationFailure = true
				continue
			}
			var stillRequired *VerificationRequiredError
			if errors.As(err, &stillRequired) {
				continue
			}
			return AuthorizedOperation{}, tokens, device, err
		}
	}
}

func operationResultFromLifecycle(result lifecycle.Result) OperationResult {
	files := make([]OperationResultFile, 0, len(result.Files))
	for _, file := range result.Files {
		files = append(files, OperationResultFile{
			Bytes:          file.Bytes,
			NormalizedPath: file.NormalizedPath,
			SHA256:         file.SHA256,
		})
	}
	return OperationResult{
		ActiveContentDigest: result.ActiveContentDigest,
		ActivePolicyVersion: result.ActivePolicyVersion,
		ErrorCode:           result.ErrorCode,
		ErrorMessage:        result.ErrorMessage,
		ExitCode:            result.ExitCode,
		Files:               files,
		JournalState:        result.JournalState,
		LogicalBytes:        result.LogicalBytes,
		LogicalFiles:        result.LogicalFiles,
		Operation:           result.Operation,
		ReceiptID:           result.ReceiptID,
		ReceiptPath:         result.ReceiptPath,
		RunID:               result.RunID,
		SchemaVersion:       result.SchemaVersion,
		StagingTree:         result.StagingTree,
		Status:              result.Status,
		TargetReleaseRoot:   result.TargetReleaseRoot,
		TraceID:             result.TraceID,
		VersionID:           result.VersionID,
	}
}

type DefaultLifecycleExecutor struct{}

func (DefaultLifecycleExecutor) Execute(
	ctx context.Context,
	request lifecycle.AuthorizedRequest,
	identity deviceidentity.Identity,
	document trust.Document,
	report lifecycle.ProgressReporter,
) (lifecycle.Result, error) {
	return lifecycle.Execute(ctx, request, identity, document, report)
}
