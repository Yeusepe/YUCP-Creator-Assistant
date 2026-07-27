//go:build windows

package guestagent

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"net/url"
	"os/exec"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	defaultFirewallProbeTimeout = 5 * time.Second
)

// Windows Firewall PowerShell references:
// https://learn.microsoft.com/en-us/powershell/module/netsecurity/set-netfirewallprofile
// https://learn.microsoft.com/en-us/powershell/module/netsecurity/new-netfirewallrule
// https://learn.microsoft.com/en-us/powershell/module/netsecurity/get-netfirewallrule
const captureFirewallPolicyScript = `
$ErrorActionPreference = 'Stop'
[Console]::In.ReadToEnd() | Out-Null
[Console]::Out.Write((@(Get-NetFirewallProfile -PolicyStore ActiveStore | Sort-Object Name | ForEach-Object {
  [pscustomobject]@{
    name = [string]$_.Name
    outbound = [string]$_.DefaultOutboundAction
  }
}) | ConvertTo-Json -Compress))
`

const applyFirewallPolicyScript = `
$ErrorActionPreference = 'Stop'
$policy = [Console]::In.ReadToEnd() | ConvertFrom-Json
$original = @($policy.original)
try {
  Set-NetFirewallProfile -Profile Domain,Private,Public -Enabled True -DefaultOutboundAction Block -ErrorAction Stop
  foreach ($requested in @($policy.rules)) {
    New-NetFirewallRule -PolicyStore PersistentStore -Name $requested.name -DisplayName $requested.name -Group 'YUCP Lifecycle' -Enabled True -Direction Outbound -Action Allow -Protocol TCP -RemoteAddress $requested.address -RemotePort $requested.port -ErrorAction Stop | Out-Null
  }
  $profiles = @(Get-NetFirewallProfile -PolicyStore ActiveStore | Sort-Object Name | ForEach-Object {
    [pscustomobject]@{
      name = [string]$_.Name
      outbound = [string]$_.DefaultOutboundAction
    }
  })
  $rules = @($policy.rules | ForEach-Object {
    $requested = $_
    $rule = Get-NetFirewallRule -PolicyStore ActiveStore -Name $requested.name -ErrorAction Stop
    $address = $rule | Get-NetFirewallAddressFilter -ErrorAction Stop
    $port = $rule | Get-NetFirewallPortFilter -ErrorAction Stop
    [pscustomobject]@{
      action = [string]$rule.Action
      address = [string]$address.RemoteAddress
      direction = [string]$rule.Direction
      enabled = [string]$rule.Enabled
      name = [string]$rule.Name
      port = [string]$port.RemotePort
      protocol = [string]$port.Protocol
    }
  })
  [Console]::Out.Write(([pscustomobject]@{
    original = $original
    profiles = $profiles
    rules = $rules
  } | ConvertTo-Json -Compress -Depth 6))
} catch {
  foreach ($requested in @($policy.rules)) {
    Remove-NetFirewallRule -PolicyStore PersistentStore -Name $requested.name -ErrorAction SilentlyContinue
  }
  foreach ($profile in $original) {
    Set-NetFirewallProfile -Profile $profile.name -DefaultOutboundAction $profile.outbound -ErrorAction SilentlyContinue
  }
  throw
}
`

const cleanupFirewallPolicyScript = `
$ErrorActionPreference = 'Stop'
$policy = [Console]::In.ReadToEnd() | ConvertFrom-Json
foreach ($rule in @($policy.rules)) {
  Remove-NetFirewallRule -PolicyStore PersistentStore -Name $rule.name -ErrorAction Stop
}
foreach ($profile in @($policy.original)) {
  Set-NetFirewallProfile -Profile $profile.name -DefaultOutboundAction $profile.outbound -ErrorAction Stop
}
$remaining = @($policy.rules | Where-Object {
  $null -ne (Get-NetFirewallRule -PolicyStore ActiveStore -Name $_.name -ErrorAction SilentlyContinue)
})
$observed = @(Get-NetFirewallProfile -PolicyStore ActiveStore | Sort-Object Name | ForEach-Object {
  [pscustomobject]@{
    name = [string]$_.Name
    outbound = [string]$_.DefaultOutboundAction
  }
})
if ($remaining.Count -ne 0 -or (($observed | ConvertTo-Json -Compress) -ne (($policy.original | Sort-Object name) | ConvertTo-Json -Compress))) {
  throw 'The lifecycle firewall policy did not restore.'
}
[Console]::Out.Write('{"restored":true}')
`

type firewallRule struct {
	Address string `json:"address"`
	Name    string `json:"name"`
	Port    int    `json:"port"`
}

type firewallProfile struct {
	Name     string `json:"name"`
	Outbound string `json:"outbound"`
}

type observedFirewallRule struct {
	Action    string `json:"action"`
	Address   string `json:"address"`
	Direction string `json:"direction"`
	Enabled   string `json:"enabled"`
	Name      string `json:"name"`
	Port      string `json:"port"`
	Protocol  string `json:"protocol"`
}

type appliedFirewallState struct {
	Original []firewallProfile      `json:"original"`
	Profiles []firewallProfile      `json:"profiles"`
	Rules    []observedFirewallRule `json:"rules"`
}

type firewallPolicyRequest struct {
	Original []firewallProfile `json:"original,omitempty"`
	Rules    []firewallRule    `json:"rules"`
}

type runFirewallPowerShell func(
	context.Context,
	[]string,
	[]byte,
	string,
) ([]byte, error)

type dialFirewallEndpoint func(context.Context, string, string) (net.Conn, error)

type WindowsFirewallObserver struct {
	blockedProbeAddress string
	dial                dialFirewallEndpoint
	powerShellCommand   string
	probeTimeout        time.Duration
	runPowerShell       runFirewallPowerShell
}

type windowsFirewallSession struct {
	environment []string
	mu          sync.Mutex
	observation NetworkEnforcementObservation
	observer    *WindowsFirewallObserver
	original    []firewallProfile
	rules       []firewallRule
	closed      bool
}

func NewWindowsFirewallObserver(input struct {
	BlockedProbeAddress string
	PowerShellCommand   string
	ProbeTimeout        time.Duration
}) (*WindowsFirewallObserver, error) {
	if input.PowerShellCommand == "" || !strings.Contains(input.PowerShellCommand, `:\`) {
		return nil, fmt.Errorf("firewall PowerShell command must be absolute")
	}
	if _, _, err := requireIPPort(input.BlockedProbeAddress); err != nil {
		return nil, fmt.Errorf("blocked firewall probe is invalid")
	}
	probeTimeout := input.ProbeTimeout
	if probeTimeout == 0 {
		probeTimeout = defaultFirewallProbeTimeout
	}
	if probeTimeout < 100*time.Millisecond || probeTimeout > 30*time.Second {
		return nil, fmt.Errorf("firewall probe timeout is invalid")
	}
	observer := &WindowsFirewallObserver{
		blockedProbeAddress: input.BlockedProbeAddress,
		powerShellCommand:   input.PowerShellCommand,
		probeTimeout:        probeTimeout,
	}
	observer.dial = (&net.Dialer{Timeout: probeTimeout}).DialContext
	observer.runPowerShell = observer.invokePowerShell
	return observer, nil
}

func requireIPPort(address string) (string, int, error) {
	host, portText, err := net.SplitHostPort(address)
	if err != nil || net.ParseIP(host) == nil {
		return "", 0, fmt.Errorf("endpoint must contain an IP literal and port")
	}
	port, err := strconv.Atoi(portText)
	if err != nil || port < 1 || port > 65_535 {
		return "", 0, fmt.Errorf("endpoint port is invalid")
	}
	return host, port, nil
}

func endpointForOrigin(origin string) (string, int, error) {
	parsed, err := url.Parse(origin)
	if err != nil || parsed.Hostname() == "" || net.ParseIP(parsed.Hostname()) == nil {
		return "", 0, fmt.Errorf("allowlisted origin must use an IP literal")
	}
	portText := parsed.Port()
	if portText == "" {
		if parsed.Scheme == "http" {
			portText = "80"
		} else if parsed.Scheme == "https" {
			portText = "443"
		} else {
			return "", 0, fmt.Errorf("allowlisted origin protocol is invalid")
		}
	}
	port, err := strconv.Atoi(portText)
	if err != nil || port < 1 || port > 65_535 {
		return "", 0, fmt.Errorf("allowlisted origin port is invalid")
	}
	return parsed.Hostname(), port, nil
}

func firewallRules(runID string, allowlist []string) ([]firewallRule, []string, error) {
	if !safeIDPattern.MatchString(runID) || len(allowlist) == 0 {
		return nil, nil, fmt.Errorf("firewall request is invalid")
	}
	runDigest := sha256.Sum256([]byte(runID))
	prefix := "YUCP-Lifecycle-" + hex.EncodeToString(runDigest[:8])
	rules := make([]firewallRule, 0, len(allowlist))
	probes := make([]string, 0, len(allowlist))
	seen := map[string]struct{}{}
	for _, origin := range allowlist {
		address, port, err := endpointForOrigin(origin)
		if err != nil {
			return nil, nil, err
		}
		endpoint := net.JoinHostPort(address, strconv.Itoa(port))
		probes = append(probes, endpoint)
		if _, exists := seen[endpoint]; exists {
			continue
		}
		seen[endpoint] = struct{}{}
		rules = append(rules, firewallRule{
			Address: address,
			Name:    fmt.Sprintf("%s-%02d", prefix, len(rules)+1),
			Port:    port,
		})
	}
	return rules, probes, nil
}

func validateAppliedFirewallState(
	state appliedFirewallState,
	requested []firewallRule,
) error {
	if len(state.Original) != 3 || len(state.Profiles) != 3 || len(state.Rules) != len(requested) {
		return fmt.Errorf("observed firewall state is incomplete")
	}
	for _, profile := range state.Profiles {
		if profile.Outbound != "Block" {
			return fmt.Errorf("observed firewall profile is not outbound-blocking")
		}
	}
	requestedByName := make(map[string]firewallRule, len(requested))
	for _, rule := range requested {
		requestedByName[rule.Name] = rule
	}
	for _, observed := range state.Rules {
		requestedRule, ok := requestedByName[observed.Name]
		if !ok ||
			observed.Action != "Allow" ||
			observed.Direction != "Outbound" ||
			observed.Enabled != "True" ||
			observed.Protocol != "TCP" ||
			observed.Address != requestedRule.Address ||
			observed.Port != strconv.Itoa(requestedRule.Port) {
			return fmt.Errorf("observed firewall rule does not match the request")
		}
	}
	return nil
}

func validateOriginalFirewallProfiles(profiles []firewallProfile) error {
	if len(profiles) != 3 {
		return fmt.Errorf("original firewall profiles are incomplete")
	}
	names := map[string]struct{}{}
	for _, profile := range profiles {
		if profile.Name == "" ||
			(profile.Outbound != "Allow" &&
				profile.Outbound != "Block" &&
				profile.Outbound != "NotConfigured") {
			return fmt.Errorf("original firewall profile is invalid")
		}
		names[profile.Name] = struct{}{}
	}
	if len(names) != 3 {
		return fmt.Errorf("original firewall profiles are not unique")
	}
	return nil
}

func (observer *WindowsFirewallObserver) invokePowerShell(
	ctx context.Context,
	environment []string,
	input []byte,
	script string,
) ([]byte, error) {
	command := exec.CommandContext(
		ctx,
		observer.powerShellCommand,
		"-NoLogo",
		"-NoProfile",
		"-NonInteractive",
		"-ExecutionPolicy",
		"RemoteSigned",
		"-Command",
		"-",
	)
	command.Env = append([]string(nil), environment...)
	command.Stdin = strings.NewReader(string(input))
	stdout := &boundedSensitiveBuffer{}
	stderr := &boundedSensitiveBuffer{}
	defer stdout.clear()
	defer stderr.clear()
	command.Stdout = stdout
	command.Stderr = stderr
	if err := command.Run(); err != nil {
		return nil, fmt.Errorf("firewall PowerShell command failed")
	}
	if stdout.overflow || stderr.overflow || len(stderr.data) != 0 {
		return nil, fmt.Errorf("firewall PowerShell output is invalid")
	}
	return append([]byte(nil), stdout.data...), nil
}

func (observer *WindowsFirewallObserver) Begin(
	ctx context.Context,
	request NetworkEnforcementRequest,
) (NetworkEnforcementSession, error) {
	rules, probes, err := firewallRules(request.RunID, request.Allowlist)
	if err != nil {
		return nil, err
	}
	blockedHost, blockedPort, err := requireIPPort(observer.blockedProbeAddress)
	if err != nil {
		return nil, err
	}
	blockedEndpoint := net.JoinHostPort(blockedHost, strconv.Itoa(blockedPort))
	for _, probe := range probes {
		if probe == blockedEndpoint {
			return nil, fmt.Errorf("blocked firewall probe is allowlisted")
		}
	}
	originalBytes, err := observer.runPowerShell(
		ctx,
		request.Environment,
		[]byte{},
		captureFirewallPolicyScript,
	)
	if err != nil {
		return nil, err
	}
	original := []firewallProfile{}
	if err := json.Unmarshal(originalBytes, &original); err != nil {
		return nil, fmt.Errorf("original firewall state is invalid")
	}
	if err := validateOriginalFirewallProfiles(original); err != nil {
		return nil, err
	}
	session := &windowsFirewallSession{
		environment: append([]string(nil), request.Environment...),
		observer:    observer,
		original:    append([]firewallProfile(nil), original...),
		rules:       append([]firewallRule(nil), rules...),
	}
	cleanupOnFailure := true
	defer func() {
		if cleanupOnFailure {
			_ = session.Close(context.WithoutCancel(ctx))
		}
	}()
	policyBytes, err := json.Marshal(firewallPolicyRequest{
		Original: original,
		Rules:    rules,
	})
	if err != nil {
		return nil, err
	}
	output, err := observer.runPowerShell(
		ctx,
		request.Environment,
		policyBytes,
		applyFirewallPolicyScript,
	)
	if err != nil {
		return nil, err
	}
	state := appliedFirewallState{}
	if err := json.Unmarshal(output, &state); err != nil {
		return nil, fmt.Errorf("observed firewall state is invalid")
	}
	if err := validateAppliedFirewallState(state, rules); err != nil {
		return nil, err
	}
	for _, probe := range probes {
		probeContext, cancel := context.WithTimeout(ctx, observer.probeTimeout)
		connection, dialErr := observer.dial(probeContext, "tcp", probe)
		cancel()
		if dialErr != nil {
			return nil, fmt.Errorf("allowlisted firewall probe failed")
		}
		_ = connection.Close()
	}
	blockedContext, cancelBlocked := context.WithTimeout(ctx, observer.probeTimeout)
	blockedConnection, blockedErr := observer.dial(blockedContext, "tcp", blockedEndpoint)
	cancelBlocked()
	if blockedConnection != nil {
		_ = blockedConnection.Close()
	}
	if blockedErr == nil {
		return nil, fmt.Errorf("non-allowlisted firewall probe was not blocked")
	}
	normalizedState, err := json.Marshal(state)
	if err != nil {
		return nil, err
	}
	policyDigest := sha256.Sum256(normalizedState)
	session.observation = NetworkEnforcementObservation{
		AppliedPolicySHA256:  hex.EncodeToString(policyDigest[:]),
		BlockedProbe:         blockedEndpoint,
		NegativeProbeBlocked: true,
		PositiveProbePassed:  true,
		ProbedAllowlist:      append([]string(nil), request.Allowlist...),
	}
	cleanupOnFailure = false
	return session, nil
}

func (session *windowsFirewallSession) Observation() (NetworkEnforcementObservation, error) {
	session.mu.Lock()
	defer session.mu.Unlock()
	if session.closed {
		return NetworkEnforcementObservation{}, fmt.Errorf("firewall observation is closed")
	}
	return session.observation, nil
}

func (session *windowsFirewallSession) Close(ctx context.Context) error {
	session.mu.Lock()
	defer session.mu.Unlock()
	if session.closed {
		return nil
	}
	session.closed = true
	rules := append([]firewallRule(nil), session.rules...)
	sort.Slice(rules, func(left, right int) bool {
		return rules[left].Name < rules[right].Name
	})
	input, err := json.Marshal(firewallPolicyRequest{
		Original: append([]firewallProfile(nil), session.original...),
		Rules:    rules,
	})
	if err != nil {
		return err
	}
	output, err := session.observer.runPowerShell(
		ctx,
		session.environment,
		input,
		cleanupFirewallPolicyScript,
	)
	if err != nil {
		return err
	}
	var result struct {
		Restored bool `json:"restored"`
	}
	if err := json.Unmarshal(output, &result); err != nil || !result.Restored {
		return fmt.Errorf("firewall cleanup result is invalid")
	}
	return nil
}
