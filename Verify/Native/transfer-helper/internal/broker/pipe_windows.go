//go:build windows

package broker

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/Microsoft/go-winio"
	"golang.org/x/sys/windows"
)

const (
	brokerPipeSecurityDescriptor = "D:P(A;;GA;;;SY)(A;;GA;;;IU)"
	maxConcurrentOperations      = 2
)

var (
	advapi32                         = windows.NewLazySystemDLL("advapi32.dll")
	procImpersonateNamedPipeClient   = advapi32.NewProc("ImpersonateNamedPipeClient")
	procRevertToSelf                 = advapi32.NewProc("RevertToSelf")
	errBrokerPipeListenerUnavailable = errors.New("package broker pipe listener is unavailable")
)

type Server struct {
	handler  Handler
	listener net.Listener
	slots    chan struct{}
}

// Listen applies Windows named-pipe security before it accepts clients.
// See https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights.
func Listen(pipeName string, handler Handler) (*Server, error) {
	if !strings.HasPrefix(pipeName, `\\.\pipe\`) ||
		len(pipeName) <= len(`\\.\pipe\`) ||
		handler == nil {
		return nil, fmt.Errorf("package broker listener configuration is invalid")
	}
	listener, err := winio.ListenPipe(pipeName, &winio.PipeConfig{
		InputBufferSize:    maxBrokerFrameBytes,
		MessageMode:        false,
		OutputBufferSize:   maxBrokerFrameBytes,
		SecurityDescriptor: brokerPipeSecurityDescriptor,
	})
	if err != nil {
		return nil, fmt.Errorf("listen on package broker pipe: %w", err)
	}
	return &Server{
		handler:  handler,
		listener: listener,
		slots:    make(chan struct{}, maxConcurrentOperations),
	}, nil
}

func (server *Server) Close() error {
	if server == nil || server.listener == nil {
		return nil
	}
	return server.listener.Close()
}

func (server *Server) Serve(ctx context.Context) error {
	if server == nil || server.listener == nil {
		return errBrokerPipeListenerUnavailable
	}
	go func() {
		<-ctx.Done()
		_ = server.Close()
	}()
	for {
		connection, err := server.listener.Accept()
		if err != nil {
			if ctx.Err() != nil || errors.Is(err, net.ErrClosed) {
				return nil
			}
			return fmt.Errorf("accept package broker client: %w", err)
		}
		go server.handleConnection(ctx, connection)
	}
}

func (server *Server) handleConnection(ctx context.Context, connection net.Conn) {
	defer connection.Close()
	_ = connection.SetDeadline(time.Now().Add(connectionAuthorizationLifetime))
	reader := bufio.NewReaderSize(connection, maxBrokerFrameBytes)
	var begin beginFrame
	if err := readFrame(reader, &begin); err != nil ||
		begin.SchemaVersion != BrokerProtocolSchemaVersion ||
		begin.Kind != "begin" ||
		!isCanonicalNonce(begin.ClientNonce) {
		return
	}
	identity, err := authenticateNamedPipeClient(connection)
	if err != nil {
		return
	}
	authorization, err := newConnectionAuthorization(
		identity.UserSID,
		identity.ProcessID,
		time.Now(),
	)
	if err != nil {
		return
	}
	if err := writeFrame(connection, challengeFrame{
		ClientNonce:    begin.ClientNonce,
		ExpiresAt:      authorization.ExpiresAt.UTC().Format(time.RFC3339Nano),
		Kind:           "challenge",
		OperationToken: authorization.Token,
		SchemaVersion:  BrokerProtocolSchemaVersion,
	}); err != nil {
		return
	}
	var operation operateFrame
	if err := readFrame(reader, &operation); err != nil ||
		operation.SchemaVersion != BrokerProtocolSchemaVersion ||
		operation.Kind != "operate" ||
		authorization.Consume(
			operation.OperationToken,
			identity.UserSID,
			identity.ProcessID,
			time.Now(),
		) != nil ||
		validateOperationRequest(operation.Request) != nil {
		return
	}
	_ = connection.SetDeadline(time.Time{})
	select {
	case server.slots <- struct{}{}:
		defer func() { <-server.slots }()
	default:
		_ = writeFrame(connection, resultFrame{
			Kind: "result",
			Result: failedOperationResultWithCode(
				operation.Request,
				"BROKER_BUSY",
				"Package operations are busy. Try again shortly.",
			),
			SchemaVersion: BrokerProtocolSchemaVersion,
		})
		return
	}
	operationContext, cancelOperation := context.WithCancel(ctx)
	defer cancelOperation()
	go func() {
		var unexpected [1]byte
		_, _ = reader.Read(unexpected[:])
		cancelOperation()
	}()
	var writeMu sync.Mutex
	var sequence int64
	report := func(phase string, completedBytes int64, totalBytes int64) error {
		writeMu.Lock()
		defer writeMu.Unlock()
		sequence++
		event := Progress{
			CompletedBytes: completedBytes,
			Phase:          phase,
			RunID:          operation.Request.RunID,
			SchemaVersion:  BrokerProtocolSchemaVersion,
			Sequence:       sequence,
			TotalBytes:     totalBytes,
		}
		if err := validateProgress(event); err != nil {
			return err
		}
		return writeFrame(connection, progressFrame{
			Kind:          "progress",
			Progress:      event,
			SchemaVersion: BrokerProtocolSchemaVersion,
		})
	}
	result, handleErr := server.handler.Handle(
		operationContext,
		identity,
		operation.Request,
		report,
	)
	if handleErr != nil {
		result = failedOperationResult(operation.Request, handleErr)
	}
	if result.Files == nil {
		result.Files = []OperationResultFile{}
	}
	if validateOperationResult(result, operation.Request) != nil {
		result = failedOperationResultWithCode(
			operation.Request,
			"PACKAGE_LIFECYCLE_FAILED",
			"Package delivery failed. Try again. If the problem continues, contact support.",
		)
	}
	writeMu.Lock()
	defer writeMu.Unlock()
	_ = writeFrame(connection, resultFrame{
		Kind:          "result",
		Result:        result,
		SchemaVersion: BrokerProtocolSchemaVersion,
	})
}

// authenticateNamedPipeClient impersonates the client to read its SID.
// See https://learn.microsoft.com/en-us/windows/win32/api/namedpipeapi/nf-namedpipeapi-impersonatenamedpipeclient.
func authenticateNamedPipeClient(connection net.Conn) (ClientIdentity, error) {
	handleOwner, ok := connection.(interface{ Fd() uintptr })
	if !ok {
		return ClientIdentity{}, fmt.Errorf("named-pipe handle is unavailable")
	}
	handle := windows.Handle(handleOwner.Fd())
	var processID uint32
	if err := windows.GetNamedPipeClientProcessId(handle, &processID); err != nil ||
		processID == 0 {
		return ClientIdentity{}, fmt.Errorf("identify named-pipe client process")
	}

	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	succeeded, _, callErr := procImpersonateNamedPipeClient.Call(uintptr(handle))
	if succeeded == 0 {
		return ClientIdentity{}, fmt.Errorf("impersonate named-pipe client: %w", callErr)
	}
	defer procRevertToSelf.Call()
	var token windows.Token
	if err := windows.OpenThreadToken(
		windows.CurrentThread(),
		windows.TOKEN_QUERY,
		true,
		&token,
	); err != nil {
		return ClientIdentity{}, fmt.Errorf("open named-pipe client token: %w", err)
	}
	defer token.Close()
	user, err := token.GetTokenUser()
	if err != nil || user == nil || user.User.Sid == nil {
		return ClientIdentity{}, fmt.Errorf("read named-pipe client identity")
	}
	return ClientIdentity{
		ProcessID: processID,
		UserSID:   user.User.Sid.String(),
	}, nil
}

func isCanonicalNonce(value string) bool {
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	return err == nil &&
		len(decoded) == 32 &&
		base64.RawURLEncoding.EncodeToString(decoded) == value
}

func Invoke(
	ctx context.Context,
	pipeName string,
	request OperationRequest,
	onProgress func(Progress),
) (OperationResult, error) {
	if err := validateOperationRequest(request); err != nil {
		return OperationResult{}, err
	}
	connection, err := winio.DialPipeAccessImpLevel(
		ctx,
		pipeName,
		uint32(windows.GENERIC_READ|windows.GENERIC_WRITE),
		winio.PipeImpLevelImpersonation,
	)
	if err != nil {
		return OperationResult{}, fmt.Errorf("connect to package broker: %w", err)
	}
	defer connection.Close()
	reader := bufio.NewReaderSize(connection, maxBrokerFrameBytes)
	clientNonceBytes := make([]byte, 32)
	if _, err := rand.Read(clientNonceBytes); err != nil {
		return OperationResult{}, fmt.Errorf("create package broker nonce: %w", err)
	}
	clientNonce := base64.RawURLEncoding.EncodeToString(clientNonceBytes)
	if err := writeFrame(connection, beginFrame{
		ClientNonce:   clientNonce,
		Kind:          "begin",
		SchemaVersion: BrokerProtocolSchemaVersion,
	}); err != nil {
		return OperationResult{}, err
	}
	var challenge challengeFrame
	if err := readFrame(reader, &challenge); err != nil {
		return OperationResult{}, err
	}
	expiresAt, err := time.Parse(time.RFC3339Nano, challenge.ExpiresAt)
	if err != nil ||
		challenge.SchemaVersion != BrokerProtocolSchemaVersion ||
		challenge.Kind != "challenge" ||
		challenge.ClientNonce != clientNonce ||
		!isCanonicalNonce(challenge.OperationToken) ||
		!time.Now().Before(expiresAt) {
		return OperationResult{}, fmt.Errorf("package broker challenge is invalid")
	}
	if err := writeFrame(connection, operateFrame{
		Kind:           "operate",
		OperationToken: challenge.OperationToken,
		Request:        request,
		SchemaVersion:  BrokerProtocolSchemaVersion,
	}); err != nil {
		return OperationResult{}, err
	}
	for {
		var header frameHeader
		line, err := reader.ReadBytes('\n')
		if err != nil {
			return OperationResult{}, fmt.Errorf("read package broker response: %w", err)
		}
		if len(line) > maxBrokerFrameBytes {
			return OperationResult{}, fmt.Errorf("package broker response is too large")
		}
		if err := json.Unmarshal(line, &header); err != nil ||
			header.SchemaVersion != BrokerProtocolSchemaVersion {
			return OperationResult{}, fmt.Errorf("package broker response header is invalid")
		}
		switch header.Kind {
		case "progress":
			var frame progressFrame
			if err := jsonUnmarshalStrict(line, &frame); err != nil ||
				validateProgress(frame.Progress) != nil ||
				frame.Progress.RunID != request.RunID {
				return OperationResult{}, fmt.Errorf("package broker progress is invalid")
			}
			if onProgress != nil {
				onProgress(frame.Progress)
			}
		case "result":
			var frame resultFrame
			if err := jsonUnmarshalStrict(line, &frame); err != nil ||
				frame.Result.RunID != request.RunID {
				return OperationResult{}, fmt.Errorf("package broker result is invalid")
			}
			return frame.Result, nil
		default:
			return OperationResult{}, fmt.Errorf("package broker response kind is invalid")
		}
	}
}

func jsonUnmarshalStrict(raw []byte, destination any) error {
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	return requireJSONEnd(decoder)
}
