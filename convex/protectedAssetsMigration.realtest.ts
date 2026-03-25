import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { internal } from './_generated/api';
import schema from './schema';

declare global {
  interface ImportMeta {
    glob(pattern: string): Record<string, () => Promise<unknown>>;
  }
}

describe('protected asset legacy migration', () => {
  it('treats legacy protected assets without unlockMode as wrapped content keys', async () => {
    const t = convexTest(schema, import.meta.glob('./**/*.ts'));

    await t.run(async (ctx) => {
      await ctx.db.insert('protected_assets', {
        packageId: 'pkg-legacy-1',
        protectedAssetId: '46c90a22a12b44fe88fcd9be626bdedb',
        wrappedContentKey: 'wrapped-key-b64',
        displayName: 'Legacy protected asset',
        contentHash: 'a06c6bb6a5e981740a2658cc5ae99d23fd1dd424ed70120cd0428c6c34bffd1b',
        packageVersion: '1.0.0',
        publisherId: 'publisher-1',
        yucpUserId: 'user-1',
        certNonce: 'nonce-1',
        registeredAt: 1,
        updatedAt: 1,
      });
    });

    const asset = await t.query(internal.yucpLicenses.getProtectedAsset, {
      packageId: 'pkg-legacy-1',
      protectedAssetId: '46c90a22a12b44fe88fcd9be626bdedb',
    });

    expect(asset).toMatchObject({
      unlockMode: 'wrapped_content_key',
      wrappedContentKey: 'wrapped-key-b64',
      yucpUserId: 'user-1',
    });
  });

  it('backfills missing unlockMode on legacy protected assets', async () => {
    const t = convexTest(schema, import.meta.glob('./**/*.ts'));

    const id = await t.run(async (ctx) => {
      return await ctx.db.insert('protected_assets', {
        packageId: 'pkg-legacy-2',
        protectedAssetId: '56c90a22a12b44fe88fcd9be626bdedb',
        wrappedContentKey: 'wrapped-key-b64-2',
        displayName: 'Legacy protected asset 2',
        contentHash: 'b06c6bb6a5e981740a2658cc5ae99d23fd1dd424ed70120cd0428c6c34bffd1b',
        packageVersion: '1.0.1',
        publisherId: 'publisher-2',
        yucpUserId: 'user-2',
        certNonce: 'nonce-2',
        registeredAt: 2,
        updatedAt: 2,
      });
    });

    const result = await t.mutation(internal.migrations.backfillProtectedAssetUnlockModes, {});
    expect(result).toMatchObject({ updated: 1 });

    const stored = await t.run(async (ctx) => ctx.db.get(id));
    expect(stored?.unlockMode).toBe('wrapped_content_key');
  });
});
