import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Catalog, CatalogOwnershipLostError } from '../catalog';
import { assembleVersion } from './ingestPipeline';

describe('ingest pipeline ownership loss', () => {
  let scratchPath: string | undefined;

  afterEach(async () => {
    if (scratchPath) {
      await rm(scratchPath, { force: true, recursive: true });
      scratchPath = undefined;
    }
  });

  it('does not start assembly side effects for an aborted ownership signal', async () => {
    scratchPath = await mkdtemp(join(tmpdir(), 'yucp-ingest-abort-test-'));
    const storePath = join(scratchPath, 'store');
    const indexDir = join(scratchPath, 'indexes');
    let catalogCallCount = 0;
    const sql = Object.assign(
      async () => {
        catalogCallCount += 1;
        return [];
      },
      {
        begin: async <T>(callback: (transaction: unknown) => Promise<T>) => callback(sql),
        json: (value: unknown) => value,
      }
    );
    const controller = new AbortController();
    const ownershipLost = new CatalogOwnershipLostError('version-aborted', 'UPLOADING');
    controller.abort(ownershipLost);

    await expect(
      assembleVersion(
        {
          catalog: new Catalog(sql as never),
          indexDir,
          inputPath: join(scratchPath, 'artifact.zip'),
          storePath,
          versionId: 'version-aborted',
        },
        controller.signal
      )
    ).rejects.toBe(ownershipLost);
    expect(catalogCallCount).toBe(0);
    expect(await readdir(scratchPath)).toEqual([]);
  });
});
