import { describe, expect, it } from 'vitest';
import { internal } from './_generated/api';
import { makeTestConvex } from './testHelpers';

describe('protected asset registration bounds', () => {
  it('rejects oversized protected asset batches', async () => {
    const t = makeTestConvex();

    await expect(
      t.mutation(internal.yucpLicenses.upsertProtectedAssets, {
        packageId: 'pkg.protected.bounds',
        contentHash: 'a'.repeat(64),
        packageVersion: '1.0.0',
        publisherId: 'publisher-bounds',
        yucpUserId: 'auth-protected-bounds',
        certNonce: 'cert-bounds',
        protectedAssets: Array.from({ length: 101 }, (_, index) => ({
          protectedAssetId: index.toString(16).padStart(32, '0'),
          unlockMode: 'wrapped_content_key' as const,
          wrappedContentKey: `wrapped-key-${index}`,
        })),
      })
    ).rejects.toThrow('Maximum of 100 protected assets per request');
  });
});
