//go:build windows

package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/user"
	"regexp"
	"time"

	"github.com/yucp/transfer-helper/internal/broker"
	"github.com/yucp/transfer-helper/internal/deviceidentity"
)

type dumpTransport struct{}

// sensitiveFieldPattern redacts credential-bearing JSON fields from the printed
// trace so tokens never land in terminals, tickets, or CI logs.
var sensitiveFieldPattern = regexp.MustCompile(
	`"(access_token|refresh_token|id_token|installSession|deliveryGrant|operationCapability)"\s*:\s*"(?:[^"\\]|\\.)*"`,
)

func redactSensitiveFields(body []byte) []byte {
	return sensitiveFieldPattern.ReplaceAll(body, []byte(`"$1":"[redacted]"`))
}

func (dumpTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	fmt.Fprintf(os.Stderr, ">> %s %s\n", request.Method, request.URL)
	response, err := http.DefaultTransport.RoundTrip(request)
	if err != nil {
		fmt.Fprintf(os.Stderr, "!! transport error: %v\n", err)
		return response, err
	}
	// Read the FULL body so the real caller sees an untruncated response; only
	// the printed preview is redacted and bounded.
	body, _ := io.ReadAll(response.Body)
	response.Body.Close()
	preview := redactSensitiveFields(body)
	if len(preview) > 4096 {
		preview = preview[:4096]
	}
	fmt.Fprintf(os.Stderr, "<< HTTP %d\n%s\n", response.StatusCode, string(preview))
	response.Body = io.NopCloser(bytes.NewReader(body))
	return response, nil
}

func main() {
	stateRoot := `C:\Users\svalp\AppData\Local\YUCP\PackageDelivery\state\broker`
	current, err := user.Current()
	if err != nil {
		panic(err)
	}
	store, err := broker.NewTokenStore(stateRoot)
	if err != nil {
		panic(err)
	}
	tokens, found, err := store.Load(current.Uid)
	if err != nil || !found {
		fmt.Fprintf(os.Stderr, "token load: found=%v err=%v\n", found, err)
		os.Exit(1)
	}
	identity, err := deviceidentity.LoadOrCreate(stateRoot)
	if err != nil {
		panic(err)
	}
	span := make([]byte, 8)
	trace := make([]byte, 16)
	_, _ = rand.Read(span)
	_, _ = rand.Read(trace)
	runID := "raw-diagnostic-" + hex.EncodeToString(span)
	request := broker.OperationRequest{
		AliasID:                    "com.lunar.druffle",
		ExpectedCurrentReleaseRoot: "0000000000000000000000000000000000000000000000000000000000000000",
		IdempotencyKey:             runID,
		Operation:                  "preflight",
		ProjectIdentity:            "deca070897d28139d38e70be2c079eca746b66a7dc7b5c9b3c6ad06eef264ff5",
		ProjectPath:                `E:\Unity\ImportTesting`,
		RunID:                      runID,
		SchemaVersion:              broker.OperationRequestSchemaVersion,
		Traceparent:                "00-" + hex.EncodeToString(trace) + "-" + hex.EncodeToString(span) + "-01",
	}
	httpClient := &http.Client{Timeout: 60 * time.Second, Transport: dumpTransport{}}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	oauth := broker.OAuthClient{
		AuthBaseURL: "https://verify.creators.yucp.club/api/auth",
		HTTPClient:  httpClient,
	}
	refreshed, err := oauth.Refresh(ctx, identity.PrivateKey, tokens.RefreshToken)
	if err != nil {
		fmt.Fprintf(os.Stderr, "refresh error: %v\n", err)
		os.Exit(1)
	}
	if err := store.Save(current.Uid, refreshed); err != nil {
		fmt.Fprintf(os.Stderr, "token save error: %v\n", err)
	}
	client := broker.RemoteClient{
		APIBaseURL: "https://api.creators.yucp.club",
		HTTPClient: httpClient,
	}
	authorized, err := client.AuthorizeAndExchange(ctx, request, refreshed, identity.PrivateKey)
	if err != nil {
		fmt.Fprintf(os.Stderr, "authorize error: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("authorized OK: session=%d bytes grant=%d bytes\n",
		len(authorized.InstallSession), len(authorized.DeliveryGrant))
}
