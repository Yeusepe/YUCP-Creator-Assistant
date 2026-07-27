import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import * as ed25519 from '@noble/ed25519';
import { killProcessTree } from '../dev-supervisor';
import {
  decodeCanonicalPackageCbor,
  encodeCanonicalPackageCbor,
  PACKAGE_COSE_ALGORITHM_EDDSA,
  PACKAGE_COSE_PURPOSE_HEADER,
  type PackageContractCborValue,
} from '../storage-core/packageContractsV2';

const GUEST_EVIDENCE_PURPOSE = 'package-lifecycle-guest-evidence-v1';
const HEX_256_PATTERN = /^[0-9a-f]{64}$/;
const HEX_128_PATTERN = /^[0-9a-f]{32}$/;
const WINDOWS_ABSOLUTE_PATH_PATTERN = /^[a-zA-Z]:\\/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HYPERV_CHILD_ENVIRONMENT_ALLOWLIST = new Set([
  'COMSPEC',
  'NUMBER_OF_PROCESSORS',
  'OS',
  'PATH',
  'PATHEXT',
  'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_IDENTIFIER',
  'SYSTEMDRIVE',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'WINDIR',
]);

const requiredConfigurationVariables = [
  'PACKAGE_LIFECYCLE_HYPERV_CHECKPOINT',
  'PACKAGE_LIFECYCLE_HYPERV_CHECKPOINT_ID',
  'PACKAGE_LIFECYCLE_HYPERV_GUEST_AGENT_COMMAND',
  'PACKAGE_LIFECYCLE_HYPERV_GUEST_EVIDENCE_KEY_ID',
  'PACKAGE_LIFECYCLE_HYPERV_GUEST_EVIDENCE_PUBLIC_KEY',
  'PACKAGE_LIFECYCLE_HYPERV_GUEST_PASSWORD',
  'PACKAGE_LIFECYCLE_HYPERV_GUEST_USER',
  'PACKAGE_LIFECYCLE_HYPERV_OWNERSHIP_MARKER',
  'PACKAGE_LIFECYCLE_HYPERV_SWITCH_NAME',
  'PACKAGE_LIFECYCLE_HYPERV_VM_ID',
  'PACKAGE_LIFECYCLE_HYPERV_VM_NAME',
] as const;

type HyperVConfigurationVariable = (typeof requiredConfigurationVariables)[number];

export interface HyperVLifecycleBlocker {
  capability: HyperVConfigurationVariable;
  code:
    | 'PACKAGE_LIFECYCLE_HYPERV_CONFIGURATION_INVALID'
    | 'PACKAGE_LIFECYCLE_HYPERV_PREREQUISITE_MISSING';
}

export interface HyperVLifecycleConfiguration {
  checkpointId: string;
  checkpointName: string;
  guestAgentCommand: string;
  guestEvidenceKeyId: string;
  guestEvidencePublicKey: Uint8Array;
  guestPassword: string;
  guestUser: string;
  ownershipMarker: string;
  switchName: string;
  vmId: string;
  vmName: string;
}

export type HyperVLifecycleConfigurationInspection =
  | {
      blockers: [];
      configuration: HyperVLifecycleConfiguration;
      ready: true;
    }
  | {
      blockers: HyperVLifecycleBlocker[];
      ready: false;
    };

export interface LifecycleGuestEvidencePayload {
  finishedAt: string;
  guestExecutionId: string;
  networkPolicySha256: string;
  processContainment: {
    allChildrenExited: boolean;
    killOnJobClose: boolean;
    kind: 'windows-job-object';
  };
  requestSha256: string;
  runId: string;
  schemaVersion: 1;
  startedAt: string;
  status: 'failed' | 'passed';
  traceId: string;
}

export interface LifecycleGuestRequest {
  cbor: Uint8Array;
  checkpointId: string;
  kind: 'package-lifecycle' | 'probe';
  networkAllowlist: string[];
  networkPolicySha256: string;
  runId: string;
  sha256: string;
  traceId: string;
}

export interface PackageLifecycleGuestParameters {
  apiOrigin: string;
  buyerEnrollmentCapability: string;
  catalogProductId: string;
  creatorEnrollmentCapability: string;
  licenseKey: string;
  packageId: string;
  packageV1Path: string;
  packageV2Path?: string;
  productName: string;
  traceparent: string;
  webOrigin: string;
}

export interface HyperVPowerShellResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

export interface HyperVGuestFile {
  destinationPath: string;
  sourcePath: string;
}

export type ExecuteHyperVPowerShell = (input: {
  input: string;
  script: string;
  timeoutMs: number;
}) => Promise<HyperVPowerShellResult>;

export function buildMinimalHyperVChildEnvironment(
  source: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && HYPERV_CHILD_ENVIRONMENT_ALLOWLIST.has(name.toUpperCase())) {
      environment[name] = value;
    }
  }
  return environment;
}

export function createHyperVPowerShellExecutor(input: {
  operationRoot: string;
}): ExecuteHyperVPowerShell {
  if (!isAbsolute(input.operationRoot)) {
    throw new Error('The Hyper-V operation root must be absolute');
  }
  let commandIndex = 0;
  return async (command): Promise<HyperVPowerShellResult> => {
    commandIndex += 1;
    await mkdir(input.operationRoot, { recursive: true });
    const scriptPath = join(
      input.operationRoot,
      `hyperv-${String(commandIndex).padStart(3, '0')}.ps1`
    );
    await writeFile(scriptPath, command.script, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    try {
      return await new Promise<HyperVPowerShellResult>((resolveCommand, rejectCommand) => {
        const child = spawn(
          'powershell.exe',
          [
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'RemoteSigned',
            '-File',
            scriptPath,
          ],
          {
            env: buildMinimalHyperVChildEnvironment(),
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
          }
        );
        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let settled = false;
        let timedOut = false;
        const capture = (
          chunks: Buffer[],
          capturedBytes: number,
          chunk: Buffer | string
        ): number => {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          const remaining = 8 * 1024 * 1024 - capturedBytes;
          if (remaining <= 0) {
            return capturedBytes;
          }
          const captured = bytes.subarray(0, remaining);
          chunks.push(captured);
          return capturedBytes + captured.byteLength;
        };
        child.stdout.on('data', (chunk: Buffer | string) => {
          stdoutBytes = capture(stdoutChunks, stdoutBytes, chunk);
        });
        child.stderr.on('data', (chunk: Buffer | string) => {
          stderrBytes = capture(stderrChunks, stderrBytes, chunk);
        });
        const timeout = setTimeout(() => {
          timedOut = true;
          if (child.pid) {
            void killProcessTree(child.pid, 'SIGTERM').catch((error) => {
              if (!settled) {
                settled = true;
                rejectCommand(
                  new Error('The Hyper-V PowerShell process tree did not terminate', {
                    cause: error,
                  })
                );
              }
            });
          }
        }, command.timeoutMs);
        child.on('error', (error) => {
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            rejectCommand(
              new Error('The Hyper-V PowerShell process did not start', {
                cause: error,
              })
            );
          }
        });
        child.on('close', (exitCode) => {
          clearTimeout(timeout);
          if (settled) {
            return;
          }
          settled = true;
          resolveCommand({
            exitCode: timedOut ? 124 : (exitCode ?? 1),
            stderr: Buffer.concat(stderrChunks, stderrBytes).toString('utf8'),
            stdout: Buffer.concat(stdoutChunks, stdoutBytes).toString('utf8'),
          });
        });
        child.stdin.end(command.input);
      });
    } finally {
      await rm(scriptPath, { force: true });
    }
  };
}

function containsInvalidText(value: string, maximumBytes: number): boolean {
  return (
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > maximumBytes ||
    [...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f;
    })
  );
}

function decodeCanonicalBase64Url(value: string, bytes: number): Uint8Array | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    return undefined;
  }
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.byteLength !== bytes || decoded.toString('base64url') !== value) {
    return undefined;
  }
  return decoded;
}

function configurationValue(
  environment: NodeJS.ProcessEnv,
  name: HyperVConfigurationVariable
): string | undefined {
  const value = environment[name]?.trim();
  return value ? value : undefined;
}

export function inspectHyperVLifecycleConfiguration(
  environment: NodeJS.ProcessEnv
): HyperVLifecycleConfigurationInspection {
  const blockers: HyperVLifecycleBlocker[] = [];
  const values = new Map<HyperVConfigurationVariable, string>();
  for (const name of requiredConfigurationVariables) {
    const value = configurationValue(environment, name);
    if (!value) {
      blockers.push({
        capability: name,
        code: 'PACKAGE_LIFECYCLE_HYPERV_PREREQUISITE_MISSING',
      });
      continue;
    }
    values.set(name, value);
  }
  if (blockers.length > 0) {
    return { blockers, ready: false };
  }

  const checkpointName = values.get('PACKAGE_LIFECYCLE_HYPERV_CHECKPOINT') as string;
  const checkpointId = values.get('PACKAGE_LIFECYCLE_HYPERV_CHECKPOINT_ID') as string;
  const guestAgentCommand = values.get('PACKAGE_LIFECYCLE_HYPERV_GUEST_AGENT_COMMAND') as string;
  const guestEvidenceKeyId = values.get('PACKAGE_LIFECYCLE_HYPERV_GUEST_EVIDENCE_KEY_ID') as string;
  const encodedPublicKey = values.get(
    'PACKAGE_LIFECYCLE_HYPERV_GUEST_EVIDENCE_PUBLIC_KEY'
  ) as string;
  const guestPassword = values.get('PACKAGE_LIFECYCLE_HYPERV_GUEST_PASSWORD') as string;
  const guestUser = values.get('PACKAGE_LIFECYCLE_HYPERV_GUEST_USER') as string;
  const ownershipMarker = values.get('PACKAGE_LIFECYCLE_HYPERV_OWNERSHIP_MARKER') as string;
  const switchName = values.get('PACKAGE_LIFECYCLE_HYPERV_SWITCH_NAME') as string;
  const vmId = values.get('PACKAGE_LIFECYCLE_HYPERV_VM_ID') as string;
  const vmName = values.get('PACKAGE_LIFECYCLE_HYPERV_VM_NAME') as string;
  const guestEvidencePublicKey = decodeCanonicalBase64Url(encodedPublicKey, 32);

  const invalid = (
    [
      ['PACKAGE_LIFECYCLE_HYPERV_CHECKPOINT', containsInvalidText(checkpointName, 256)],
      [
        'PACKAGE_LIFECYCLE_HYPERV_CHECKPOINT_ID',
        containsInvalidText(checkpointId, 36) || !UUID_PATTERN.test(checkpointId),
      ],
      [
        'PACKAGE_LIFECYCLE_HYPERV_GUEST_AGENT_COMMAND',
        containsInvalidText(guestAgentCommand, 1024) ||
          !WINDOWS_ABSOLUTE_PATH_PATTERN.test(guestAgentCommand),
      ],
      [
        'PACKAGE_LIFECYCLE_HYPERV_GUEST_EVIDENCE_KEY_ID',
        containsInvalidText(guestEvidenceKeyId, 64),
      ],
      ['PACKAGE_LIFECYCLE_HYPERV_GUEST_EVIDENCE_PUBLIC_KEY', !guestEvidencePublicKey],
      ['PACKAGE_LIFECYCLE_HYPERV_GUEST_PASSWORD', containsInvalidText(guestPassword, 4096)],
      ['PACKAGE_LIFECYCLE_HYPERV_GUEST_USER', containsInvalidText(guestUser, 256)],
      ['PACKAGE_LIFECYCLE_HYPERV_OWNERSHIP_MARKER', containsInvalidText(ownershipMarker, 256)],
      ['PACKAGE_LIFECYCLE_HYPERV_SWITCH_NAME', containsInvalidText(switchName, 256)],
      ['PACKAGE_LIFECYCLE_HYPERV_VM_ID', containsInvalidText(vmId, 36) || !UUID_PATTERN.test(vmId)],
      ['PACKAGE_LIFECYCLE_HYPERV_VM_NAME', containsInvalidText(vmName, 256)],
    ] as const
  )
    .filter(([, rejected]) => rejected)
    .map<HyperVLifecycleBlocker>(([capability]) => ({
      capability,
      code: 'PACKAGE_LIFECYCLE_HYPERV_CONFIGURATION_INVALID',
    }));
  if (invalid.length > 0 || !guestEvidencePublicKey) {
    return { blockers: invalid, ready: false };
  }

  return {
    blockers: [],
    configuration: {
      checkpointId: checkpointId.toLowerCase(),
      checkpointName,
      guestAgentCommand,
      guestEvidenceKeyId,
      guestEvidencePublicKey,
      guestPassword,
      guestUser,
      ownershipMarker,
      switchName,
      vmId: vmId.toLowerCase(),
      vmName,
    },
    ready: true,
  };
}

function quotePowerShellLiteral(value: string): string {
  if (containsInvalidText(value, 1024)) {
    throw new Error('The Hyper-V value contains invalid text');
  }
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * Hyper-V PowerShell reference:
 * https://learn.microsoft.com/en-us/powershell/module/hyper-v/get-vm
 * https://learn.microsoft.com/en-us/powershell/module/hyper-v/get-vmsnapshot
 * https://learn.microsoft.com/en-us/powershell/module/hyper-v/get-vmintegrationservice
 */
export function buildHyperVProbeScript(configuration: HyperVLifecycleConfiguration): string {
  const vmName = quotePowerShellLiteral(configuration.vmName);
  const vmId = quotePowerShellLiteral(configuration.vmId);
  const checkpointName = quotePowerShellLiteral(configuration.checkpointName);
  const checkpointId = quotePowerShellLiteral(configuration.checkpointId);
  const ownershipMarker = quotePowerShellLiteral(configuration.ownershipMarker);
  const switchName = quotePowerShellLiteral(configuration.switchName);
  return [
    "$ErrorActionPreference = 'Stop'",
    `Import-Module Hyper-V -ErrorAction Stop`,
    `$vm = Get-VM -Id ([Guid]${vmId}) -ErrorAction Stop`,
    `if ($vm.Name -ne ${vmName} -or [string]$vm.Notes -ne ${ownershipMarker} -or $vm.Generation -ne 2 -or $vm.State -ne 'Off') { throw 'The dedicated Hyper-V VM identity or state is invalid.' }`,
    `$checkpoint = @(Get-VMSnapshot -VM $vm -ErrorAction Stop | Where-Object { $_.Id -eq ([Guid]${checkpointId}) })`,
    `if ($checkpoint.Count -ne 1 -or $checkpoint[0].Name -ne ${checkpointName}) { throw 'The Hyper-V checkpoint identity is invalid.' }`,
    `$checkpoint = $checkpoint[0]`,
    `$services = @(Get-VMIntegrationService -VM $vm -ErrorAction Stop)`,
    `if ($services.Count -eq 0) { throw 'The Hyper-V guest exposes no integration services.' }`,
    `$adapters = @(Get-VMNetworkAdapter -VM $vm -ErrorAction Stop)`,
    `if ($adapters.Count -ne 1 -or $adapters[0].SwitchName -ne ${switchName}) { throw 'The Hyper-V network boundary is invalid.' }`,
    `[Console]::Out.Write((@{ checkpointId = [string]$checkpoint.Id; generation = [int]$vm.Generation; switchName = [string]$adapters[0].SwitchName; vmId = [string]$vm.Id } | ConvertTo-Json -Compress))`,
  ].join('\n');
}

function normalizeNetworkAllowlist(origins: readonly string[]): string[] {
  const normalized = origins.map((origin) => {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error('The guest network allowlist contains an invalid origin');
    }
    if (
      !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash
    ) {
      throw new Error('The guest network allowlist contains an invalid origin');
    }
    return parsed.origin;
  });
  const unique = [...new Set(normalized)].sort((left, right) => left.localeCompare(right));
  if (unique.length !== origins.length || unique.length > 32) {
    throw new Error('The guest network allowlist must contain unique bounded origins');
  }
  return unique;
}

export function buildLifecycleGuestRequest(input: {
  checkpointId: string;
  expiresAt: string;
  issuedAt: string;
  kind: LifecycleGuestRequest['kind'];
  lifecycle?: PackageLifecycleGuestParameters;
  networkAllowlist: readonly string[];
  runId: string;
  traceId: string;
}): LifecycleGuestRequest {
  if (
    containsInvalidText(input.checkpointId, 256) ||
    containsInvalidText(input.runId, 256) ||
    !HEX_128_PATTERN.test(input.traceId)
  ) {
    throw new Error('The lifecycle guest request identity is invalid');
  }
  const issuedAt = Date.parse(input.issuedAt);
  const expiresAt = Date.parse(input.expiresAt);
  if (
    !Number.isFinite(issuedAt) ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > 15 * 60_000
  ) {
    throw new Error('The lifecycle guest request lifetime is invalid');
  }
  const networkAllowlist = normalizeNetworkAllowlist(input.networkAllowlist);
  const networkPolicyBytes = encodeCanonicalPackageCbor(networkAllowlist);
  const networkPolicySha256 = createHash('sha256').update(networkPolicyBytes).digest('hex');
  if (
    (input.kind === 'package-lifecycle' && !input.lifecycle) ||
    (input.kind === 'probe' && input.lifecycle)
  ) {
    throw new Error('The lifecycle guest request payload does not match its kind');
  }
  const lifecycle = input.lifecycle
    ? new Map<number, PackageContractCborValue>([
        [1, input.lifecycle.apiOrigin],
        [2, input.lifecycle.webOrigin],
        [3, input.lifecycle.creatorEnrollmentCapability],
        [4, input.lifecycle.buyerEnrollmentCapability],
        [5, input.lifecycle.catalogProductId],
        [6, input.lifecycle.packageId],
        [7, input.lifecycle.licenseKey],
        [8, input.lifecycle.productName],
        [9, input.lifecycle.packageV1Path],
        [10, input.lifecycle.packageV2Path ?? ''],
        [11, input.lifecycle.traceparent],
      ])
    : null;
  const cbor = encodeCanonicalPackageCbor(
    new Map<number, PackageContractCborValue>([
      [1, 1],
      [2, input.kind],
      [3, input.runId],
      [4, input.traceId],
      [5, input.checkpointId],
      [6, input.issuedAt],
      [7, input.expiresAt],
      [8, networkAllowlist],
      [9, networkPolicySha256],
      [10, lifecycle],
    ])
  );
  return {
    cbor,
    checkpointId: input.checkpointId,
    kind: input.kind,
    networkAllowlist,
    networkPolicySha256,
    runId: input.runId,
    sha256: createHash('sha256').update(cbor).digest('hex'),
    traceId: input.traceId,
  };
}

/**
 * Hyper-V PowerShell reference:
 * https://learn.microsoft.com/en-us/powershell/module/hyper-v/restore-vmsnapshot
 * https://learn.microsoft.com/en-us/powershell/module/hyper-v/start-vm
 * https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/manage/powershell-direct
 */
export function buildHyperVGuestSessionScript(
  configuration: HyperVLifecycleConfiguration,
  guestFiles: readonly HyperVGuestFile[] = []
): string {
  const vmName = quotePowerShellLiteral(configuration.vmName);
  const vmId = quotePowerShellLiteral(configuration.vmId);
  const checkpointName = quotePowerShellLiteral(configuration.checkpointName);
  const checkpointId = quotePowerShellLiteral(configuration.checkpointId);
  const ownershipMarker = quotePowerShellLiteral(configuration.ownershipMarker);
  const switchName = quotePowerShellLiteral(configuration.switchName);
  const agentCommand = quotePowerShellLiteral(configuration.guestAgentCommand);
  const copyCommands = guestFiles.map((file) => {
    if (
      containsInvalidText(file.sourcePath, 1024) ||
      containsInvalidText(file.destinationPath, 1024) ||
      !WINDOWS_ABSOLUTE_PATH_PATTERN.test(file.sourcePath) ||
      !WINDOWS_ABSOLUTE_PATH_PATTERN.test(file.destinationPath)
    ) {
      throw new Error('The Hyper-V guest file mapping is invalid');
    }
    return `  Copy-VMFile -VMName ${vmName} -SourcePath ${quotePowerShellLiteral(
      file.sourcePath
    )} -DestinationPath ${quotePowerShellLiteral(
      file.destinationPath
    )} -FileSource Host -CreateFullPath -Force -ErrorAction Stop`;
  });
  return [
    "$ErrorActionPreference = 'Stop'",
    `Import-Module Hyper-V -ErrorAction Stop`,
    `$userName = [Console]::In.ReadLine()`,
    `$plainPassword = [Console]::In.ReadLine()`,
    `$requestBase64 = [Console]::In.ReadLine()`,
    `if ([string]::IsNullOrWhiteSpace($userName) -or $null -eq $plainPassword -or [string]::IsNullOrWhiteSpace($requestBase64)) { throw 'The Hyper-V guest input is incomplete.' }`,
    `$securePassword = ConvertTo-SecureString $plainPassword -AsPlainText -Force`,
    `$plainPassword = $null`,
    `$credential = [System.Management.Automation.PSCredential]::new($userName, $securePassword)`,
    `$ownedStartSucceeded = $false`,
    `$restoreApplied = $false`,
    `$directSession = $null`,
    `try {`,
    `  $vm = Get-VM -Id ([Guid]${vmId}) -ErrorAction Stop`,
    `  if ($vm.Name -ne ${vmName} -or [string]$vm.Notes -ne ${ownershipMarker} -or $vm.Generation -ne 2 -or $vm.State -ne 'Off') { throw 'The dedicated Hyper-V VM identity or state changed before ownership.' }`,
    `  $checkpoint = @(Get-VMSnapshot -VM $vm -ErrorAction Stop | Where-Object { $_.Id -eq ([Guid]${checkpointId}) })`,
    `  if ($checkpoint.Count -ne 1 -or $checkpoint[0].Name -ne ${checkpointName}) { throw 'The Hyper-V checkpoint identity changed before ownership.' }`,
    `  $checkpoint = $checkpoint[0]`,
    `  $adapters = @(Get-VMNetworkAdapter -VM $vm -ErrorAction Stop)`,
    `  if ($adapters.Count -ne 1 -or $adapters[0].SwitchName -ne ${switchName}) { throw 'The Hyper-V network boundary changed before ownership.' }`,
    `  Restore-VMSnapshot -VMSnapshot $checkpoint -Confirm:$false -ErrorAction Stop`,
    `  $restoreApplied = $true`,
    `  Start-VM -VM $vm -ErrorAction Stop | Out-Null`,
    `  $ownedStartSucceeded = $true`,
    `  $heartbeatDeadline = [DateTime]::UtcNow.AddMinutes(3)`,
    `  do {`,
    `    $vm = Get-VM -Id ([Guid]${vmId}) -ErrorAction Stop`,
    `    if ($vm.State -eq 'Running' -and $vm.Status -eq 'Operating normally') { break }`,
    `    Start-Sleep -Milliseconds 250`,
    `  } while ([DateTime]::UtcNow -lt $heartbeatDeadline)`,
    `  if ($vm.State -ne 'Running' -or $vm.Status -ne 'Operating normally') { throw 'The Hyper-V guest heartbeat did not become ready.' }`,
    ...copyCommands,
    `  $directDeadline = [DateTime]::UtcNow.AddMinutes(3)`,
    `  do {`,
    `    try {`,
    `      $directSession = New-PSSession -VMId ([Guid]${vmId}) -Credential $credential -ErrorAction Stop`,
    `      break`,
    `    } catch {`,
    `      Start-Sleep -Milliseconds 250`,
    `    }`,
    `  } while ([DateTime]::UtcNow -lt $directDeadline)`,
    `  if ($null -eq $directSession) { throw 'The Hyper-V PowerShell Direct endpoint did not become ready.' }`,
    `  $guestOutput = @(Invoke-Command -Session $directSession -ErrorAction Stop -ScriptBlock {`,
    `    param([string]$AgentCommand, [string]$RequestBase64)`,
    `    $ErrorActionPreference = 'Stop'`,
    `    $requestRoot = Join-Path $env:ProgramData 'YUCP\\LifecycleAgent\\Requests'`,
    `    [System.IO.Directory]::CreateDirectory($requestRoot) | Out-Null`,
    `    $requestDirectory = Join-Path $requestRoot ([Guid]::NewGuid().ToString('N'))`,
    `    $requestPath = Join-Path $requestDirectory 'request.cbor'`,
    `    try {`,
    `      $requestSecurity = [System.Security.AccessControl.DirectorySecurity]::new()`,
    `      $requestSecurity.SetAccessRuleProtection($true, $false)`,
    `      $currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User`,
    `      $systemSid = [System.Security.Principal.SecurityIdentifier]::new([System.Security.Principal.WellKnownSidType]::LocalSystemSid, $null)`,
    `      $inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit`,
    `      $propagation = [System.Security.AccessControl.PropagationFlags]::None`,
    `      $allow = [System.Security.AccessControl.AccessControlType]::Allow`,
    `      $rights = [System.Security.AccessControl.FileSystemRights]::FullControl`,
    `      foreach ($sid in @($currentSid, $systemSid)) {`,
    `        $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, $rights, $inheritance, $propagation, $allow)`,
    `        $requestSecurity.AddAccessRule($rule)`,
    `      }`,
    `      [System.IO.Directory]::CreateDirectory($requestDirectory, $requestSecurity) | Out-Null`,
    `      $observedSecurity = Get-Acl -LiteralPath $requestDirectory -ErrorAction Stop`,
    `      $observedRules = @($observedSecurity.Access)`,
    `      $expectedSids = @($currentSid.Value, $systemSid.Value)`,
    `      if (-not $observedSecurity.AreAccessRulesProtected -or $observedRules.Count -ne 2) { throw 'The lifecycle request directory ACL is invalid.' }`,
    `      foreach ($rule in $observedRules) {`,
    `        $observedSid = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value`,
    `        if ($rule.IsInherited -or $rule.AccessControlType -ne $allow -or $expectedSids -notcontains $observedSid -or (($rule.FileSystemRights -band $rights) -ne $rights)) { throw 'The lifecycle request directory ACL is invalid.' }`,
    `      }`,
    `      $requestBytes = [Convert]::FromBase64String($RequestBase64)`,
    `      $RequestBase64 = $null`,
    `      $requestStream = [System.IO.FileStream]::new($requestPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None, 4096, [System.IO.FileOptions]::WriteThrough)`,
    `      try {`,
    `        $requestStream.Write($requestBytes, 0, $requestBytes.Length)`,
    `        $requestStream.Flush($true)`,
    `      } finally {`,
    `        $requestStream.Dispose()`,
    `      }`,
    `      $requestBytes = $null`,
    `      $agentOutput = @(& $AgentCommand 'run' '--request-path' $requestPath)`,
    `      if ($LASTEXITCODE -ne 0) { throw 'The lifecycle guest agent failed.' }`,
    `      if ($agentOutput.Count -ne 1 -or $agentOutput[0] -notmatch '^EVIDENCE:[A-Za-z0-9_-]+$') { throw 'The lifecycle guest agent returned an invalid terminal envelope.' }`,
    `      [string]$agentOutput[0]`,
    `    } finally {`,
    `      $RequestBase64 = $null`,
    `      $requestBytes = $null`,
    `      if (Test-Path -LiteralPath $requestPath) {`,
    `        $clearStream = [System.IO.FileStream]::new($requestPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)`,
    `        try {`,
    `          $remaining = $clearStream.Length`,
    `          $zeroes = [byte[]]::new(65536)`,
    `          while ($remaining -gt 0) {`,
    `            $count = [int][Math]::Min($zeroes.Length, $remaining)`,
    `            $clearStream.Write($zeroes, 0, $count)`,
    `            $remaining -= $count`,
    `          }`,
    `          $clearStream.Flush($true)`,
    `          $clearStream.SetLength(0)`,
    `          $clearStream.Flush($true)`,
    `        } finally {`,
    `          $clearStream.Dispose()`,
    `        }`,
    `        Remove-Item -LiteralPath $requestPath -Force -ErrorAction Stop`,
    `      }`,
    `      if (Test-Path -LiteralPath $requestDirectory) { Remove-Item -LiteralPath $requestDirectory -Force -ErrorAction Stop }`,
    `    }`,
    `  } -ArgumentList ${agentCommand}, $requestBase64)`,
    `  if ($guestOutput.Count -ne 1 -or $guestOutput[0] -notmatch '^EVIDENCE:[A-Za-z0-9_-]+$') { throw 'The Hyper-V guest returned an invalid terminal envelope.' }`,
    `  [Console]::Out.WriteLine([string]$guestOutput[0])`,
    `} finally {`,
    `  $cleanupFailed = $false`,
    `  if ($null -ne $directSession) {`,
    `    try { Remove-PSSession -Session $directSession -ErrorAction Stop } catch { $cleanupFailed = $true }`,
    `  }`,
    `  $cleanupVm = $null`,
    `  try { $cleanupVm = Get-VM -Id ([Guid]${vmId}) -ErrorAction Stop } catch { $cleanupFailed = $true }`,
    `  $cleanupOwned = $null -ne $cleanupVm -and $cleanupVm.Name -eq ${vmName} -and [string]$cleanupVm.Notes -eq ${ownershipMarker}`,
    `  if (-not $cleanupOwned) {`,
    `    $cleanupFailed = $true`,
    `  } elseif ($ownedStartSucceeded) {`,
    `    if ($cleanupVm.State -ne 'Off') {`,
    `      try { Stop-VM -VM $cleanupVm -TurnOff -Confirm:$false -ErrorAction Stop } catch { $cleanupFailed = $true }`,
    `    }`,
    `  } elseif ($cleanupVm.State -ne 'Off') {`,
    `    $cleanupFailed = $true`,
    `  }`,
    `  if ($cleanupOwned -and $restoreApplied) {`,
    `    $cleanupCheckpoint = @()`,
    `    try { $cleanupCheckpoint = @(Get-VMSnapshot -VM $cleanupVm -ErrorAction Stop | Where-Object { $_.Id -eq ([Guid]${checkpointId}) }) } catch { $cleanupFailed = $true }`,
    `    if ($cleanupCheckpoint.Count -ne 1 -or $cleanupCheckpoint[0].Name -ne ${checkpointName}) {`,
    `      $cleanupFailed = $true`,
    `    } else {`,
    `      try { Restore-VMSnapshot -VMSnapshot $cleanupCheckpoint[0] -Confirm:$false -ErrorAction Stop } catch { $cleanupFailed = $true }`,
    `    }`,
    `  }`,
    `  if ($cleanupFailed) { throw 'The dedicated Hyper-V cleanup did not complete.' }`,
    `}`,
  ].join('\n');
}

function parseHyperVInventory(
  result: HyperVPowerShellResult,
  configuration: HyperVLifecycleConfiguration
): { checkpointId: string; vmId: string } {
  if (result.exitCode !== 0) {
    throw new Error('The Hyper-V prerequisite probe failed');
  }
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    throw new Error('The Hyper-V prerequisite probe returned invalid JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('The Hyper-V prerequisite probe returned an invalid result');
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.checkpointId !== 'string' ||
    record.checkpointId.toLowerCase() !== configuration.checkpointId ||
    record.generation !== 2 ||
    record.switchName !== configuration.switchName ||
    typeof record.vmId !== 'string' ||
    record.vmId.toLowerCase() !== configuration.vmId
  ) {
    throw new Error('The Hyper-V prerequisite probe did not prove the required boundary');
  }
  return {
    checkpointId: record.checkpointId,
    vmId: record.vmId,
  };
}

export async function probeHyperVLifecyclePrerequisites(input: {
  configuration: HyperVLifecycleConfiguration;
  executePowerShell: ExecuteHyperVPowerShell;
}): Promise<{ checkpointId: string; vmId: string }> {
  return parseHyperVInventory(
    await input.executePowerShell({
      input: '',
      script: buildHyperVProbeScript(input.configuration),
      timeoutMs: 30_000,
    }),
    input.configuration
  );
}

export async function runHyperVLifecycleGuestRequest(input: {
  configuration: HyperVLifecycleConfiguration;
  executePowerShell: ExecuteHyperVPowerShell;
  guestFiles?: readonly HyperVGuestFile[];
  request: LifecycleGuestRequest;
}): Promise<LifecycleGuestEvidencePayload> {
  const inventory = await probeHyperVLifecyclePrerequisites(input);
  if (inventory.checkpointId !== input.request.checkpointId) {
    throw new Error('The lifecycle request is not bound to the selected Hyper-V checkpoint');
  }
  const sessionResult = await input.executePowerShell({
    input: `${input.configuration.guestUser}\n${input.configuration.guestPassword}\n${Buffer.from(
      input.request.cbor
    ).toString('base64')}\n`,
    script: buildHyperVGuestSessionScript(input.configuration, input.guestFiles),
    timeoutMs: 45 * 60_000,
  });
  if (sessionResult.exitCode !== 0) {
    throw new Error('The Hyper-V guest session failed');
  }
  const lines = sessionResult.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length !== 1 || !lines[0]?.startsWith('EVIDENCE:')) {
    throw new Error('The Hyper-V guest session returned an invalid terminal envelope');
  }
  const encodedEvidence = lines[0].slice('EVIDENCE:'.length);
  const evidence = Buffer.from(encodedEvidence, 'base64url');
  if (
    evidence.byteLength === 0 ||
    evidence.toString('base64url') !== encodedEvidence ||
    encodedEvidence.length > 8 * 1024 * 1024
  ) {
    throw new Error('The Hyper-V guest evidence encoding is invalid');
  }
  const verified = await decodeAndVerifyLifecycleGuestEvidence({
    coseSign1: evidence,
    expectedKeyId: input.configuration.guestEvidenceKeyId,
    expectedNetworkPolicySha256: input.request.networkPolicySha256,
    expectedRequestSha256: input.request.sha256,
    expectedRunId: input.request.runId,
    expectedTraceId: input.request.traceId,
    publicKey: input.configuration.guestEvidencePublicKey,
  });
  if (verified.status !== 'passed') {
    throw new Error('The Hyper-V guest lifecycle did not pass');
  }
  return verified;
}

function requireMap(value: PackageContractCborValue | undefined, name: string) {
  if (!(value instanceof Map)) {
    throw new Error(`${name} must be a CBOR map`);
  }
  return value;
}

function requireArray(value: PackageContractCborValue | undefined, name: string) {
  if (!Array.isArray(value)) {
    throw new Error(`${name} must be a CBOR array`);
  }
  return value;
}

function requireBytes(
  value: PackageContractCborValue | undefined,
  name: string,
  length?: number
): Uint8Array {
  if (!(value instanceof Uint8Array) || (length !== undefined && value.byteLength !== length)) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function requireString(value: PackageContractCborValue | undefined, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function requireBoolean(value: PackageContractCborValue | undefined, name: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`${name} must be a boolean`);
  }
  return value;
}

function requireInteger(value: PackageContractCborValue | undefined, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`${name} must be an integer`);
  }
  return value;
}

function requireExactLabels(
  value: Map<number | string, PackageContractCborValue>,
  labels: readonly number[],
  name: string
): void {
  const actual = [...value.keys()];
  if (
    actual.length !== labels.length ||
    labels.some((label) => !actual.includes(label)) ||
    actual.some((label) => typeof label !== 'number')
  ) {
    throw new Error(`${name} contains unexpected labels`);
  }
}

function evidencePayloadToCbor(payload: LifecycleGuestEvidencePayload): Uint8Array {
  return encodeCanonicalPackageCbor(
    new Map<number, PackageContractCborValue>([
      [1, payload.schemaVersion],
      [2, payload.runId],
      [3, payload.traceId],
      [4, payload.requestSha256],
      [5, payload.status],
      [6, payload.startedAt],
      [7, payload.finishedAt],
      [8, payload.guestExecutionId],
      [9, payload.networkPolicySha256],
      [
        10,
        new Map<number, PackageContractCborValue>([
          [1, payload.processContainment.kind],
          [2, payload.processContainment.killOnJobClose],
          [3, payload.processContainment.allChildrenExited],
        ]),
      ],
    ])
  );
}

function decodeEvidencePayload(payload: Uint8Array): LifecycleGuestEvidencePayload {
  const map = requireMap(decodeCanonicalPackageCbor(payload), 'Guest evidence payload');
  requireExactLabels(map, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 'Guest evidence payload');
  const containment = requireMap(map.get(10), 'Guest process containment');
  requireExactLabels(containment, [1, 2, 3], 'Guest process containment');
  const result: LifecycleGuestEvidencePayload = {
    finishedAt: requireString(map.get(7), 'Guest finish time'),
    guestExecutionId: requireString(map.get(8), 'Guest execution ID'),
    networkPolicySha256: requireString(map.get(9), 'Guest network policy digest'),
    processContainment: {
      allChildrenExited: requireBoolean(containment.get(3), 'Guest Job Object child-exit result'),
      killOnJobClose: requireBoolean(containment.get(2), 'Guest Job Object kill-on-close result'),
      kind: requireString(
        containment.get(1),
        'Guest process containment kind'
      ) as 'windows-job-object',
    },
    requestSha256: requireString(map.get(4), 'Guest request digest'),
    runId: requireString(map.get(2), 'Guest run ID'),
    schemaVersion: requireInteger(map.get(1), 'Guest evidence schema version') as 1,
    startedAt: requireString(map.get(6), 'Guest start time'),
    status: requireString(map.get(5), 'Guest lifecycle status') as 'failed' | 'passed',
    traceId: requireString(map.get(3), 'Guest trace ID'),
  };
  if (
    result.schemaVersion !== 1 ||
    !HEX_128_PATTERN.test(result.traceId) ||
    !HEX_256_PATTERN.test(result.requestSha256) ||
    !HEX_256_PATTERN.test(result.networkPolicySha256) ||
    !['failed', 'passed'].includes(result.status)
  ) {
    throw new Error('Guest evidence contains an invalid terminal value');
  }
  if (
    result.processContainment.kind !== 'windows-job-object' ||
    !result.processContainment.killOnJobClose ||
    !result.processContainment.allChildrenExited
  ) {
    throw new Error('Guest evidence did not prove complete Job Object cleanup');
  }
  return result;
}

function protectedHeaders(keyId: Uint8Array): Uint8Array {
  return encodeCanonicalPackageCbor(
    new Map<number, PackageContractCborValue>([
      [1, PACKAGE_COSE_ALGORITHM_EDDSA],
      [2, [PACKAGE_COSE_PURPOSE_HEADER]],
      [4, keyId],
      [PACKAGE_COSE_PURPOSE_HEADER, GUEST_EVIDENCE_PURPOSE],
    ])
  );
}

function signatureStructure(protectedBytes: Uint8Array, payload: Uint8Array): Uint8Array {
  return encodeCanonicalPackageCbor(['Signature1', protectedBytes, new Uint8Array(), payload]);
}

export async function buildLifecycleGuestEvidenceForTest(input: {
  keyId: string;
  payload: LifecycleGuestEvidencePayload;
  privateKey: Uint8Array;
}): Promise<Uint8Array> {
  const payload = evidencePayloadToCbor(input.payload);
  const protectedBytes = protectedHeaders(Buffer.from(input.keyId, 'utf8'));
  const signature = await ed25519.signAsync(
    signatureStructure(protectedBytes, payload),
    input.privateKey
  );
  return encodeCanonicalPackageCbor([protectedBytes, new Map(), payload, signature]);
}

export async function decodeAndVerifyLifecycleGuestEvidence(input: {
  coseSign1: Uint8Array;
  expectedKeyId: string;
  expectedNetworkPolicySha256?: string;
  expectedRequestSha256: string;
  expectedRunId: string;
  expectedTraceId: string;
  publicKey: Uint8Array;
}): Promise<LifecycleGuestEvidencePayload> {
  if (input.publicKey.byteLength !== 32) {
    throw new Error('The trusted guest evidence public key is invalid');
  }
  const envelope = requireArray(
    decodeCanonicalPackageCbor(input.coseSign1),
    'Guest evidence COSE_Sign1'
  );
  if (envelope.length !== 4) {
    throw new Error('Guest evidence COSE_Sign1 must contain four fields');
  }
  const protectedBytes = requireBytes(envelope[0], 'Guest evidence protected headers');
  const unprotected = requireMap(envelope[1], 'Guest evidence unprotected headers');
  const payload = requireBytes(envelope[2], 'Guest evidence payload');
  const signature = requireBytes(envelope[3], 'Guest evidence signature', 64);
  if (unprotected.size !== 0) {
    throw new Error('Guest evidence unprotected headers must be empty');
  }
  const headers = requireMap(
    decodeCanonicalPackageCbor(protectedBytes),
    'Guest evidence protected headers'
  );
  requireExactLabels(
    headers,
    [1, 2, 4, PACKAGE_COSE_PURPOSE_HEADER],
    'Guest evidence protected headers'
  );
  if (requireInteger(headers.get(1), 'Guest evidence algorithm') !== PACKAGE_COSE_ALGORITHM_EDDSA) {
    throw new Error('Guest evidence algorithm is not EdDSA');
  }
  const critical = requireArray(headers.get(2), 'Guest evidence critical headers');
  if (
    critical.length !== 1 ||
    requireInteger(critical[0], 'Guest evidence critical purpose') !== PACKAGE_COSE_PURPOSE_HEADER
  ) {
    throw new Error('Guest evidence purpose is not critical');
  }
  const keyId = requireBytes(headers.get(4), 'Guest evidence key ID');
  if (Buffer.from(keyId).toString('utf8') !== input.expectedKeyId) {
    throw new Error('Guest evidence key ID is not trusted');
  }
  if (
    requireString(headers.get(PACKAGE_COSE_PURPOSE_HEADER), 'Guest evidence purpose') !==
    GUEST_EVIDENCE_PURPOSE
  ) {
    throw new Error('Guest evidence purpose is invalid');
  }
  if (
    !(await ed25519.verifyAsync(
      signature,
      signatureStructure(protectedBytes, payload),
      input.publicKey
    ))
  ) {
    throw new Error('Guest evidence signature is invalid');
  }

  const result = decodeEvidencePayload(payload);
  if (result.requestSha256 !== input.expectedRequestSha256) {
    throw new Error('Guest evidence request digest does not match');
  }
  if (
    input.expectedNetworkPolicySha256 &&
    result.networkPolicySha256 !== input.expectedNetworkPolicySha256
  ) {
    throw new Error('Guest evidence network policy digest does not match');
  }
  if (result.runId !== input.expectedRunId) {
    throw new Error('Guest evidence run ID does not match');
  }
  if (result.traceId !== input.expectedTraceId) {
    throw new Error('Guest evidence trace ID does not match');
  }
  return result;
}
