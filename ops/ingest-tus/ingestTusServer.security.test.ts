import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Catalog, type CatalogState } from '../catalog';
import { localCasStore } from '../storage-core/desyncCas';
import { signUploadCapability } from '../storage-core/uploadSigning';
import { createIngestTusServer, INGEST_TUS_PATH } from './ingestTusServer';

const uploadHmacKey = 'security-test-upload-hmac-key-32-bytes';

interface MemoryCatalogRow {
  attempts: number;
  catalog_product_id: string | null;
  canonical_sha256: string | null;
  cas_index_id: string | null;
  created_at: Date;
  error: string | null;
  format_tag: string | null;
  id: string;
  next_attempt_at: Date | null;
  package_id: string;
  state: CatalogState;
  updated_at: Date;
  version: string;
}

type SqlTag = {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<MemoryCatalogRow[]>;
  begin<T>(callback: (transaction: SqlTag) => Promise<T>): Promise<T>;
  json(value: unknown): unknown;
};

function createMemoryCatalog(
  options: { onTransition?: (row: MemoryCatalogRow) => Promise<void> } = {}
): { catalog: Catalog; rows: Map<string, MemoryCatalogRow> } {
  const rows = new Map<string, MemoryCatalogRow>();
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const statement = strings.join('?');
    if (statement.includes('INSERT INTO package_versions')) {
      const now = new Date();
      const row: MemoryCatalogRow = {
        id: String(values[0]),
        package_id: String(values[1]),
        version: String(values[2]),
        format_tag: null,
        canonical_sha256: null,
        cas_index_id: null,
        state: 'CREATED',
        error: null,
        attempts: 0,
        catalog_product_id: (values[3] as string | null) ?? null,
        next_attempt_at: null,
        created_at: now,
        updated_at: now,
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
      const row = rows.get(String(values[8]));
      if (!row) {
        return [];
      }
      row.state = values[0] as CatalogState;
      row.format_tag = values[1] as string | null;
      row.canonical_sha256 = values[2] as string | null;
      row.cas_index_id = values[3] as string | null;
      row.error = values[4] as string | null;
      row.attempts = Number(values[5]);
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

describe('ingest tus upload capability isolation', () => {
  it('rejects cross-package metadata before creating a catalog row', async () => {
    const scratchPath = await mkdtemp(join(tmpdir(), 'yucp-ingest-security-'));
    scratchPaths.add(scratchPath);
    const { catalog, rows } = createMemoryCatalog();
    const server = createServer(
      createIngestTusServer({
        catalog,
        indexDir: join(scratchPath, 'indexes'),
        store: localCasStore(join(scratchPath, 'cas')),
        uploadDir: join(scratchPath, 'uploads'),
        uploadHmacKey,
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
      expiresAt: Date.now() + 60_000,
      key: uploadHmacKey,
      packageId: signedPackageId,
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
        'x-yucp-upload-exp': capability.exp,
        'x-yucp-upload-package-id': encodeURIComponent(signedPackageId),
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
        'x-yucp-upload-exp': capability.exp,
        'x-yucp-upload-package-id': encodeURIComponent(signedPackageId),
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
          'x-yucp-upload-exp': capability.exp,
          'x-yucp-upload-package-id': encodeURIComponent(signedPackageId),
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
        indexDir: join(scratchPath, 'indexes'),
        store: localCasStore(join(scratchPath, 'cas')),
        uploadDir,
        uploadHmacKey,
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
      expiresAt: Date.now() + 60_000,
      key: uploadHmacKey,
      packageId: 'com.creator.cleanup',
      version: '1.0.0',
      versionId: crypto.randomUUID(),
    });
    const capabilityHeaders = {
      'x-yucp-upload-exp': capability.exp,
      'x-yucp-upload-package-id': encodeURIComponent(capability.packageId),
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
    expect(rows.get(capability.versionId)?.state).toBe('ASSEMBLED');
    expect(rows.get(capability.versionId)?.error).toBeNull();
  });
});
