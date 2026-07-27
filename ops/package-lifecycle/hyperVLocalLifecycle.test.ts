import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as ed25519 from '@noble/ed25519';
import {
  buildHyperVGuestSessionScript,
  buildHyperVProbeScript,
  buildLifecycleGuestEvidenceForTest,
  buildLifecycleGuestRequest,
  buildMinimalHyperVChildEnvironment,
  createHyperVPowerShellExecutor,
  decodeAndVerifyLifecycleGuestEvidence,
  inspectHyperVLifecycleConfiguration,
  runHyperVLifecycleGuestRequest,
} from './hyperVLocalLifecycle';

const publicKey = Buffer.alloc(32, 7).toString('base64url');
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { force: true, recursive: true }))
  );
});

function completeEnvironment(): NodeJS.ProcessEnv {
  return {
    PACKAGE_LIFECYCLE_HYPERV_CHECKPOINT: 'yucp-clean',
    PACKAGE_LIFECYCLE_HYPERV_CHECKPOINT_ID: '22222222-2222-4222-8222-222222222222',
    PACKAGE_LIFECYCLE_HYPERV_GUEST_AGENT_COMMAND:
      'C:\\Program Files\\YUCP\\LifecycleAgent\\yucp-lifecycle-agent.exe',
    PACKAGE_LIFECYCLE_HYPERV_GUEST_EVIDENCE_KEY_ID: 'guest-lifecycle-2026',
    PACKAGE_LIFECYCLE_HYPERV_GUEST_EVIDENCE_PUBLIC_KEY: publicKey,
    PACKAGE_LIFECYCLE_HYPERV_GUEST_PASSWORD: 'not-recorded',
    PACKAGE_LIFECYCLE_HYPERV_GUEST_USER: 'YUCPGuest',
    PACKAGE_LIFECYCLE_HYPERV_OWNERSHIP_MARKER: 'YUCP_PACKAGE_LIFECYCLE_DEDICATED_V1',
    PACKAGE_LIFECYCLE_HYPERV_SWITCH_NAME: 'YUCP Lifecycle Internal',
    PACKAGE_LIFECYCLE_HYPERV_VM_ID: '11111111-1111-4111-8111-111111111111',
    PACKAGE_LIFECYCLE_HYPERV_VM_NAME: 'YUCP Lifecycle',
  };
}

describe('Hyper-V local lifecycle boundary', () => {
  test('does not expose Infisical or repository secrets to PowerShell', () => {
    const environment = buildMinimalHyperVChildEnvironment({
      COMSPEC: 'C:\\Windows\\System32\\cmd.exe',
      PACKAGE_LIFECYCLE_SECRET_SENTINEL: 'must-not-escape',
      PATH: 'C:\\Windows\\System32',
      SYSTEMROOT: 'C:\\Windows',
      VPM_BASE_URL: 'https://secret-bearing.example',
      WINDIR: 'C:\\Windows',
    });

    expect(environment).toEqual({
      COMSPEC: 'C:\\Windows\\System32\\cmd.exe',
      PATH: 'C:\\Windows\\System32',
      SYSTEMROOT: 'C:\\Windows',
      WINDIR: 'C:\\Windows',
    });
  });

  test.skipIf(process.platform !== 'win32')(
    'passes sensitive protocol bytes through stdin and removes the script',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'yucp-hyperv-runner-'));
      temporaryRoots.push(root);
      const execute = createHyperVPowerShellExecutor({ operationRoot: root });

      const result = await execute({
        input: 'must-not-appear\n',
        script:
          "$value = [Console]::In.ReadLine()\n[Console]::Out.Write(('LENGTH:' + $value.Length))",
        timeoutMs: 30_000,
      });

      expect(result).toEqual({
        exitCode: 0,
        stderr: '',
        stdout: 'LENGTH:15',
      });
      expect(await Array.fromAsync(new Bun.Glob('*.ps1').scan({ cwd: root }))).toEqual([]);
    }
  );

  test('fails closed when the VM boundary is not configured', () => {
    const result = inspectHyperVLifecycleConfiguration({});

    expect(result.ready).toBeFalse();
    expect(result.blockers.map((blocker) => blocker.capability).sort()).toEqual([
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
    ]);
  });

  test('rejects malformed trust configuration before probing Hyper-V', () => {
    const environment = completeEnvironment();
    environment.PACKAGE_LIFECYCLE_HYPERV_GUEST_EVIDENCE_PUBLIC_KEY = 'not-a-key';

    const result = inspectHyperVLifecycleConfiguration(environment);

    expect(result.ready).toBeFalse();
    expect(result.blockers).toContainEqual({
      capability: 'PACKAGE_LIFECYCLE_HYPERV_GUEST_EVIDENCE_PUBLIC_KEY',
      code: 'PACKAGE_LIFECYCLE_HYPERV_CONFIGURATION_INVALID',
    });
  });

  test('builds a read-only exact-name Hyper-V probe', () => {
    const inspected = inspectHyperVLifecycleConfiguration(completeEnvironment());
    if (!inspected.ready) {
      throw new Error('Expected complete Hyper-V configuration');
    }

    const script = buildHyperVProbeScript(inspected.configuration);

    expect(script).toContain(
      "Get-VM -Id ([Guid]'11111111-1111-4111-8111-111111111111') -ErrorAction Stop"
    );
    expect(script).toContain("[Guid]'22222222-2222-4222-8222-222222222222'");
    expect(script).toContain('YUCP_PACKAGE_LIFECYCLE_DEDICATED_V1');
    expect(script).toContain("$vm.State -ne 'Off'");
    expect(script).toContain('Get-VMIntegrationService');
    expect(script).not.toContain('Start-VM');
    expect(script).not.toContain('Stop-VM');
    expect(script).not.toContain('Restore-VMSnapshot');
    expect(script).not.toContain('not-recorded');
  });

  test('escapes PowerShell literals without widening VM selection', () => {
    const environment = completeEnvironment();
    environment.PACKAGE_LIFECYCLE_HYPERV_VM_NAME = "YUCP 'Lifecycle'";
    const inspected = inspectHyperVLifecycleConfiguration(environment);
    if (!inspected.ready) {
      throw new Error('Expected complete Hyper-V configuration');
    }

    const script = buildHyperVProbeScript(inspected.configuration);

    expect(script).toContain("$vm.Name -ne 'YUCP ''Lifecycle'''");
    expect(script).not.toContain('*');
  });

  test('accepts only signed evidence bound to the request, run, and trace', async () => {
    const privateKey = new Uint8Array(32).fill(11);
    const trustedPublicKey = await ed25519.getPublicKeyAsync(privateKey);
    const payload = {
      finishedAt: '2026-07-26T01:02:03.000Z',
      guestExecutionId: 'guest-execution-id-1',
      networkPolicySha256: 'c'.repeat(64),
      processContainment: {
        allChildrenExited: true,
        killOnJobClose: true,
        kind: 'windows-job-object',
      },
      requestSha256: 'a'.repeat(64),
      runId: 'run-1',
      schemaVersion: 1 as const,
      startedAt: '2026-07-26T01:00:00.000Z',
      status: 'passed' as const,
      traceId: 'b'.repeat(32),
    };
    const envelope = await buildLifecycleGuestEvidenceForTest({
      keyId: 'guest-lifecycle-2026',
      payload,
      privateKey,
    });

    await expect(
      decodeAndVerifyLifecycleGuestEvidence({
        coseSign1: envelope,
        expectedKeyId: 'guest-lifecycle-2026',
        expectedRequestSha256: 'a'.repeat(64),
        expectedRunId: 'run-1',
        expectedTraceId: 'b'.repeat(32),
        publicKey: trustedPublicKey,
      })
    ).resolves.toEqual(payload);

    await expect(
      decodeAndVerifyLifecycleGuestEvidence({
        coseSign1: envelope,
        expectedKeyId: 'guest-lifecycle-2026',
        expectedRequestSha256: 'c'.repeat(64),
        expectedRunId: 'run-1',
        expectedTraceId: 'b'.repeat(32),
        publicKey: trustedPublicKey,
      })
    ).rejects.toThrow('request digest');
  });

  test('rejects evidence without complete Job Object cleanup', async () => {
    const privateKey = new Uint8Array(32).fill(13);
    const envelope = await buildLifecycleGuestEvidenceForTest({
      keyId: 'guest-lifecycle-2026',
      payload: {
        finishedAt: '2026-07-26T01:02:03.000Z',
        guestExecutionId: 'guest-execution-id-1',
        networkPolicySha256: 'c'.repeat(64),
        processContainment: {
          allChildrenExited: false,
          killOnJobClose: true,
          kind: 'windows-job-object',
        },
        requestSha256: 'a'.repeat(64),
        runId: 'run-1',
        schemaVersion: 1,
        startedAt: '2026-07-26T01:00:00.000Z',
        status: 'passed',
        traceId: 'b'.repeat(32),
      },
      privateKey,
    });

    await expect(
      decodeAndVerifyLifecycleGuestEvidence({
        coseSign1: envelope,
        expectedKeyId: 'guest-lifecycle-2026',
        expectedRequestSha256: 'a'.repeat(64),
        expectedRunId: 'run-1',
        expectedTraceId: 'b'.repeat(32),
        publicKey: await ed25519.getPublicKeyAsync(privateKey),
      })
    ).rejects.toThrow('Job Object');
  });

  test('restores the exact checkpoint before and after an owned guest request', async () => {
    const inspected = inspectHyperVLifecycleConfiguration(completeEnvironment());
    if (!inspected.ready) {
      throw new Error('Expected complete Hyper-V configuration');
    }
    const privateKey = new Uint8Array(32).fill(17);
    inspected.configuration.guestEvidencePublicKey = await ed25519.getPublicKeyAsync(privateKey);
    const request = buildLifecycleGuestRequest({
      checkpointId: '22222222-2222-4222-8222-222222222222',
      expiresAt: '2026-07-26T01:10:00.000Z',
      issuedAt: '2026-07-26T01:00:00.000Z',
      kind: 'probe',
      networkAllowlist: [],
      runId: 'run-1',
      traceId: 'b'.repeat(32),
    });
    const calls: Array<{ input: string; script: string }> = [];
    const result = await runHyperVLifecycleGuestRequest({
      configuration: inspected.configuration,
      executePowerShell: async ({ input, script }) => {
        calls.push({ input, script });
        if (calls.length === 1) {
          return {
            exitCode: 0,
            stderr: '',
            stdout: JSON.stringify({
              checkpointId: '22222222-2222-4222-8222-222222222222',
              generation: 2,
              switchName: 'YUCP Lifecycle Internal',
              vmId: '11111111-1111-4111-8111-111111111111',
            }),
          };
        }
        const envelope = await buildLifecycleGuestEvidenceForTest({
          keyId: 'guest-lifecycle-2026',
          payload: {
            finishedAt: '2026-07-26T01:02:03.000Z',
            guestExecutionId: 'guest-execution-id-1',
            networkPolicySha256: request.networkPolicySha256,
            processContainment: {
              allChildrenExited: true,
              killOnJobClose: true,
              kind: 'windows-job-object',
            },
            requestSha256: request.sha256,
            runId: 'run-1',
            schemaVersion: 1,
            startedAt: '2026-07-26T01:00:00.000Z',
            status: 'passed',
            traceId: 'b'.repeat(32),
          },
          privateKey,
        });
        return {
          exitCode: 0,
          stderr: '',
          stdout: `EVIDENCE:${Buffer.from(envelope).toString('base64url')}\n`,
        };
      },
      request,
    });

    expect(result.status).toBe('passed');
    expect(calls).toHaveLength(2);
    expect(calls[0]?.input).toBe('');
    expect(calls[0]?.script).toBe(buildHyperVProbeScript(inspected.configuration));
    expect(calls[1]?.script).toBe(buildHyperVGuestSessionScript(inspected.configuration));
    expect(calls[1]?.script.match(/Restore-VMSnapshot/g)).toHaveLength(2);
    expect(calls[1]?.script).toContain('Start-VM');
    expect(calls[1]?.script).toContain('$ownedStartSucceeded = $false');
    expect(calls[1]?.script).toContain('if ($ownedStartSucceeded)');
    expect(calls[1]?.script).toContain('Invoke-Command');
    expect(calls[1]?.script).toContain('New-PSSession');
    expect(calls[1]?.script).toContain('$directDeadline');
    expect(calls[1]?.script).toContain('finally');
    expect(calls[1]?.script).not.toContain("if ($vm.State -ne 'Off') { Stop-VM -VM $vm -TurnOff");
    expect(calls[1]?.input).toStartWith('YUCPGuest\nnot-recorded\n');
    expect(calls[1]?.input).not.toContain('Lifecycle Product');
  });

  test('protects and clears the guest request before removing it', () => {
    const inspected = inspectHyperVLifecycleConfiguration(completeEnvironment());
    if (!inspected.ready) {
      throw new Error('Expected complete Hyper-V configuration');
    }

    const script = buildHyperVGuestSessionScript(inspected.configuration);

    expect(script).toContain('SetAccessRuleProtection($true, $false)');
    expect(script).toContain('[System.Security.Principal.WindowsIdentity]::GetCurrent().User');
    expect(script).toContain('[System.Security.Principal.WellKnownSidType]::LocalSystemSid');
    expect(script).toContain('Get-Acl -LiteralPath $requestDirectory');
    expect(script).toContain('$observedSecurity.AreAccessRulesProtected');
    expect(script).toContain('$rule.IsInherited');
    expect(script).toContain('[System.IO.FileMode]::CreateNew');
    expect(script).toContain('[System.IO.FileShare]::None');
    expect(script).toContain('Flush($true)');
    expect(script).toContain('SetLength(0)');
    expect(script).toContain('Remove-Item -LiteralPath $requestDirectory');
  });

  test('fails when the owned VM cleanup reports an error', async () => {
    const inspected = inspectHyperVLifecycleConfiguration(completeEnvironment());
    if (!inspected.ready) {
      throw new Error('Expected complete Hyper-V configuration');
    }
    const request = buildLifecycleGuestRequest({
      checkpointId: '22222222-2222-4222-8222-222222222222',
      expiresAt: '2026-07-26T01:10:00.000Z',
      issuedAt: '2026-07-26T01:00:00.000Z',
      kind: 'probe',
      networkAllowlist: [],
      runId: 'run-1',
      traceId: 'b'.repeat(32),
    });
    let call = 0;

    await expect(
      runHyperVLifecycleGuestRequest({
        configuration: inspected.configuration,
        executePowerShell: async () => {
          call += 1;
          if (call === 1) {
            return {
              exitCode: 0,
              stderr: '',
              stdout: JSON.stringify({
                checkpointId: '22222222-2222-4222-8222-222222222222',
                generation: 2,
                switchName: 'YUCP Lifecycle Internal',
                vmId: '11111111-1111-4111-8111-111111111111',
              }),
            };
          }
          return {
            exitCode: 1,
            stderr: 'The post-run checkpoint restore failed.',
            stdout: '',
          };
        },
        request,
      })
    ).rejects.toThrow('guest session failed');
  });
});
