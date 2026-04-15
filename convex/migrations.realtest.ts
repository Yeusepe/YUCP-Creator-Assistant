import { beforeEach, describe, expect, it } from 'vitest';
import { internal } from './_generated/api';
import { makeTestConvex } from './testHelpers';

describe('legacy license subject link hardening', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_SECRET = 'test-encryption-secret-32-bytes!!';
  });

  it('encrypts plaintext license keys on new writes and drops redundant purchaser emails', async () => {
    const t = makeTestConvex();

    await t.mutation(internal.yucpLicenses.recordLicenseSubjectLink, {
      licenseSubject: 'a'.repeat(64),
      authUserId: 'auth-user-1',
      provider: 'gumroad',
      licenseKey: '11111111-2222-3333-4444-555555555555',
      purchaserEmail: 'buyer@example.com',
    });

    const stored = await t.run((ctx) =>
      ctx.db
        .query('license_subject_links')
        .withIndex('by_auth_user_subject', (q) =>
          q.eq('authUserId', 'auth-user-1').eq('licenseSubject', 'a'.repeat(64))
        )
        .first()
    );

    expect(stored?.licenseKey).toBeUndefined();
    expect(stored?.licenseKeyEncrypted).toBeTruthy();
    expect(stored?.purchaserEmail).toBeUndefined();
  });

  it('migrates legacy plaintext license subject links in place', async () => {
    const t = makeTestConvex();
    const now = Date.now();

    const docId = await t.run(async (ctx) => {
      return await ctx.db.insert('license_subject_links', {
        licenseSubject: 'b'.repeat(64),
        authUserId: 'auth-user-2',
        provider: 'jinxxy',
        licenseKey: '22222222-3333-4444-5555-666666666666',
        purchaserEmail: 'legacy@example.com',
        createdAt: now,
      });
    });

    const result = await t.mutation(internal.migrations.migrateLegacyLicenseSubjectLinks, {});

    expect(result.updated).toBe(1);

    const stored = await t.run(async (ctx) => ctx.db.get(docId));
    expect(stored?.licenseKey).toBeUndefined();
    expect(stored?.licenseKeyEncrypted).toBeTruthy();
    expect(stored?.purchaserEmail).toBeUndefined();
  });
});
