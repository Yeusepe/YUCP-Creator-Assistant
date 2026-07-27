import { stat } from 'node:fs/promises';
import { extname, isAbsolute } from 'node:path';
import {
  buildLifecycleGuestRequest,
  type ExecuteHyperVPowerShell,
  type HyperVLifecycleConfiguration,
  type LifecycleGuestEvidencePayload,
  runHyperVLifecycleGuestRequest,
} from './hyperVLocalLifecycle';

const GUEST_FIXTURE_ROOT = 'C:\\ProgramData\\YUCP\\LifecycleAgent\\Fixtures';

export type LocalLifecycleExecutionEvidence = LifecycleGuestEvidencePayload;

async function requireReadablePackage(path: string): Promise<void> {
  if (!isAbsolute(path)) {
    throw new Error('The package lifecycle fixture path must be absolute');
  }
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size === 0) {
    throw new Error('The package lifecycle fixture must be a non-empty file');
  }
}

function requireGuestOrigin(value: string, name: string): string {
  const parsed = new URL(value);
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`${name} must be one HTTP origin`);
  }
  return parsed.origin;
}

function fixtureDestination(runId: string, name: string, sourcePath: string): string {
  const extension = extname(sourcePath).toLowerCase();
  if (!extension || extension.length > 32 || !/^\.[a-z0-9]+$/.test(extension)) {
    throw new Error('The package lifecycle fixture extension is invalid');
  }
  return `${GUEST_FIXTURE_ROOT}\\${runId}\\${name}${extension}`;
}

export async function runCompleteLocalPackageLifecycle(input: {
  buyerEnrollmentCapability: string;
  catalogProductId: string;
  checkpointId: string;
  configuration: HyperVLifecycleConfiguration;
  creatorEnrollmentCapability: string;
  executePowerShell: ExecuteHyperVPowerShell;
  guestApiOrigin: string;
  guestWebOrigin: string;
  licenseKey: string;
  packageId: string;
  packageV1Path: string;
  packageV2Path?: string;
  productName: string;
  runId: string;
  traceId: string;
  traceparent: string;
}): Promise<LocalLifecycleExecutionEvidence> {
  await requireReadablePackage(input.packageV1Path);
  if (input.packageV2Path) {
    await requireReadablePackage(input.packageV2Path);
  }
  const apiOrigin = requireGuestOrigin(input.guestApiOrigin, 'Guest API origin');
  const webOrigin = requireGuestOrigin(input.guestWebOrigin, 'Guest web origin');
  const packageV1Path = fixtureDestination(input.runId, 'package-v1', input.packageV1Path);
  const packageV2Path = input.packageV2Path
    ? fixtureDestination(input.runId, 'package-v2', input.packageV2Path)
    : undefined;
  const issuedAt = new Date();
  const request = buildLifecycleGuestRequest({
    checkpointId: input.checkpointId,
    expiresAt: new Date(issuedAt.getTime() + 15 * 60_000).toISOString(),
    issuedAt: issuedAt.toISOString(),
    kind: 'package-lifecycle',
    lifecycle: {
      apiOrigin,
      buyerEnrollmentCapability: input.buyerEnrollmentCapability,
      catalogProductId: input.catalogProductId,
      creatorEnrollmentCapability: input.creatorEnrollmentCapability,
      licenseKey: input.licenseKey,
      packageId: input.packageId,
      packageV1Path,
      ...(packageV2Path ? { packageV2Path } : {}),
      productName: input.productName,
      traceparent: input.traceparent,
      webOrigin,
    },
    networkAllowlist: [apiOrigin, webOrigin],
    runId: input.runId,
    traceId: input.traceId,
  });

  return await runHyperVLifecycleGuestRequest({
    configuration: input.configuration,
    executePowerShell: input.executePowerShell,
    guestFiles: [
      {
        destinationPath: packageV1Path,
        sourcePath: input.packageV1Path,
      },
      ...(input.packageV2Path && packageV2Path
        ? [
            {
              destinationPath: packageV2Path,
              sourcePath: input.packageV2Path,
            },
          ]
        : []),
    ],
    request,
  });
}
