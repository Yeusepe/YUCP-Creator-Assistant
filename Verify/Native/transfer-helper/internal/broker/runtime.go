package broker

import (
	"context"
	"crypto/ecdsa"
	"errors"
	"fmt"
	"time"

	"github.com/yucp/transfer-helper/internal/deviceidentity"
	"github.com/yucp/transfer-helper/internal/lifecycle"
	"github.com/yucp/transfer-helper/internal/trust"
)

const verificationWaitLimit = 5 * time.Minute

type CredentialProvider interface {
	Access(
		ctx context.Context,
		identity ClientIdentity,
		forceRefresh bool,
		report ProgressReporter,
	) (OAuthTokens, deviceidentity.Identity, error)
}

type RemoteExchange interface {
	AuthorizeAndExchange(
		ctx context.Context,
		request OperationRequest,
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
	VerificationPollInterval time.Duration
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
		return existing, nil
	}
	result, operationErr := runtime.handleNew(
		ctx,
		clientIdentity,
		request,
		report,
	)
	if operationErr != nil {
		result = failedOperationResult(request, operationErr)
	}
	if result.Files == nil {
		result.Files = []OperationResultFile{}
	}
	if err := runtime.Results.Save(clientIdentity.UserSID, request, result); err != nil {
		return OperationResult{}, err
	}
	return result, nil
}

func (runtime Runtime) handleNew(
	ctx context.Context,
	clientIdentity ClientIdentity,
	request OperationRequest,
	report ProgressReporter,
) (OperationResult, error) {
	if err := report("preparing", 0, 0); err != nil {
		return OperationResult{}, err
	}
	tokens, device, err := runtime.Credentials.Access(
		ctx,
		clientIdentity,
		false,
		report,
	)
	if err != nil {
		return OperationResult{}, err
	}
	authorized, err := runtime.Exchange.AuthorizeAndExchange(
		ctx,
		request,
		tokens,
		device.PrivateKey,
	)
	if errors.Is(err, ErrAuthenticationRequired) {
		tokens, device, err = runtime.Credentials.Access(
			ctx,
			clientIdentity,
			true,
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

func failedOperationResult(
	request OperationRequest,
	operationErr error,
) OperationResult {
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

func failedOperationResultWithCode(
	request OperationRequest,
	code string,
	message string,
) OperationResult {
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
		TraceID:           request.Traceparent[3:35],
	}
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
	if err := report("verifying-access", 0, 0); err != nil {
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
				tokens, device, err = runtime.Credentials.Access(
					waitContext,
					clientIdentity,
					true,
					report,
				)
				if err != nil {
					return AuthorizedOperation{}, tokens, device, err
				}
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
