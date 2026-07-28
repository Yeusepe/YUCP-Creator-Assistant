import { afterEach, describe, expect, it, mock } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Catalog, type CatalogState } from '../catalog';
import { localCasStore } from '../storage-core/desyncCas';
import { signExpiringHmacCapability } from '../storage-core/expiringHmacCapability';
import { signUploadCapability } from '../storage-core/uploadSigning';
import {
  createIngestTusServer,
  handleTusPatchWithOwnershipSignal,
  INGEST_TUS_PATH,
} from './ingestTusServer';
import type { QuarantineExactHead, QuarantineStoragePort } from './quarantine';

const uploadHmacKey = 'security-test-upload-hmac-key-32-bytes';
const legacyProtectionPolicyId = 'common-only-v1';

async function signRemovedPolicyUploadCapability(input: {
  creatorId: string;
  expiresAt: number;
  packageId: string;
  version: string;
  versionId: string;
}) {
  const editionId = 'standard';
  const binding = JSON.stringify([
    'tus-artifact-upload-v2',
    input.creatorId,
    editionId,
    input.packageId,
    input.version,
    null,
    legacyProtectionPolicyId,
  ]);
  const signature = await signExpiringHmacCapability({
    binding: JSON.stringify([input.versionId, binding]),
    expiresAt: input.expiresAt,
    key: uploadHmacKey,
    purpose: 'tus-artifact-upload-v2',
  });
  return {
    ...signature,
    creatorId: input.creatorId,
    editionId,
    packageId: input.packageId,
    protectionPolicyId: legacyProtectionPolicyId,
    version: input.version,
    versionId: input.versionId,
  };
}

interface MemoryCatalogRow {
  active_content_digest: string | null;
  active_policy_version: string | null;
  assembly_object_id: string | null;
  attempts: number;
  binding_root: string | null;
  catalog_product_id: string | null;
  common_root: string | null;
  created_at: Date;
  deleted_at: Date | null;
  deletion_reason: string | null;
  edition_id: string;
  error: string | null;
  id: string;
  logical_bytes: number | null;
  logical_files: number | null;
  manifest_sha256: string | null;
  next_attempt_at: Date | null;
  package_id: string;
  protected_files: unknown[] | null;
  protected_source_root: string | null;
  protection_policy_digest: string | null;
  protection_policy_id: string | null;
  release_root: string | null;
  source_format: string | null;
  state: CatalogState;
  updated_at: Date;
  version: string;
  vpm_dependencies: Record<string, string>;
  vpm_repositories: Record<string, string>;
}

interface MemoryQuarantineRow {
  bytes: number;
  content_type: string;
  created_at: Date;
  file_identifier: string | null;
  object_key: string;
  provider_version: string | null;
  sha256: string;
  state: 'COMMITTED' | 'PENDING' | 'UNCERTAIN';
  updated_at: Date;
  version_id: string;
}

type SqlTag = {
  (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<(MemoryCatalogRow | MemoryQuarantineRow)[]>;
  begin<T>(callback: (transaction: SqlTag) => Promise<T>): Promise<T>;
  json(value: unknown): unknown;
};

async function waitForVersionState(
  rows: Map<string, MemoryCatalogRow>,
  versionId: string,
  state: string,
  timeoutMs = 10_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (rows.get(versionId)?.state === state) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `Package version ${versionId} stayed in ${rows.get(versionId)?.state ?? 'unknown'}, expected ${state}`
  );
}

function createMemoryCatalog(
  options: { onTransition?: (row: MemoryCatalogRow) => Promise<void> } = {}
): { catalog: Catalog; rows: Map<string, MemoryCatalogRow> } {
  const rows = new Map<string, MemoryCatalogRow>();
  const quarantineRows = new Map<string, MemoryQuarantineRow>();
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const statement = strings.join('?');
    if (statement.includes('INSERT INTO package_quarantine_objects')) {
      const versionId = String(values[4]);
      if (quarantineRows.has(versionId) || rows.get(versionId)?.state !== 'UPLOADING') {
        return [];
      }
      const now = new Date();
      const row: MemoryQuarantineRow = {
        bytes: Number(values[2]),
        content_type: String(values[3]),
        created_at: now,
        file_identifier: null,
        object_key: String(values[0]),
        provider_version: null,
        sha256: String(values[1]),
        state: 'PENDING',
        updated_at: now,
        version_id: versionId,
      };
      quarantineRows.set(versionId, row);
      return [row];
    }
    if (
      statement.includes('UPDATE package_quarantine_objects') &&
      statement.includes("state = 'COMMITTED'")
    ) {
      const row = quarantineRows.get(String(values[2]));
      if (!row || !['PENDING', 'UNCERTAIN'].includes(row.state)) {
        return [];
      }
      row.state = 'COMMITTED';
      row.provider_version = String(values[0]);
      row.file_identifier = String(values[1]);
      row.updated_at = new Date();
      return [row];
    }
    if (
      statement.includes('UPDATE package_quarantine_objects') &&
      statement.includes("state = 'UNCERTAIN'")
    ) {
      const row = quarantineRows.get(String(values[0]));
      if (!row || !['PENDING', 'UNCERTAIN'].includes(row.state)) {
        return [];
      }
      row.state = 'UNCERTAIN';
      row.updated_at = new Date();
      return [row];
    }
    if (statement.includes('SELECT *') && statement.includes('package_quarantine_objects')) {
      const row = quarantineRows.get(String(values[0]));
      return row ? [row] : [];
    }
    if (statement.includes('INSERT INTO package_versions')) {
      const duplicate = [...rows.values()].find(
        (candidate) =>
          candidate.package_id === String(values[1]) &&
          candidate.edition_id === String(values[2]) &&
          candidate.version === String(values[3])
      );
      if (duplicate) {
        throw Object.assign(
          new Error(
            'duplicate key value violates unique constraint "package_versions_package_version_unique"'
          ),
          {
            code: '23505',
            constraint_name: 'package_versions_package_version_unique',
          }
        );
      }
      const now = new Date();
      const row: MemoryCatalogRow = {
        active_content_digest: null,
        active_policy_version: null,
        assembly_object_id: null,
        id: String(values[0]),
        package_id: String(values[1]),
        edition_id: String(values[2]),
        version: String(values[3]),
        source_format: null,
        release_root: null,
        state: 'CREATED',
        error: null,
        deleted_at: null,
        deletion_reason: null,
        attempts: 0,
        binding_root: null,
        catalog_product_id: (values[4] as string | null) ?? null,
        common_root: null,
        logical_bytes: null,
        logical_files: null,
        manifest_sha256: null,
        next_attempt_at: null,
        protected_files: null,
        protected_source_root: null,
        protection_policy_digest: null,
        protection_policy_id: null,
        created_at: now,
        updated_at: now,
        vpm_dependencies: {},
        vpm_repositories: {},
      };
      rows.set(row.id, row);
      return [row];
    }
    if (statement.includes('SELECT * FROM package_versions')) {
      const row = rows.get(String(values[0]));
      return row ? [row] : [];
    }
    if (statement.includes('SET updated_at = clock_timestamp()')) {
      const row = rows.get(String(values[0]));
      if (!row || row.state !== values[1]) {
        return [];
      }
      row.updated_at = new Date();
      return [row];
    }
    if (statement.includes('UPDATE package_versions')) {
      const row = rows.get(String(values.at(-1)));
      if (!row) {
        return [];
      }
      row.state = values[0] as CatalogState;
      row.source_format = values[1] as string | null;
      row.release_root = values[2] as string | null;
      row.assembly_object_id = values[3] as string | null;
      row.active_content_digest = values[4] as string | null;
      row.active_policy_version = values[5] as string | null;
      row.binding_root = values[6] as string | null;
      row.common_root = values[7] as string | null;
      row.logical_bytes = values[8] as number | null;
      row.logical_files = values[9] as number | null;
      row.manifest_sha256 = values[10] as string | null;
      row.protected_files = values[11] as unknown[] | null;
      row.protected_source_root = values[12] as string | null;
      row.protection_policy_digest = values[13] as string | null;
      row.protection_policy_id = values[14] as string | null;
      row.vpm_dependencies = values[15] as Record<string, string>;
      row.vpm_repositories = values[16] as Record<string, string>;
      row.error = values[17] as string | null;
      row.deleted_at = values[18] === true ? new Date() : null;
      row.deletion_reason = values[19] as string | null;
      row.attempts = Number(values[20]);
      row.next_attempt_at = null;
      row.updated_at = new Date();
      await options.onTransition?.(row);
      return [row];
    }
    return [];
  }) as SqlTag;
  sql.begin = async <T>(callback: (transaction: SqlTag) => Promise<T>) => callback(sql);
  sql.json = (value: unknown) => value;
  return { catalog: new Catalog(sql as never), rows };
}

function createMemoryQuarantineStorage(): QuarantineStoragePort {
  const versions = new Map<string, QuarantineExactHead>();
  return {
    async headExactVersion(objectKey, providerVersion) {
      const exact = versions.get(objectKey);
      if (!exact || exact.providerVersion !== providerVersion) {
        throw new Error('Exact quarantine version was not found');
      }
      return exact;
    },
    async listVersions(objectKey) {
      const exact = versions.get(objectKey);
      return exact
        ? [
            {
              fileIdentifier: exact.fileIdentifier,
              providerVersion: exact.providerVersion,
            },
          ]
        : [];
    },
    async putFile(file) {
      const exact: QuarantineExactHead = {
        contentLength: file.bytes,
        contentType: file.contentType,
        fileIdentifier: `file-${file.sha256}`,
        metadata: { 'yucp-sha256': file.sha256 },
        providerVersion: `version-${file.sha256}`,
      };
      versions.set(file.objectKey, exact);
      return {
        fileIdentifier: exact.fileIdentifier,
        providerVersion: exact.providerVersion,
      };
    },
  };
}

function uploadMetadata(input: {
  catalogProductId?: string;
  filename: string;
  packageId: string;
  version: string;
}): string {
  return Object.entries(input)
    .map(([key, value]) => `${key} ${Buffer.from(value).toString('base64')}`)
    .join(',');
}

const openServers = new Set<HttpServer>();
const scratchPaths = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...openServers].map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        })
    )
  );
  openServers.clear();
  await Promise.all([...scratchPaths].map((path) => rm(path, { force: true, recursive: true })));
  scratchPaths.clear();
});

describe('ingest tus PATCH ownership scope', () => {
  it('destroys an aborted request, stops writes, and removes the listener after normal completion', async () => {
    const abortController = new AbortController();
    let destroyed = false;
    let bytesWritten = 0;
    const destroy = mock(() => {
      destroyed = true;
    });
    const abortedPatch = handleTusPatchWithOwnershipSignal({
      handle: async () => {
        while (!destroyed) {
          bytesWritten += 1;
          await Bun.sleep(1);
        }
      },
      request: { destroy },
      signal: abortController.signal,
    });
    while (bytesWritten === 0) {
      await Bun.sleep(1);
    }
    abortController.abort(new Error('upload ownership lost'));
    await abortedPatch;
    const bytesAfterAbort = bytesWritten;
    await Bun.sleep(5);

    expect(destroy).toHaveBeenCalledTimes(1);
    expect(bytesWritten).toBe(bytesAfterAbort);

    const normalAbortController = new AbortController();
    const normalDestroy = mock(() => {});
    let normalBytesWritten = 0;
    await handleTusPatchWithOwnershipSignal({
      handle: async () => {
        normalBytesWritten = 2;
      },
      request: { destroy: normalDestroy },
      signal: normalAbortController.signal,
    });
    normalAbortController.abort(new Error('listener must be removed'));

    expect(normalBytesWritten).toBe(2);
    expect(normalDestroy).not.toHaveBeenCalled();
    console.log(
      'INGEST_TUS_OWNERSHIP_LOSS_RESULT request-destroyed=yes bytes-stable-after-abort=yes normal-patch-completed=yes listener-removed=yes'
    );
  });
});

describe('ingest tus upload capability isolation', () => {
  it('rejects a signed legacy protection policy before creating an upload', async () => {
    const scratchPath = await mkdtemp(join(tmpdir(), 'yucp-ingest-policy-'));
    scratchPaths.add(scratchPath);
    const { catalog, rows } = createMemoryCatalog();
    const server = createServer(
      createIngestTusServer({
        catalog,
        commonStore: localCasStore(join(scratchPath, 'common')),
        metadataStore: localCasStore(join(scratchPath, 'metadata')),
        protectedStore: localCasStore(join(scratchPath, 'protected')),
        quarantineStorage: createMemoryQuarantineStorage(),
        scratchRoot: join(scratchPath, 'pipeline-scratch'),
        uploadDir: join(scratchPath, 'uploads'),
        uploadHmacKey,
        catalogControlSharedSecret: 'security-catalog-control-test-secret-32-bytes',
      })
    );
    openServers.add(server);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address() as AddressInfo;
    const endpoint = `http://127.0.0.1:${port}${INGEST_TUS_PATH}`;
    const capability = await signRemovedPolicyUploadCapability({
      creatorId: 'creator-legacy-policy',
      expiresAt: Date.now() + 60_000,
      packageId: 'com.creator.legacy-policy',
      version: '1.0.0',
      versionId: crypto.randomUUID(),
    });

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Tus-Resumable': '1.0.0',
        'Upload-Length': '1',
        'Upload-Metadata': uploadMetadata({
          filename: 'artifact.zip',
          packageId: capability.packageId,
          version: capability.version,
        }),
        'x-yucp-upload-creator-id': capability.creatorId,
        'x-yucp-upload-edition-id': capability.editionId,
        'x-yucp-upload-exp': capability.exp,
        'x-yucp-upload-package-id': encodeURIComponent(capability.packageId),
        'x-yucp-upload-protection-policy-id': capability.protectionPolicyId,
        'x-yucp-upload-sig': capability.sig,
        'x-yucp-upload-version': encodeURIComponent(capability.version),
        'x-yucp-upload-version-id': capability.versionId,
      },
    });

    expect(response.status).toBe(403);
    expect(await response.text()).toBe('Invalid upload capability\n');
    expect(rows.size).toBe(0);
  });

  it('returns a stable conflict when a direct client creates the same package version twice', async () => {
    const scratchPath = await mkdtemp(join(tmpdir(), 'yucp-ingest-duplicate-'));
    scratchPaths.add(scratchPath);
    const { catalog } = createMemoryCatalog();
    const server = createServer(
      createIngestTusServer({
        catalog,
        commonStore: localCasStore(join(scratchPath, 'common')),
        metadataStore: localCasStore(join(scratchPath, 'metadata')),
        protectedStore: localCasStore(join(scratchPath, 'protected')),
        quarantineStorage: createMemoryQuarantineStorage(),
        scratchRoot: join(scratchPath, 'pipeline-scratch'),
        uploadDir: join(scratchPath, 'uploads'),
        uploadHmacKey,
        catalogControlSharedSecret: 'security-catalog-control-test-secret-32-bytes',
      })
    );
    openServers.add(server);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address() as AddressInfo;
    const endpoint = `http://127.0.0.1:${port}${INGEST_TUS_PATH}`;
    const packageId = 'com.creator.duplicate';
    const version = '2.1.19';

    const createUpload = async (): Promise<Response> => {
      const capability = await signUploadCapability({
        creatorId: 'creator-duplicate',
        expiresAt: Date.now() + 60_000,
        key: uploadHmacKey,
        packageId,
        protectionPolicyId: 'supported-visual-assets-v2',
        version,
        versionId: crypto.randomUUID(),
      });
      return await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Tus-Resumable': '1.0.0',
          'Upload-Length': '1',
          'Upload-Metadata': uploadMetadata({
            filename: 'artifact.zip',
            packageId,
            version,
          }),
          'x-yucp-upload-creator-id': capability.creatorId,
          'x-yucp-upload-edition-id': capability.editionId,
          'x-yucp-upload-exp': capability.exp,
          'x-yucp-upload-package-id': encodeURIComponent(capability.packageId),
          'x-yucp-upload-protection-policy-id': capability.protectionPolicyId,
          'x-yucp-upload-sig': capability.sig,
          'x-yucp-upload-version': encodeURIComponent(capability.version),
          'x-yucp-upload-version-id': capability.versionId,
        },
      });
    };

    const first = await createUpload();
    const duplicate = await createUpload();
    const duplicateBody = await duplicate.text();

    expect(first.status).toBe(201);
    expect(duplicate.status).toBe(409);
    expect(duplicateBody).toBe('This package version already exists. Use a new version number.\n');
    expect(duplicateBody).not.toContain('duplicate key');
    expect(duplicateBody).not.toContain('package_versions_package_version_unique');
  });

  it('rejects cross-package metadata before creating a catalog row', async () => {
    const scratchPath = await mkdtemp(join(tmpdir(), 'yucp-ingest-security-'));
    scratchPaths.add(scratchPath);
    const { catalog, rows } = createMemoryCatalog();
    const server = createServer(
      createIngestTusServer({
        catalog,
        commonStore: localCasStore(join(scratchPath, 'common')),
        metadataStore: localCasStore(join(scratchPath, 'metadata')),
        protectedStore: localCasStore(join(scratchPath, 'protected')),
        quarantineStorage: createMemoryQuarantineStorage(),
        scratchRoot: join(scratchPath, 'pipeline-scratch'),
        uploadDir: join(scratchPath, 'uploads'),
        uploadHmacKey,
        catalogControlSharedSecret: 'security-catalog-control-test-secret-32-bytes',
      })
    );
    openServers.add(server);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address() as AddressInfo;
    const signedPackageId = 'com.creator.package-a';
    const capability = await signUploadCapability({
      catalogProductId: 'catalog-product-a',
      creatorId: 'creator-a',
      expiresAt: Date.now() + 60_000,
      key: uploadHmacKey,
      packageId: signedPackageId,
      protectionPolicyId: 'supported-visual-assets-v2',
      version: '1.0.0',
      versionId: crypto.randomUUID(),
    });

    const response = await fetch(`http://127.0.0.1:${port}${INGEST_TUS_PATH}`, {
      method: 'POST',
      headers: {
        'Tus-Resumable': '1.0.0',
        'Upload-Length': '1',
        'Upload-Metadata': uploadMetadata({
          catalogProductId: 'catalog-product-a',
          filename: 'artifact.zip',
          packageId: 'com.victim.package-b',
          version: '1.0.0',
        }),
        'x-yucp-upload-catalog-product-id': encodeURIComponent('catalog-product-a'),
        'x-yucp-upload-creator-id': 'creator-a',
        'x-yucp-upload-edition-id': capability.editionId,
        'x-yucp-upload-exp': capability.exp,
        'x-yucp-upload-package-id': encodeURIComponent(signedPackageId),
        'x-yucp-upload-protection-policy-id': capability.protectionPolicyId,
        'x-yucp-upload-sig': capability.sig,
        'x-yucp-upload-version': encodeURIComponent('1.0.0'),
        'x-yucp-upload-version-id': capability.versionId,
      },
    });

    expect(response.status).toBe(403);
    expect(rows.size).toBe(0);

    const matchingResponse = await fetch(`http://127.0.0.1:${port}${INGEST_TUS_PATH}`, {
      method: 'POST',
      headers: {
        'Tus-Resumable': '1.0.0',
        'Upload-Length': '1',
        'Upload-Metadata': uploadMetadata({
          catalogProductId: 'catalog-product-a',
          filename: 'artifact.zip',
          packageId: signedPackageId,
          version: '1.0.0',
        }),
        'x-yucp-upload-catalog-product-id': encodeURIComponent('catalog-product-a'),
        'x-yucp-upload-creator-id': 'creator-a',
        'x-yucp-upload-edition-id': capability.editionId,
        'x-yucp-upload-exp': capability.exp,
        'x-yucp-upload-package-id': encodeURIComponent(signedPackageId),
        'x-yucp-upload-protection-policy-id': capability.protectionPolicyId,
        'x-yucp-upload-sig': capability.sig,
        'x-yucp-upload-version': encodeURIComponent('1.0.0'),
        'x-yucp-upload-version-id': capability.versionId,
      },
    });

    expect(matchingResponse.status).toBe(201);
    expect([...rows.values()]).toEqual([
      expect.objectContaining({
        catalog_product_id: 'catalog-product-a',
        package_id: signedPackageId,
        state: 'UPLOADING',
        version: '1.0.0',
      }),
    ]);

    const outsideUploadId = '0123456789abcdef0123456789abcdef';
    await writeFile(join(scratchPath, outsideUploadId), 'x');
    await writeFile(
      join(scratchPath, `${outsideUploadId}.json`),
      JSON.stringify({
        id: `../${outsideUploadId}`,
        size: 1,
        offset: 1,
        metadata: { _catalogVersionId: capability.versionId },
        creation_date: new Date().toISOString(),
      })
    );
    const traversalResponse = await fetch(
      `http://127.0.0.1:${port}${INGEST_TUS_PATH}/..%2F${outsideUploadId}`,
      {
        method: 'HEAD',
        headers: {
          'Tus-Resumable': '1.0.0',
          'x-yucp-upload-catalog-product-id': encodeURIComponent('catalog-product-a'),
          'x-yucp-upload-creator-id': 'creator-a',
          'x-yucp-upload-edition-id': capability.editionId,
          'x-yucp-upload-exp': capability.exp,
          'x-yucp-upload-package-id': encodeURIComponent(signedPackageId),
          'x-yucp-upload-protection-policy-id': capability.protectionPolicyId,
          'x-yucp-upload-sig': capability.sig,
          'x-yucp-upload-version': encodeURIComponent('1.0.0'),
          'x-yucp-upload-version-id': capability.versionId,
        },
      }
    );

    expect(traversalResponse.status).toBe(403);
  });

  it('does not fail an assembled upload when tus-file cleanup fails', async () => {
    const scratchPath = await mkdtemp(join(tmpdir(), 'yucp-ingest-cleanup-'));
    scratchPaths.add(scratchPath);
    const uploadDir = join(scratchPath, 'uploads');
    let uploadDataPath: string | undefined;
    const { catalog, rows } = createMemoryCatalog({
      async onTransition(row) {
        if (row.state === 'ASSEMBLED' && uploadDataPath) {
          await rm(uploadDataPath);
        }
      },
    });
    const server = createServer(
      createIngestTusServer({
        catalog,
        commonStore: localCasStore(join(scratchPath, 'common')),
        metadataStore: localCasStore(join(scratchPath, 'metadata')),
        protectedStore: localCasStore(join(scratchPath, 'protected')),
        quarantineStorage: createMemoryQuarantineStorage(),
        scratchRoot: join(scratchPath, 'pipeline-scratch'),
        uploadDir,
        uploadHmacKey,
        catalogControlSharedSecret: 'security-catalog-control-test-secret-32-bytes',
      })
    );
    openServers.add(server);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address() as AddressInfo;
    const endpoint = `http://127.0.0.1:${port}${INGEST_TUS_PATH}`;
    const artifact = Buffer.from('opaque substance painter package');
    const capability = await signUploadCapability({
      creatorId: 'creator-cleanup',
      expiresAt: Date.now() + 60_000,
      key: uploadHmacKey,
      packageId: 'com.creator.cleanup',
      protectionPolicyId: 'supported-visual-assets-v2',
      version: '1.0.0',
      versionId: crypto.randomUUID(),
    });
    const capabilityHeaders = {
      'x-yucp-upload-creator-id': capability.creatorId,
      'x-yucp-upload-edition-id': capability.editionId,
      'x-yucp-upload-exp': capability.exp,
      'x-yucp-upload-package-id': encodeURIComponent(capability.packageId),
      'x-yucp-upload-protection-policy-id': capability.protectionPolicyId,
      'x-yucp-upload-sig': capability.sig,
      'x-yucp-upload-version': encodeURIComponent(capability.version),
      'x-yucp-upload-version-id': capability.versionId,
    };
    const creation = await fetch(endpoint, {
      method: 'POST',
      headers: {
        ...capabilityHeaders,
        'Tus-Resumable': '1.0.0',
        'Upload-Length': String(artifact.byteLength),
        'Upload-Metadata': uploadMetadata({
          filename: 'artifact.spp',
          packageId: capability.packageId,
          version: capability.version,
        }),
      },
    });
    const location = creation.headers.get('location');
    if (!location) {
      throw new Error('Tus creation did not return an upload location');
    }
    expect(location.startsWith(`${INGEST_TUS_PATH}/`)).toBe(true);
    uploadDataPath = join(uploadDir, new URL(location, endpoint).pathname.split('/').at(-1) ?? '');

    const completion = await fetch(new URL(location, endpoint), {
      method: 'PATCH',
      headers: {
        ...capabilityHeaders,
        'Content-Type': 'application/offset+octet-stream',
        'Tus-Resumable': '1.0.0',
        'Upload-Offset': '0',
      },
      body: artifact,
    });

    expect(completion.status).toBe(204);
    await waitForVersionState(rows, capability.versionId, 'ASSEMBLED');
    expect(rows.get(capability.versionId)?.error).toBeNull();
    console.log('INGEST_TUS_PATCH_NORMAL_RESULT completed=yes assembled=yes');
  });
});
