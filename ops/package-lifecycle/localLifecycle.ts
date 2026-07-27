import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, open, rename } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allocateDevPortSet, startDisposableDevRuntime } from '../dev-supervisor';
import {
  buildLifecycleGuestRequest,
  createHyperVPowerShellExecutor,
  inspectHyperVLifecycleConfiguration,
  probeHyperVLifecyclePrerequisites,
  runHyperVLifecycleGuestRequest,
} from './hyperVLocalLifecycle';
import {
  createLocalBetterAuthBootstrap,
  mintBetterAuthOneTimeEnrollmentCapability,
} from './localBetterAuthBootstrap';
import {
  type LocalLifecycleExecutionEvidence,
  runCompleteLocalPackageLifecycle,
} from './localLifecycleExecution';
import { type LocalProductSeed, seedLocalManualProduct } from './localProductSeed';
import { NodeBrowserLifecycleError } from './nodeBrowserLifecycle';
import { PasskeyFlowError } from './playwrightPasskey';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const externalPrerequisites = [
  'PACKAGE_LIFECYCLE_PACKAGE_V1_PATH',
  'PACKAGE_LIFECYCLE_HYPERV_GUEST_API_ORIGIN',
  'PACKAGE_LIFECYCLE_HYPERV_GUEST_WEB_ORIGIN',
] as const;

const forbiddenEvidenceKeys = new Set([
  'authorization',
  'cookie',
  'credential',
  'email',
  'password',
  'secret',
  'token',
]);

export interface LifecycleBlocker {
  capability: string;
  code:
    | 'PACKAGE_LIFECYCLE_EXTERNAL_PREREQUISITE_MISSING'
    | 'PACKAGE_LIFECYCLE_PASSKEY_SETUP_UNAVAILABLE'
    | 'PACKAGE_LIFECYCLE_TOPOLOGY_CONTROL_INVALID'
    | 'PACKAGE_LIFECYCLE_TOPOLOGY_CONTROL_UNAVAILABLE';
}

export interface LifecycleCapabilityReport {
  blockers: LifecycleBlocker[];
  ready: boolean;
}

export interface LifecycleEvidencePhase {
  finishedAt?: string;
  installSessionReference?: string;
  licenseEvidenceReference?: string;
  name: string;
  startedAt?: string;
  status: 'failed' | 'passed' | 'running';
}

export interface LifecycleEvidenceReport {
  blockers: LifecycleBlocker[];
  finishedAt: string;
  lifecycle?: LocalLifecycleExecutionEvidence;
  phases: LifecycleEvidencePhase[];
  runId: string;
  schemaVersion: 1;
  startedAt: string;
  status: 'failed' | 'passed';
  traceId: string;
}

export interface LifecycleTraceContext {
  traceId: string;
  traceparent: string;
}

export class LifecycleCapabilityError extends Error {
  readonly blockers: LifecycleBlocker[];
  readonly code: string;

  constructor(code: string, blockers: LifecycleBlocker[]) {
    super(code);
    this.name = 'LifecycleCapabilityError';
    this.code = code;
    this.blockers = blockers;
  }
}

export class LifecycleStageError extends Error {
  readonly stage: string;

  constructor(stage: string, cause: unknown) {
    super(`PACKAGE_LIFECYCLE_STAGE_FAILED: ${stage}`, { cause });
    this.name = 'LifecycleStageError';
    this.stage = stage;
  }
}

export function passkeyFailureStep(error: unknown): string | undefined {
  let current = error;
  const visited = new Set<unknown>();
  while (current && typeof current === 'object' && !visited.has(current)) {
    visited.add(current);
    if (current instanceof PasskeyFlowError || current instanceof NodeBrowserLifecycleError) {
      return current.step;
    }
    current = 'cause' in current ? current.cause : undefined;
  }
  return undefined;
}

function hasValue(
  environment: NodeJS.ProcessEnv,
  name: string
): environment is NodeJS.ProcessEnv & Record<string, string> {
  const value = environment[name];
  return typeof value === 'string' && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function findForbiddenEvidenceKey(value: unknown, path = 'report'): string | undefined {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const forbidden = findForbiddenEvidenceKey(item, `${path}[${index}]`);
      if (forbidden) {
        return forbidden;
      }
    }
    return undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  for (const [key, item] of Object.entries(value)) {
    if (forbiddenEvidenceKeys.has(key.toLowerCase())) {
      return `${path}.${key}`;
    }
    const forbidden = findForbiddenEvidenceKey(item, `${path}.${key}`);
    if (forbidden) {
      return forbidden;
    }
  }
  return undefined;
}

export function inspectLocalLifecycleCapabilities(
  environment: NodeJS.ProcessEnv
): LifecycleCapabilityReport {
  const missingPrerequisites = externalPrerequisites
    .filter((name) => !hasValue(environment, name))
    .map<LifecycleBlocker>((capability) => ({
      capability,
      code: 'PACKAGE_LIFECYCLE_EXTERNAL_PREREQUISITE_MISSING',
    }));

  const hyperV = inspectHyperVLifecycleConfiguration(environment);
  const blockers = [
    ...missingPrerequisites,
    ...hyperV.blockers.map<LifecycleBlocker>((blocker) => ({
      capability: blocker.capability,
      code: 'PACKAGE_LIFECYCLE_EXTERNAL_PREREQUISITE_MISSING',
    })),
  ];
  if (blockers.length > 0) {
    return {
      blockers,
      ready: false,
    };
  }

  return {
    blockers: [],
    ready: true,
  };
}

export function createLifecycleTraceContext(): LifecycleTraceContext {
  const traceId = randomBytes(16).toString('hex');
  const parentId = randomBytes(8).toString('hex');
  return {
    traceId,
    traceparent: `00-${traceId}-${parentId}-01`,
  };
}

export async function writeLifecycleEvidenceAtomically(
  targetPath: string,
  report: LifecycleEvidenceReport,
  options: { sensitiveValues?: readonly string[] } = {}
): Promise<void> {
  const forbiddenPath = findForbiddenEvidenceKey(report);
  const serialized = JSON.stringify(report, null, 2);
  const containsSensitiveValue = (options.sensitiveValues ?? []).some(
    (value) => value.length > 0 && serialized.includes(value)
  );
  if (forbiddenPath || containsSensitiveValue) {
    throw new LifecycleCapabilityError('PACKAGE_LIFECYCLE_EVIDENCE_CONTAINS_CREDENTIAL_FIELD', []);
  }

  await mkdir(dirname(targetPath), { recursive: true });
  const temporaryPath = `${targetPath}.${randomUUID()}.tmp`;
  const handle = await open(temporaryPath, 'wx');
  try {
    await handle.writeFile(`${serialized}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporaryPath, targetPath);
}

async function run(): Promise<void> {
  const startedAt = new Date().toISOString();
  const runId = randomUUID();
  const trace = createLifecycleTraceContext();
  const evidencePath =
    process.env.PACKAGE_LIFECYCLE_EVIDENCE_PATH ??
    join(repositoryRoot, '.orchestration', 'package-lifecycle-runs', runId, 'evidence.json');
  const capabilities = inspectLocalLifecycleCapabilities(process.env);

  if (!capabilities.ready) {
    const finishedAt = new Date().toISOString();
    await writeLifecycleEvidenceAtomically(evidencePath, {
      blockers: capabilities.blockers,
      finishedAt,
      phases: [],
      runId,
      schemaVersion: 1,
      startedAt,
      status: 'failed',
      traceId: trace.traceId,
    });
    process.stderr.write(
      `${JSON.stringify({
        blockers: capabilities.blockers,
        code: 'PACKAGE_LIFECYCLE_CAPABILITY_BLOCKED',
        evidencePath,
        traceId: trace.traceId,
      })}\n`
    );
    process.exitCode = 1;
    return;
  }
  const packageV1Path = process.env.PACKAGE_LIFECYCLE_PACKAGE_V1_PATH;
  if (!packageV1Path) {
    throw new LifecycleCapabilityError('PACKAGE_LIFECYCLE_EXTERNAL_PREREQUISITE_MISSING', [
      {
        capability: 'PACKAGE_LIFECYCLE_PACKAGE_V1_PATH',
        code: 'PACKAGE_LIFECYCLE_EXTERNAL_PREREQUISITE_MISSING',
      },
    ]);
  }
  const hyperV = inspectHyperVLifecycleConfiguration(process.env);
  if (!hyperV.ready) {
    throw new LifecycleCapabilityError(
      'PACKAGE_LIFECYCLE_EXTERNAL_PREREQUISITE_MISSING',
      hyperV.blockers.map((blocker) => ({
        capability: blocker.capability,
        code: 'PACKAGE_LIFECYCLE_EXTERNAL_PREREQUISITE_MISSING',
      }))
    );
  }
  const guestApiOrigin = process.env.PACKAGE_LIFECYCLE_HYPERV_GUEST_API_ORIGIN;
  const guestWebOrigin = process.env.PACKAGE_LIFECYCLE_HYPERV_GUEST_WEB_ORIGIN;
  if (!guestApiOrigin || !guestWebOrigin) {
    throw new LifecycleCapabilityError('PACKAGE_LIFECYCLE_EXTERNAL_PREREQUISITE_MISSING', []);
  }
  const runRoot = join(repositoryRoot, '.orchestration', 'package-lifecycle-runs', runId);
  const executePowerShell = createHyperVPowerShellExecutor({
    operationRoot: join(runRoot, 'hyperv-host'),
  });
  const hyperVInventory = await probeHyperVLifecyclePrerequisites({
    configuration: hyperV.configuration,
    executePowerShell,
  });
  const probeIssuedAt = new Date();
  await runHyperVLifecycleGuestRequest({
    configuration: hyperV.configuration,
    executePowerShell,
    request: buildLifecycleGuestRequest({
      checkpointId: hyperVInventory.checkpointId,
      expiresAt: new Date(probeIssuedAt.getTime() + 5 * 60_000).toISOString(),
      issuedAt: probeIssuedAt.toISOString(),
      kind: 'probe',
      networkAllowlist: [],
      runId,
      traceId: trace.traceId,
    }),
  });

  const ports = await allocateDevPortSet();
  const runtime = await startDisposableDevRuntime({
    betterAuthAdditionalTrustedOrigins: [guestWebOrigin],
    convexProfile: 'self-hosted',
    infisical: true,
    ports,
    prefixOutput: true,
  });
  const phases: LifecycleEvidencePhase[] = [];
  let bootstrap: ReturnType<typeof createLocalBetterAuthBootstrap> | undefined;
  let enrollmentCapabilities: string[] = [];
  let productSeed: LocalProductSeed | undefined;
  let activeStage = 'start disposable runtime';
  const sensitiveValues = (): string[] => [
    ...enrollmentCapabilities,
    ...(productSeed?.licenseKey ? [productSeed.licenseKey] : []),
    ...Object.entries(runtime.env)
      .filter(([name]) =>
        /access_key|authorization|cookie|password|private_key|secret|token/i.test(name)
      )
      .flatMap(([, value]) => (value ? [value] : [])),
  ];
  try {
    await runtime.waitUntilReady();
    phases.push({
      finishedAt: new Date().toISOString(),
      name: 'start disposable runtime',
      startedAt,
      status: 'passed',
    });
    activeStage = 'seed lifecycle identities and manual product';
    if (!runtime.convex || !runtime.env.BETTER_AUTH_SECRET) {
      throw new LifecycleCapabilityError('PACKAGE_LIFECYCLE_PASSKEY_SETUP_UNAVAILABLE', [
        {
          capability: 'PACKAGE_LIFECYCLE_PASSKEY_SETUP_INTERFACE',
          code: 'PACKAGE_LIFECYCLE_PASSKEY_SETUP_UNAVAILABLE',
        },
      ]);
    }
    bootstrap = createLocalBetterAuthBootstrap({
      adminKey: runtime.convex.adminKey,
      backendUrl: runtime.convex.backendUrl,
      betterAuthSecret: runtime.env.BETTER_AUTH_SECRET,
    });
    const [creator, buyer] = await Promise.all([
      bootstrap.createEnrollment('Lifecycle Creator'),
      bootstrap.createEnrollment('Lifecycle Buyer'),
    ]);
    const apiSecret = runtime.env.CONVEX_API_SECRET;
    const encryptionSecret = runtime.env.ENCRYPTION_SECRET;
    const internalServiceAuthSecret = runtime.env.INTERNAL_SERVICE_AUTH_SECRET;
    if (!apiSecret || !encryptionSecret || !internalServiceAuthSecret) {
      throw new Error('The self-hosted runtime did not expose the local provider seed authority');
    }
    productSeed = await seedLocalManualProduct({
      adminKey: runtime.convex.adminKey,
      apiSecret,
      backendUrl: runtime.convex.backendUrl,
      buyerAuthUserId: buyer.authUserId,
      creatorAuthUserId: creator.authUserId,
      encryptionSecret,
      internalServiceAuthSecret,
    });
    const [creatorEnrollmentCapability, buyerEnrollmentCapability] = await Promise.all([
      mintBetterAuthOneTimeEnrollmentCapability({
        sessionToken: creator.sessionToken,
        webUrl: runtime.urls.web,
      }),
      mintBetterAuthOneTimeEnrollmentCapability({
        sessionToken: buyer.sessionToken,
        webUrl: runtime.urls.web,
      }),
    ]);
    enrollmentCapabilities = [creatorEnrollmentCapability, buyerEnrollmentCapability];
    activeStage = 'complete isolated browser, VPM, and Unity package lifecycle';
    const lifecycle = await runCompleteLocalPackageLifecycle({
      buyerEnrollmentCapability,
      catalogProductId: productSeed.catalogProductId,
      checkpointId: hyperVInventory.checkpointId,
      configuration: hyperV.configuration,
      creatorEnrollmentCapability,
      executePowerShell,
      guestApiOrigin,
      guestWebOrigin,
      licenseKey: productSeed.licenseKey,
      packageId: productSeed.packageId,
      packageV1Path,
      ...(process.env.PACKAGE_LIFECYCLE_PACKAGE_V2_PATH
        ? { packageV2Path: process.env.PACKAGE_LIFECYCLE_PACKAGE_V2_PATH }
        : {}),
      runId,
      productName: 'Lifecycle Product',
      traceId: trace.traceId,
      traceparent: trace.traceparent,
    });
    phases.push({
      finishedAt: new Date().toISOString(),
      name: 'complete isolated browser, VPM, and Unity package lifecycle',
      startedAt: phases.at(-1)?.finishedAt,
      status: 'passed',
    });
    await writeLifecycleEvidenceAtomically(
      evidencePath,
      {
        blockers: [],
        finishedAt: new Date().toISOString(),
        lifecycle,
        phases,
        runId,
        schemaVersion: 1,
        startedAt,
        status: 'passed',
        traceId: trace.traceId,
      },
      {
        sensitiveValues: sensitiveValues(),
      }
    );
    process.stdout.write(
      `${JSON.stringify({
        evidencePath,
        status: 'passed',
        traceId: trace.traceId,
      })}\n`
    );
  } catch (error) {
    const stageError =
      error instanceof LifecycleStageError ? error : new LifecycleStageError(activeStage, error);
    phases.push({
      finishedAt: new Date().toISOString(),
      name: activeStage,
      startedAt: phases.at(-1)?.finishedAt,
      status: 'failed',
    });
    await writeLifecycleEvidenceAtomically(
      evidencePath,
      {
        blockers: [],
        finishedAt: new Date().toISOString(),
        phases,
        runId,
        schemaVersion: 1,
        startedAt,
        status: 'failed',
        traceId: trace.traceId,
      },
      {
        sensitiveValues: sensitiveValues(),
      }
    );
    throw stageError;
  } finally {
    await productSeed?.cleanup();
    await bootstrap?.cleanup();
    await runtime.stop();
  }
}

if (import.meta.main) {
  await run().catch((error: unknown) => {
    if (error instanceof LifecycleCapabilityError) {
      process.stderr.write(
        `${JSON.stringify({
          blockers: error.blockers,
          code: error.code,
        })}\n`
      );
    } else if (error instanceof LifecycleStageError) {
      process.stderr.write(
        `${JSON.stringify({
          code: 'PACKAGE_LIFECYCLE_STAGE_FAILED',
          passkeyStep: passkeyFailureStep(error),
          stage: error.stage,
        })}\n`
      );
    } else {
      process.stderr.write(
        `${JSON.stringify({
          code: 'PACKAGE_LIFECYCLE_UNEXPECTED_FAILURE',
        })}\n`
      );
    }
    process.exitCode = 1;
  });
}
