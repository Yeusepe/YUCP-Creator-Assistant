//go:build windows

package main

import (
	"context"
	"flag"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"time"

	"github.com/yucp/transfer-helper/internal/broker"
	"golang.org/x/sys/windows/svc"
)

const windowsServiceName = "YUCPPackageBroker"

type serviceConfig struct {
	apiBaseURL  string
	authBaseURL string
	pipeName    string
	stateRoot   string
	trust       broker.TrustConfig
}

type serviceHandler struct {
	config serviceConfig
}

func main() {
	config, err := parseConfig(os.Args[1:])
	if err != nil {
		_, _ = fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	isService, err := svc.IsWindowsService()
	if err != nil {
		_, _ = fmt.Fprintln(os.Stderr, "detect Windows service context:", err)
		os.Exit(1)
	}
	if isService {
		if err := svc.Run(windowsServiceName, serviceHandler{config: config}); err != nil {
			_, _ = fmt.Fprintln(os.Stderr, "run package broker service:", err)
			os.Exit(1)
		}
		return
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	if err := runBroker(ctx, config); err != nil {
		_, _ = fmt.Fprintln(os.Stderr, "run package broker:", err)
		os.Exit(1)
	}
}

func (handler serviceHandler) Execute(
	_ []string,
	requests <-chan svc.ChangeRequest,
	status chan<- svc.Status,
) (bool, uint32) {
	status <- svc.Status{State: svc.StartPending}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	result := make(chan error, 1)
	go func() {
		result <- runBroker(ctx, handler.config)
	}()
	status <- svc.Status{
		Accepts: svc.AcceptStop | svc.AcceptShutdown,
		State:   svc.Running,
	}
	for {
		select {
		case err := <-result:
			status <- svc.Status{State: svc.Stopped}
			if err != nil {
				return false, 1
			}
			return false, 0
		case request := <-requests:
			switch request.Cmd {
			case svc.Interrogate:
				status <- request.CurrentStatus
			case svc.Stop, svc.Shutdown:
				status <- svc.Status{State: svc.StopPending}
				cancel()
				err := <-result
				status <- svc.Status{State: svc.Stopped}
				if err != nil {
					return false, 1
				}
				return false, 0
			}
		}
	}
}

func parseConfig(args []string) (serviceConfig, error) {
	flags := flag.NewFlagSet("yucp-package-broker", flag.ContinueOnError)
	apiBaseURL := flags.String("api-base-url", "", "YUCP package API base URL")
	authBaseURL := flags.String("auth-base-url", "", "YUCP authorization base URL")
	pipeName := flags.String("pipe", broker.DefaultPipeName, "local broker named pipe")
	stateRoot := flags.String("state-root", "", "broker state root")
	tufRoot := flags.String("tuf-root", "", "pinned TUF root path")
	tufMetadataURL := flags.String("tuf-metadata-url", "", "TUF metadata base URL")
	tufTargetsURL := flags.String("tuf-targets-url", "", "TUF targets base URL")
	tufTrustTarget := flags.String("tuf-trust-target", "", "signed trust target name")
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 {
		return serviceConfig{}, fmt.Errorf("package broker arguments are invalid")
	}
	config := serviceConfig{
		apiBaseURL:  *apiBaseURL,
		authBaseURL: *authBaseURL,
		pipeName:    *pipeName,
		stateRoot:   *stateRoot,
		trust: broker.TrustConfig{
			MetadataURL: *tufMetadataURL,
			RootPath:    *tufRoot,
			StateRoot:   *stateRoot,
			TargetsURL:  *tufTargetsURL,
			TrustTarget: *tufTrustTarget,
		},
	}
	if config.apiBaseURL == "" ||
		config.authBaseURL == "" ||
		config.stateRoot == "" ||
		config.trust.RootPath == "" ||
		config.trust.MetadataURL == "" ||
		config.trust.TargetsURL == "" ||
		config.trust.TrustTarget == "" {
		return serviceConfig{}, fmt.Errorf("package broker configuration is incomplete")
	}
	return config, nil
}

func runBroker(ctx context.Context, config serviceConfig) error {
	trustDocument, err := broker.LoadTrustDocument(config.trust)
	if err != nil {
		return err
	}
	tokenStore, err := broker.NewTokenStore(config.stateRoot)
	if err != nil {
		return err
	}
	resultStore, err := broker.NewResultStore(config.stateRoot)
	if err != nil {
		return err
	}
	httpClient := &http.Client{Timeout: 60 * time.Second}
	credentials := &broker.ManagedCredentials{
		OAuthForClient: func(identity broker.ClientIdentity) broker.OAuthFlow {
			return broker.OAuthClient{
				AuthBaseURL: config.authBaseURL,
				HTTPClient:  httpClient,
				OpenURL: func(raw string) error {
					return broker.LaunchURLForClient(identity, raw)
				},
			}
		},
		StateRoot: config.stateRoot,
		Store:     tokenStore,
	}
	runtime := broker.Runtime{
		Credentials:   credentials,
		Exchange:      broker.RemoteClient{APIBaseURL: config.apiBaseURL, HTTPClient: httpClient},
		Executor:      broker.DefaultLifecycleExecutor{},
		LaunchURL:     broker.LaunchURLForClient,
		Results:       resultStore,
		StateRoot:     config.stateRoot,
		TrustDocument: trustDocument,
	}
	server, err := broker.Listen(config.pipeName, runtime)
	if err != nil {
		return err
	}
	defer server.Close()
	return server.Serve(ctx)
}
