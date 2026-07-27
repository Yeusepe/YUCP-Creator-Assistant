//go:build windows

package guestagent

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"strconv"
	"testing"
	"time"
)

type firewallObserverHarness struct {
	applyCalls   int
	captureCalls int
	cleanupCalls int
	invalidState bool
}

func (harness *firewallObserverHarness) run(
	_ context.Context,
	_ []string,
	input []byte,
	script string,
) ([]byte, error) {
	switch script {
	case captureFirewallPolicyScript:
		harness.captureCalls++
		return json.Marshal([]firewallProfile{
			{Name: "Domain", Outbound: "Allow"},
			{Name: "Private", Outbound: "Allow"},
			{Name: "Public", Outbound: "Allow"},
		})
	case applyFirewallPolicyScript:
		harness.applyCalls++
		request := firewallPolicyRequest{}
		if err := json.Unmarshal(input, &request); err != nil {
			return nil, err
		}
		state := appliedFirewallState{
			Original: append([]firewallProfile(nil), request.Original...),
			Profiles: []firewallProfile{
				{Name: "Domain", Outbound: "Block"},
				{Name: "Private", Outbound: "Block"},
				{Name: "Public", Outbound: "Block"},
			},
		}
		for _, rule := range request.Rules {
			state.Rules = append(state.Rules, observedFirewallRule{
				Action:    "Allow",
				Address:   rule.Address,
				Direction: "Outbound",
				Enabled:   "True",
				Name:      rule.Name,
				Port:      strconv.Itoa(rule.Port),
				Protocol:  "TCP",
			})
		}
		if harness.invalidState {
			state.Profiles[0].Outbound = "Allow"
		}
		return json.Marshal(state)
	case cleanupFirewallPolicyScript:
		harness.cleanupCalls++
		return []byte(`{"restored":true}`), nil
	default:
		return nil, errors.New("unexpected PowerShell script")
	}
}

func successfulFirewallDial(
	_ context.Context,
	_ string,
	_ string,
) (net.Conn, error) {
	client, server := net.Pipe()
	_ = server.Close()
	return client, nil
}

func TestWindowsFirewallObserverProvesAllowAndDenyOutsideTheDriver(t *testing.T) {
	observer, err := NewWindowsFirewallObserver(struct {
		BlockedProbeAddress string
		PowerShellCommand   string
		ProbeTimeout        time.Duration
	}{
		BlockedProbeAddress: "198.51.100.1:443",
		PowerShellCommand:   `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`,
		ProbeTimeout:        time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	harness := &firewallObserverHarness{}
	observer.runPowerShell = harness.run
	observer.dial = func(ctx context.Context, network string, address string) (net.Conn, error) {
		if address == "198.51.100.1:443" {
			return nil, errors.New("blocked by policy")
		}
		return successfulFirewallDial(ctx, network, address)
	}

	session, err := observer.Begin(context.Background(), NetworkEnforcementRequest{
		Allowlist: []string{
			"http://192.0.2.10:3000",
			"http://192.0.2.10:3002",
		},
		Environment: []string{`SYSTEMROOT=C:\Windows`},
		RunID:       "run-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	observation, err := session.Observation()
	if err != nil {
		t.Fatal(err)
	}
	if !observation.PositiveProbePassed ||
		!observation.NegativeProbeBlocked ||
		observation.BlockedProbe != "198.51.100.1:443" ||
		len(observation.ProbedAllowlist) != 2 {
		t.Fatalf("unexpected firewall observation: %+v", observation)
	}
	if err := session.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	if harness.captureCalls != 1 || harness.applyCalls != 1 || harness.cleanupCalls != 1 {
		t.Fatalf("unexpected firewall command counts: %+v", harness)
	}
}

func TestWindowsFirewallObserverCleansUpWhenAppliedStateIsInvalid(t *testing.T) {
	observer, err := NewWindowsFirewallObserver(struct {
		BlockedProbeAddress string
		PowerShellCommand   string
		ProbeTimeout        time.Duration
	}{
		BlockedProbeAddress: "198.51.100.1:443",
		PowerShellCommand:   `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`,
		ProbeTimeout:        time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	harness := &firewallObserverHarness{invalidState: true}
	observer.runPowerShell = harness.run
	observer.dial = successfulFirewallDial

	if _, err := observer.Begin(context.Background(), NetworkEnforcementRequest{
		Allowlist: []string{"http://192.0.2.10:3000"},
		RunID:     "run-1",
	}); err == nil {
		t.Fatal("invalid applied firewall state was accepted")
	}
	if harness.cleanupCalls != 1 {
		t.Fatalf("firewall cleanup calls = %d", harness.cleanupCalls)
	}
}

func TestWindowsFirewallObserverRejectsAReachableBlockedProbeAndCleansUp(t *testing.T) {
	observer, err := NewWindowsFirewallObserver(struct {
		BlockedProbeAddress string
		PowerShellCommand   string
		ProbeTimeout        time.Duration
	}{
		BlockedProbeAddress: "198.51.100.1:443",
		PowerShellCommand:   `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`,
		ProbeTimeout:        time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	harness := &firewallObserverHarness{}
	observer.runPowerShell = harness.run
	observer.dial = successfulFirewallDial

	if _, err := observer.Begin(context.Background(), NetworkEnforcementRequest{
		Allowlist: []string{"http://192.0.2.10:3000"},
		RunID:     "run-1",
	}); err == nil {
		t.Fatal("reachable blocked probe was accepted")
	}
	if harness.cleanupCalls != 1 {
		t.Fatalf("firewall cleanup calls = %d", harness.cleanupCalls)
	}
}
