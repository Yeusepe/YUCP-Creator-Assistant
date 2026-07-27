import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  createLifecycleTraceContext,
  inspectLocalLifecycleCapabilities,
  LifecycleCapabilityError,
  type LifecycleEvidenceReport,
  LifecycleStageError,
  passkeyFailureStep,
  writeLifecycleEvidenceAtomically,
} from './localLifecycle';
import { PasskeyFlowError } from './playwrightPasskey';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { force: true, recursive: true }))
  );
});

function completeExternalEnvironment(): NodeJS.ProcessEnv {
  return {
    PACKAGE_LIFECYCLE_HYPERV_CHECKPOINT: 'yucp-clean',
    PACKAGE_LIFECYCLE_HYPERV_CHECKPOINT_ID: '22222222-2222-4222-8222-222222222222',
    PACKAGE_LIFECYCLE_HYPERV_GUEST_AGENT_COMMAND:
      'C:\\Program Files\\YUCP\\LifecycleAgent\\yucp-lifecycle-agent.exe',
    PACKAGE_LIFECYCLE_HYPERV_GUEST_API_ORIGIN: 'http://192.0.2.10:3002',
    PACKAGE_LIFECYCLE_HYPERV_GUEST_EVIDENCE_KEY_ID: 'guest-lifecycle-2026',
    PACKAGE_LIFECYCLE_HYPERV_GUEST_EVIDENCE_PUBLIC_KEY: Buffer.alloc(32, 7).toString('base64url'),
    PACKAGE_LIFECYCLE_HYPERV_GUEST_PASSWORD: 'guest-password',
    PACKAGE_LIFECYCLE_HYPERV_GUEST_USER: 'YUCPGuest',
    PACKAGE_LIFECYCLE_HYPERV_GUEST_WEB_ORIGIN: 'http://192.0.2.10:3000',
    PACKAGE_LIFECYCLE_HYPERV_OWNERSHIP_MARKER: 'YUCP_PACKAGE_LIFECYCLE_DEDICATED_V1',
    PACKAGE_LIFECYCLE_HYPERV_SWITCH_NAME: 'YUCP Lifecycle Internal',
    PACKAGE_LIFECYCLE_HYPERV_VM_ID: '11111111-1111-4111-8111-111111111111',
    PACKAGE_LIFECYCLE_HYPERV_VM_NAME: 'YUCP Lifecycle',
    PACKAGE_LIFECYCLE_PACKAGE_V1_PATH: 'package-v1.zip',
  };
}

describe('local package lifecycle', () => {
  it('exposes the production lifecycle command', async () => {
    const packageJson = JSON.parse(
      await readFile(resolve(import.meta.dir, '../../package.json'), 'utf8')
    ) as { scripts?: Record<string, string> };

    expect(packageJson.scripts?.['test:package-lifecycle:local']).toBe(
      'bun run ./ops/package-lifecycle/localLifecycle.ts'
    );
  });

  it('awaits the executable lifecycle before Bun can exit', async () => {
    const source = await readFile(join(import.meta.dir, 'localLifecycle.ts'), 'utf8');

    expect(source).toMatch(/if \(import\.meta\.main\) \{\s*await run\(\)\.catch/);
  });

  it('delegates browser and Unity state to the isolated guest', async () => {
    const source = await readFile(join(import.meta.dir, 'localLifecycle.ts'), 'utf8');

    expect(source).toContain('runHyperVLifecycleGuestRequest');
    expect(source).not.toContain('startNodeBrowserLifecycle');
    expect(source).not.toContain('chromium.launch');
  });

  it('contains no deliberate VPM lifecycle blocker', async () => {
    const source = await readFile(join(import.meta.dir, 'localLifecycle.ts'), 'utf8');

    expect(source).not.toContain('PACKAGE_LIFECYCLE_VPM_BOOTSTRAP_DRIVER');
    expect(source).toContain('runCompleteLocalPackageLifecycle');
  });

  it('requires the package fixture and complete Hyper-V boundary before startup', () => {
    const report = inspectLocalLifecycleCapabilities({});
    const serialized = JSON.stringify(report);

    expect(report.ready).toBeFalse();
    expect(report.blockers).toContainEqual({
      capability: 'PACKAGE_LIFECYCLE_PACKAGE_V1_PATH',
      code: 'PACKAGE_LIFECYCLE_EXTERNAL_PREREQUISITE_MISSING',
    });
    expect(serialized).not.toContain('DISCORD');
    expect(serialized).not.toContain('PROVIDER_LICENSE_KEY');
    expect(report.blockers).toContainEqual({
      capability: 'PACKAGE_LIFECYCLE_HYPERV_VM_NAME',
      code: 'PACKAGE_LIFECYCLE_EXTERNAL_PREREQUISITE_MISSING',
    });
    expect(report.blockers).toContainEqual({
      capability: 'PACKAGE_LIFECYCLE_HYPERV_CHECKPOINT',
      code: 'PACKAGE_LIFECYCLE_EXTERNAL_PREREQUISITE_MISSING',
    });
  });

  it('uses the in-process runtime without a secret-bearing manifest', () => {
    const report = inspectLocalLifecycleCapabilities(completeExternalEnvironment());

    expect(report).toEqual({
      blockers: [],
      ready: true,
    });
  });

  it('creates a W3C-compatible trace context', () => {
    const context = createLifecycleTraceContext();

    expect(context.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(context.traceparent).toMatch(new RegExp(`^00-${context.traceId}-[0-9a-f]{16}-01$`));
  });

  it('reports the failed stage without exposing the underlying error', () => {
    const error = new LifecycleStageError(
      'enroll and measure creator passkey',
      new Error('credential-value-must-not-escape')
    );

    expect(error.stage).toBe('enroll and measure creator passkey');
    expect(error.message).toBe(
      'PACKAGE_LIFECYCLE_STAGE_FAILED: enroll and measure creator passkey'
    );
    expect(error.message).not.toContain('credential-value-must-not-escape');
    expect(error.cause).toBeInstanceOf(Error);
  });

  it('extracts only the stable passkey step from a nested stage failure', () => {
    const error = new LifecycleStageError(
      'enroll and measure creator and buyer passkeys',
      new LifecycleStageError(
        'nested',
        new PasskeyFlowError('open-security-page', new Error('credential-value'))
      )
    );

    expect(passkeyFailureStep(error)).toBe('open-security-page');
  });

  it('writes a credential-free evidence report atomically', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yucp-lifecycle-'));
    temporaryRoots.push(root);
    const reportPath = join(root, 'evidence.json');
    const report: LifecycleEvidenceReport = {
      blockers: [
        {
          capability: 'PACKAGE_LIFECYCLE_TOPOLOGY_MANIFEST_PATH',
          code: 'PACKAGE_LIFECYCLE_TOPOLOGY_CONTROL_UNAVAILABLE',
        },
      ],
      finishedAt: '2026-07-26T00:00:01.000Z',
      phases: [],
      runId: 'run-1',
      schemaVersion: 1,
      startedAt: '2026-07-26T00:00:00.000Z',
      status: 'failed',
      traceId: '0123456789abcdef0123456789abcdef',
    };

    await writeLifecycleEvidenceAtomically(reportPath, report);

    expect(JSON.parse(await readFile(reportPath, 'utf8'))).toEqual(report);
    expect(await readdir(root)).toEqual(['evidence.json']);
  });

  it('rejects credential-shaped evidence before writing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yucp-lifecycle-'));
    temporaryRoots.push(root);
    const reportPath = join(root, 'evidence.json');

    await expect(
      writeLifecycleEvidenceAtomically(reportPath, {
        blockers: [],
        finishedAt: '2026-07-26T00:00:01.000Z',
        phases: [],
        runId: 'run-1',
        schemaVersion: 1,
        startedAt: '2026-07-26T00:00:00.000Z',
        status: 'failed',
        traceId: '0123456789abcdef0123456789abcdef',
        password: 'must-not-write',
      } as unknown as LifecycleEvidenceReport)
    ).rejects.toBeInstanceOf(LifecycleCapabilityError);
    expect(await readdir(root)).toEqual([]);
  });

  it('allows session and license references but rejects actual secret values', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yucp-lifecycle-'));
    temporaryRoots.push(root);
    const reportPath = join(root, 'evidence.json');
    const report: LifecycleEvidenceReport = {
      blockers: [],
      finishedAt: '2026-07-26T00:00:01.000Z',
      phases: [
        {
          installSessionReference: 'install-session-reference',
          licenseEvidenceReference: 'license-evidence-reference',
          name: 'register buyer license session',
          status: 'passed',
        },
      ],
      runId: 'run-1',
      schemaVersion: 1,
      startedAt: '2026-07-26T00:00:00.000Z',
      status: 'passed',
      traceId: '0123456789abcdef0123456789abcdef',
    };

    await writeLifecycleEvidenceAtomically(reportPath, report, {
      sensitiveValues: ['real-license-value'],
    });
    expect(JSON.parse(await readFile(reportPath, 'utf8'))).toEqual(report);

    await expect(
      writeLifecycleEvidenceAtomically(
        join(root, 'rejected.json'),
        {
          ...report,
          phases: [
            {
              name: 'real-license-value',
              status: 'passed',
            },
          ],
        },
        {
          sensitiveValues: ['real-license-value'],
        }
      )
    ).rejects.toBeInstanceOf(LifecycleCapabilityError);
  });
});
