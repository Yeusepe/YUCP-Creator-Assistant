import { parseArgs } from 'node:util';
import { normalizeBackstageRawPayload } from '../packages/shared/src/backstageRawPayload';
import { materializeBackstageReleaseArtifact } from '../packages/shared/src/backstageReleaseMaterialization';
import { sha256Hex } from '../packages/shared/src/crypto';
import { buildBunToolCommand } from './cli-utils';

type ReleaseRecord = {
  deliveryPackageReleaseId: string;
  version: string;
  channel: string;
  releaseStatus: string;
  zipSha256?: string;
};

type ReleaseDetails = {
  _id: string;
  deliveryPackageId: string;
  packageId: string;
  version: string;
  zipSha256?: string;
  signedArtifactId?: string;
  artifactKey?: string;
  metadata?: Record<string, unknown>;
};

type PackageDetails = {
  _id: string;
  packageName?: string;
  displayName?: string;
};

type DeliveryArtifactRecord = {
  _id: string;
  storageId: string;
  contentType: string;
  deliveryName: string;
  sha256: string;
  sourceArtifactId?: string;
};

type SignedArtifactDownload = {
  storageId: string;
  downloadUrl: string;
  contentType: string;
  deliveryName: string;
  plaintextSha256: string;
};

type DeliveryArtifactDownload = {
  storageId: string;
  downloadUrl: string;
  contentType: string;
  deliveryName: string;
  sha256: string;
};

type ArtifactRemediationPlan = {
  deliverableChanged: boolean;
  rawArtifactNeedsReplace: boolean;
  deliverableNeedsRepublish: boolean;
  requiresRepair: boolean;
};

function printUsage() {
  console.log(
    [
      'backstage-deliverable-remediation',
      '',
      'Usage:',
      '  bun ops/backstage-deliverable-remediation.ts --packageId=com.yucp.jammr --version=2.1.5',
      '  bun ops/backstage-deliverable-remediation.ts --packageId=com.yucp.jammr --version=2.1.5 --channel=stable',
      '',
      'Options:',
      '  --packageId <id>    Required package id to inspect.',
      '  --version <ver>     Optional release version filter.',
      '  --channel <name>    Optional channel filter.',
      '  --apply             Removed. Backstage package bytes must stay in Lore.',
      '  --help              Show this message.',
    ].join('\n')
  );
}

async function readProcessOutput(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) {
    return '';
  }
  return await new Response(stream).text();
}

async function runConvexFunction<T>(functionName: string, args: unknown): Promise<T> {
  const proc = Bun.spawn({
    cmd: buildBunToolCommand('convex', [
      'run',
      '--typecheck',
      'enable',
      functionName,
      JSON.stringify(args),
    ]),
    env: process.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    readProcessOutput(proc.stdout),
    readProcessOutput(proc.stderr),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || stdout.trim() || `Convex run failed for ${functionName}`);
  }

  const trimmed = stdout.trim();
  if (!trimmed) {
    return null as T;
  }
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    return Function(`"use strict"; return (${trimmed});`)() as T;
  }
}

export function computeArtifactRemediationPlan(input: {
  currentDeliverableSha256?: string;
  nextDeliverableSha256: string;
  currentDeliverableSourceArtifactId?: string;
  activeRawArtifactId?: string;
  rawArtifact: {
    sha256: string;
    contentType: string;
    deliveryName: string;
  } | null;
  rawPayloadSha256: string;
  rawPayloadContentType: string;
  rawPayloadDeliveryName: string;
}): ArtifactRemediationPlan {
  const deliverableChanged = input.currentDeliverableSha256 !== input.nextDeliverableSha256;
  const rawArtifactNeedsReplace =
    !input.rawArtifact ||
    input.rawArtifact.sha256 !== input.rawPayloadSha256 ||
    input.rawArtifact.contentType !== input.rawPayloadContentType ||
    input.rawArtifact.deliveryName !== input.rawPayloadDeliveryName;
  const deliverableNeedsRepublish =
    deliverableChanged ||
    rawArtifactNeedsReplace ||
    (input.activeRawArtifactId != null &&
      input.currentDeliverableSourceArtifactId !== input.activeRawArtifactId);
  return {
    deliverableChanged,
    rawArtifactNeedsReplace,
    deliverableNeedsRepublish,
    requiresRepair: deliverableNeedsRepublish,
  };
}

async function main(argv: readonly string[] = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      packageId: { type: 'string' },
      version: { type: 'string' },
      channel: { type: 'string' },
      apply: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.help || !values.packageId) {
    printUsage();
    return;
  }
  if (values.apply) {
    throw new Error(
      'Applying legacy Backstage Convex storage remediation has been removed. Republish through the Lore Backstage upload flow.'
    );
  }

  const releases = await runConvexFunction<ReleaseRecord[]>(
    'packageRegistry:listDeliveryPackageReleasesByPackage',
    {
      packageId: values.packageId,
      version: values.version,
      channel: values.channel,
    }
  );
  if (releases.length === 0) {
    throw new Error(`No delivery package releases found for ${values.packageId}`);
  }

  const results: Array<Record<string, unknown>> = [];
  for (const releaseRecord of releases) {
    if (releaseRecord.releaseStatus !== 'published') {
      results.push({
        deliveryPackageReleaseId: releaseRecord.deliveryPackageReleaseId,
        version: releaseRecord.version,
        channel: releaseRecord.channel,
        status: 'skipped',
        reason: `release status ${releaseRecord.releaseStatus}`,
      });
      continue;
    }

    const release = await runConvexFunction<ReleaseDetails>(
      'packageRegistry:getDeliveryPackageReleaseById',
      {
        deliveryPackageReleaseId: releaseRecord.deliveryPackageReleaseId,
      }
    );
    const deliveryPackage = await runConvexFunction<PackageDetails>(
      'packageRegistry:getDeliveryPackageById',
      {
        deliveryPackageId: release.deliveryPackageId,
      }
    );
    const rawArtifact = await runConvexFunction<DeliveryArtifactRecord | null>(
      'releaseArtifacts:getActiveDeliveryArtifactRecordForRelease',
      {
        deliveryPackageReleaseId: releaseRecord.deliveryPackageReleaseId,
        artifactRole: 'raw_upload',
      }
    );
    const deliverableArtifact = await runConvexFunction<DeliveryArtifactRecord | null>(
      'releaseArtifacts:getActiveDeliveryArtifactRecordForRelease',
      {
        deliveryPackageReleaseId: releaseRecord.deliveryPackageReleaseId,
        artifactRole: 'server_deliverable',
      }
    );

    let sourceDownload:
      | { contentType: string; deliveryName: string; downloadUrl: string }
      | DeliveryArtifactDownload
      | SignedArtifactDownload
      | null = null;
    let rawArtifactId = rawArtifact?._id;
    if (rawArtifact) {
      sourceDownload = await runConvexFunction<DeliveryArtifactDownload>(
        'releaseArtifacts:getDeliveryArtifactDownloadById',
        {
          artifactId: rawArtifact._id,
        }
      );
    } else if (deliverableArtifact) {
      sourceDownload = await runConvexFunction<DeliveryArtifactDownload>(
        'releaseArtifacts:getDeliveryArtifactDownloadById',
        {
          artifactId: deliverableArtifact._id,
        }
      );
    } else if (release.signedArtifactId) {
      sourceDownload = await runConvexFunction<SignedArtifactDownload>(
        'releaseArtifacts:getArtifactDownloadById',
        {
          artifactId: release.signedArtifactId,
        }
      );
    } else if (release.artifactKey) {
      sourceDownload = await runConvexFunction<SignedArtifactDownload>(
        'releaseArtifacts:getLatestActiveArtifactDownloadByKey',
        {
          artifactKey: release.artifactKey,
        }
      );
    }

    if (!sourceDownload) {
      results.push({
        deliveryPackageReleaseId: releaseRecord.deliveryPackageReleaseId,
        version: releaseRecord.version,
        channel: releaseRecord.channel,
        status: 'missing_source',
      });
      continue;
    }

    const sourceResponse = await fetch(sourceDownload.downloadUrl);
    if (!sourceResponse.ok) {
      throw new Error(
        `Failed to download source artifact: ${sourceResponse.status} ${await sourceResponse.text()}`
      );
    }
    const sourceBytes = new Uint8Array(await sourceResponse.arrayBuffer());
    const rawPayload = normalizeBackstageRawPayload({
      sourceBytes,
      contentType: sourceDownload.contentType,
      deliveryName: sourceDownload.deliveryName,
      packageId: release.packageId,
      version: release.version,
    });
    const materialized = await materializeBackstageReleaseArtifact({
      sourceBytes: rawPayload.bytes,
      deliveryName: rawPayload.deliveryName,
      contentType: rawPayload.contentType,
      packageId: release.packageId,
      version: release.version,
      displayName: deliveryPackage.displayName ?? deliveryPackage.packageName,
      metadata: release.metadata,
    });
    const rawPayloadSha256 = await sha256Hex(rawPayload.bytes);
    const remediationPlan = computeArtifactRemediationPlan({
      currentDeliverableSha256: release.zipSha256,
      nextDeliverableSha256: materialized.sha256,
      currentDeliverableSourceArtifactId: deliverableArtifact?.sourceArtifactId,
      activeRawArtifactId: rawArtifact?._id,
      rawArtifact: rawArtifact
        ? {
            sha256: rawArtifact.sha256,
            contentType: rawArtifact.contentType,
            deliveryName: rawArtifact.deliveryName,
          }
        : null,
      rawPayloadSha256,
      rawPayloadContentType: rawPayload.contentType,
      rawPayloadDeliveryName: rawPayload.deliveryName,
    });

    results.push({
      deliveryPackageReleaseId: releaseRecord.deliveryPackageReleaseId,
      version: releaseRecord.version,
      channel: releaseRecord.channel,
      status: remediationPlan.requiresRepair ? 'stale' : 'current',
      previousZipSha256: release.zipSha256,
      nextZipSha256: materialized.sha256,
      rawDeliveryName: rawPayload.deliveryName,
      nextDeliveryName: materialized.deliveryName,
    });
  }

  console.log(JSON.stringify(results, null, 2));
}

if (import.meta.main) {
  main().catch((error) => {
    console.error('[backstage-deliverable-remediation]', error);
    process.exit(1);
  });
}
