import { describe, expect, it } from 'bun:test';
import type { Catalog, PackageVersion } from '../catalog';
import { beginVersion } from './ingestPipeline';

type StubCatalogState = PackageVersion['state'];

function stubVersion(state: StubCatalogState): PackageVersion {
  return {
    catalogProductId: 'product-1',
    editionId: 'standard',
    id: 'version-1',
    packageId: 'package-1',
    state,
    version: '1.0.0',
  } as PackageVersion;
}

function stubCatalog(existingState: StubCatalogState) {
  const transitions: StubCatalogState[] = [];
  const catalog = {
    createVersion: async () => stubVersion(existingState),
    transition: async (_id: string, target: StubCatalogState) => {
      transitions.push(target);
      return stubVersion(target);
    },
    markFailed: async () => stubVersion('FAILED'),
  } as unknown as Catalog;

  return { catalog, transitions };
}

const beginInput = {
  catalogProductId: 'product-1',
  editionId: 'standard',
  packageId: 'package-1',
  version: '1.0.0',
  versionId: 'version-1',
};

describe('beginVersion retry semantics', () => {
  it('restarts an upload for a version whose previous attempt failed', async () => {
    const { catalog, transitions } = stubCatalog('FAILED');

    const result = await beginVersion({ ...beginInput, catalog });

    expect(transitions).toEqual(['UPLOADING']);
    expect(result.state).toBe('UPLOADING');
  });

  it('starts an upload for a freshly created version', async () => {
    const { catalog, transitions } = stubCatalog('CREATED');

    const result = await beginVersion({ ...beginInput, catalog });

    expect(transitions).toEqual(['UPLOADING']);
    expect(result.state).toBe('UPLOADING');
  });

  it('returns an already-uploading version without transitioning again', async () => {
    const { catalog, transitions } = stubCatalog('UPLOADING');

    const result = await beginVersion({ ...beginInput, catalog });

    expect(transitions).toEqual([]);
    expect(result.state).toBe('UPLOADING');
  });

  it.each([
    'ASSEMBLED',
    'PROMOTING',
    'READY',
    'DELETED',
  ] as const)('keeps %s immutable so a completed version cannot be overwritten', async (state) => {
    const { catalog, transitions } = stubCatalog(state);

    await expect(beginVersion({ ...beginInput, catalog })).rejects.toThrow(
      'Package version is immutable after upload completion'
    );
    expect(transitions).toEqual([]);
  });
});
