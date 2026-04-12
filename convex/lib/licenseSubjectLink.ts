import type { MutationCtx } from '../_generated/server';

export type LicenseSubjectLinkInput = {
  authUserId: string;
  licenseSubject: string;
  packageId?: string;
  provider: string;
  licenseKey?: string;
  licenseKeyEncrypted?: string;
  purchaserEmail?: string;
  providerUserId?: string;
  externalOrderId?: string;
  providerProductId?: string;
};

export async function upsertLicenseSubjectLink(
  ctx: Pick<MutationCtx, 'db'>,
  input: LicenseSubjectLinkInput
) {
  const existing = await ctx.db
    .query('license_subject_links')
    .withIndex('by_auth_user_subject', (q) =>
      q.eq('authUserId', input.authUserId).eq('licenseSubject', input.licenseSubject)
    )
    .first();

  if (existing) {
    await ctx.db.patch(existing._id, {
      packageId: input.packageId ?? existing.packageId,
      provider: input.provider,
      licenseKey: input.licenseKey ?? existing.licenseKey,
      licenseKeyEncrypted: input.licenseKeyEncrypted ?? existing.licenseKeyEncrypted,
      purchaserEmail: input.purchaserEmail ?? existing.purchaserEmail,
      providerUserId: input.providerUserId ?? existing.providerUserId,
      externalOrderId: input.externalOrderId ?? existing.externalOrderId,
      providerProductId: input.providerProductId ?? existing.providerProductId,
    });
    return existing._id;
  }

  return await ctx.db.insert('license_subject_links', {
    licenseSubject: input.licenseSubject,
    authUserId: input.authUserId,
    packageId: input.packageId,
    provider: input.provider,
    licenseKey: input.licenseKey,
    licenseKeyEncrypted: input.licenseKeyEncrypted,
    purchaserEmail: input.purchaserEmail,
    providerUserId: input.providerUserId,
    externalOrderId: input.externalOrderId,
    providerProductId: input.providerProductId,
    createdAt: Date.now(),
  });
}
