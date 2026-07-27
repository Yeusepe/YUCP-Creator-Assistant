import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Catalog, CatalogOwnershipLostError } from '../catalog';
import { localCasStore } from '../storage-core/desyncCas';
import { ACTIVE_PROTECTION_POLICY_ID } from '../storage-core/protectionPolicyId';
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
          commonStore: localCasStore(join(scratchPath, 'common')),
          creatorId: 'creator-aborted',
          inputPath: join(scratchPath, 'artifact.zip'),
          metadataStore: localCasStore(join(scratchPath, 'metadata')),
          protectedStore: localCasStore(join(scratchPath, 'protected')),
          protectionPolicyId: ACTIVE_PROTECTION_POLICY_ID,
          scratchRoot: scratchPath,
          versionId: 'version-aborted',
        },
        controller.signal
      )
    ).rejects.toBe(ownershipLost);
    expect(catalogCallCount).toBe(0);
    expect(await readdir(scratchPath)).toEqual([]);
  });
});
