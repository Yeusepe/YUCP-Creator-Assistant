import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Catalog, type PackageVersion, PackageVersionNotFoundError } from '../catalog';
import { canonicalizeArtifact } from '../storage-core/canonicalizer';
import { reconstructArtifact, storeArtifact } from '../storage-core/desyncCas';

export interface IngestVersionInput {
  catalog: Catalog;
  storePath: string;
  indexDir: string;
  packageId: string;
  version: string;
  inputPath: string;
}

export interface BeginVersionInput {
  catalog: Catalog;
  packageId: string;
  version: string;
}

export interface AssembleVersionInput {
  catalog: Catalog;
  storePath: string;
  indexDir: string;
  versionId: string;
  inputPath: string;
}

export interface RetrieveVersionInput {
  catalog: Catalog;
  storePath: string;
  versionId: string;
  outputPath: string;
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  const message = String(error).trim();
  return message || 'Unknown ingest failure';
}

export async function beginVersion(input: BeginVersionInput): Promise<PackageVersion> {
  const created = await input.catalog.createVersion({
    packageId: input.packageId,
    version: input.version,
  });

  try {
    return await input.catalog.transition(created.id, 'UPLOADING', {
      event: { type: 'catalog.version.uploading' },
    });
  } catch (error) {
    await input.catalog.markFailed(created.id, errorMessage(error));
    throw error;
  }
}

export async function assembleVersion(input: AssembleVersionInput): Promise<PackageVersion> {
  let scratchPath: string | undefined;

  try {
    try {
      scratchPath = await mkdtemp(join(tmpdir(), 'yucp-ingest-'));
      const canonical = await canonicalizeArtifact({
        inputPath: input.inputPath,
        outputPath: join(scratchPath, 'artifact.canonical'),
      });
      const canonicalSha256 = await sha256File(canonical.path);
      const casIndexId = resolve(input.indexDir, `${canonicalSha256}.caibx`);

      await storeArtifact({
        artifactPath: canonical.path,
        indexPath: casIndexId,
        storePath: input.storePath,
      });

      return await input.catalog.transition(input.versionId, 'ASSEMBLED', {
        fields: {
          formatTag: canonical.formatTag,
          canonicalSha256,
          casIndexId,
        },
        event: { type: 'catalog.version.assembled' },
      });
    } finally {
      if (scratchPath) {
        await rm(scratchPath, { force: true, recursive: true });
      }
    }
  } catch (error) {
    await input.catalog.markFailed(input.versionId, errorMessage(error));
    throw error;
  }
}

export async function ingestVersion(input: IngestVersionInput): Promise<PackageVersion> {
  const uploading = await beginVersion({
    catalog: input.catalog,
    packageId: input.packageId,
    version: input.version,
  });
  return assembleVersion({
    catalog: input.catalog,
    storePath: input.storePath,
    indexDir: input.indexDir,
    versionId: uploading.id,
    inputPath: input.inputPath,
  });
}

const retrievableStates = new Set<PackageVersion['state']>(['ASSEMBLED', 'PROMOTING', 'READY']);

export async function retrieveVersion(input: RetrieveVersionInput): Promise<string> {
  const version = await input.catalog.getVersion(input.versionId);
  if (!version) {
    throw new PackageVersionNotFoundError(input.versionId);
  }
  if (!retrievableStates.has(version.state) || !version.casIndexId || !version.canonicalSha256) {
    throw new Error(
      `Package version ${version.id} is not assembled with a CAS index and canonical SHA-256`
    );
  }

  const outputPath = resolve(input.outputPath);
  await reconstructArtifact({
    indexPath: version.casIndexId,
    outputPath,
    storePath: input.storePath,
  });
  const reconstructedSha256 = await sha256File(outputPath);
  if (reconstructedSha256 !== version.canonicalSha256) {
    throw new Error(
      `Reconstructed SHA-256 mismatch for package version ${version.id}: expected ${version.canonicalSha256}, received ${reconstructedSha256}`
    );
  }

  return outputPath;
}
