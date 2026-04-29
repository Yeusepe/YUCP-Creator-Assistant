import { parseArgs } from 'node:util';
import { unzipSync } from 'fflate';
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

function printUsage() {
  console.log(
    [
      'backstage-deliverable-remediation',
      '',
      'Usage:',
      '  bun ops/backstage-deliverable-remediation.ts --packageId=com.yucp.jammr --version=2.1.5',
      '  bun ops/backstage-deliverable-remediation.ts --packageId=com.yucp.jammr --version=2.1.5 --channel=stable --apply',
      '',
      'Options:',
      '  --packageId <id>    Required package id to inspect.',
      '  --version <ver>     Optional release version filter.',
      '  --channel <name>    Optional channel filter.',
      '  --apply             Upload repaired raw/deliverable artifacts and update zipSha256.',
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
    cmd: buildBunToolCommand('convex', ['run', '--typecheck', 'enable', functionName, JSON.stringify(args)]),
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

async function uploadBytes(bytes: Uint8Array, contentType: string): Promise<string> {
  const uploadUrl = await runConvexFunction<string>('releaseArtifacts:generateDeliveryArtifactUploadUrl', {});
  const response = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Content-Type': contentType,
    },
    body: new Blob(
      [
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      ],
      { type: contentType }
    ),
  });
  if (!response.ok) {
    throw new Error(`Upload failed: ${response.status} ${await response.text()}`);
  }
  const payload = (await response.json()) as { storageId?: string };
  if (!payload.storageId) {
    throw new Error('Upload response did not include storageId');
  }
  return payload.storageId;
}

function normalizeRawPayload(input: {
  sourceBytes: Uint8Array;
  contentType: string;
  deliveryName: string;
  packageId: string;
  version: string;
}): { bytes: Uint8Array; contentType: string; deliveryName: string } {
  if (
    input.contentType === 'application/octet-stream' ||
    input.deliveryName.toLowerCase().endsWith('.unitypackage')
  ) {
    return {
      bytes: input.sourceBytes,
      contentType: 'application/octet-stream',
      deliveryName: input.deliveryName,
    };
  }

  const archive = unzipSync(input.sourceBytes);
  const payloadBytes = archive['BackstagePayload~/payload.unitypackage'];
  if (!payloadBytes) {
    throw new Error(`Legacy wrapper missing BackstagePayload~/payload.unitypackage for ${input.packageId}`);
  }
  const manifestBytes = archive['BackstagePayload~/backstage-payload.json'];
  const manifest = manifestBytes
    ? (JSON.parse(new TextDecoder().decode(manifestBytes)) as { payloadFileName?: string })
    : null;
  return {
    bytes: payloadBytes,
    contentType: 'application/octet-stream',
    deliveryName:
      manifest?.payloadFileName?.trim() || `${input.packageId}-${input.version}.unitypackage`,
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
      throw new Error(`Failed to download source artifact: ${sourceResponse.status} ${await sourceResponse.text()}`);
    }
    const sourceBytes = new Uint8Array(await sourceResponse.arrayBuffer());
    const rawPayload = normalizeRawPayload({
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
    });
    const changed = release.zipSha256 !== materialized.sha256;

    if (values.apply && changed) {
      if (!rawArtifactId) {
        const rawStorageId = await uploadBytes(rawPayload.bytes, rawPayload.contentType);
        rawArtifactId = await runConvexFunction<string>('releaseArtifacts:publishDeliveryArtifact', {
          deliveryPackageReleaseId: releaseRecord.deliveryPackageReleaseId,
          artifactRole: 'raw_upload',
          ownership: 'creator_upload',
          storageId: rawStorageId,
          contentType: rawPayload.contentType,
          deliveryName: rawPayload.deliveryName,
          sha256: await sha256Hex(rawPayload.bytes),
          byteSize: rawPayload.bytes.byteLength,
        });
      }

      const deliverableStorageId = await uploadBytes(materialized.bytes, materialized.contentType);
      await runConvexFunction<string>('releaseArtifacts:publishDeliveryArtifact', {
        deliveryPackageReleaseId: releaseRecord.deliveryPackageReleaseId,
        artifactRole: 'server_deliverable',
        ownership: 'server_materialized',
        materializationStrategy: materialized.materializationStrategy,
        sourceArtifactId: rawArtifactId,
        storageId: deliverableStorageId,
        contentType: materialized.contentType,
        deliveryName: materialized.deliveryName,
        sha256: materialized.sha256,
        byteSize: materialized.byteSize,
      });
      await runConvexFunction<null>('packageRegistry:updateMaterializedReleaseDigest', {
        deliveryPackageReleaseId: releaseRecord.deliveryPackageReleaseId,
        zipSha256: materialized.sha256,
      });
    }

    results.push({
      deliveryPackageReleaseId: releaseRecord.deliveryPackageReleaseId,
      version: releaseRecord.version,
      channel: releaseRecord.channel,
      status: values.apply && changed ? 'repaired' : changed ? 'stale' : 'current',
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
