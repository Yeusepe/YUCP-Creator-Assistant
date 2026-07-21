import { describe, expect, test } from 'bun:test';
import { api, internal } from '../../../../convex/_generated/api';
import { buildCreatorProfileWorkspaceKey } from '../../../../convex/lib/certificateBillingConfig';
import { API_SECRET } from '../../../../ops/convex-real/config';
import { verifyUploadCapability } from '../../../../ops/storage-core/uploadSigning';
import {
  createBetterAuthSession,
  createBetterAuthUser,
  E2E_INGEST_TUS_URL,
  E2E_UPLOAD_HMAC_KEY,
  getRealApiHarness,
  installRealApiHarness,
  seedCreatorProfile,
} from './support/realApiHarness';

installRealApiHarness();

const VPM_REPO_PRODUCT_ID = 'prod_e2e_vpm_repo';
const VPM_REPO_BENEFIT_ID = 'benefit_e2e_vpm_repo';

async function createCreatorWithUploadCapability(name: string) {
  const harness = getRealApiHarness();
  const creator = await createBetterAuthUser({ name });
  const creatorProfileId = await seedCreatorProfile({
    authUserId: creator.authUserId,
    name,
  });
  const workspaceKey = buildCreatorProfileWorkspaceKey(creatorProfileId);
  const now = Date.now();

  await harness.convex.insert('creator_billing_catalog_products', {
    productId: VPM_REPO_PRODUCT_ID,
    slug: 'e2e-vpm-repo',
    displayName: 'E2E VPM Repository',
    description: 'Real-backend upload authorization fixture',
    status: 'active',
    sortOrder: 1,
    recurringInterval: 'month',
    recurringPriceIds: ['price_e2e_vpm_repo_monthly'],
    meteredPrices: [],
    benefitIds: [VPM_REPO_BENEFIT_ID],
    highlights: ['VPM repository uploads'],
    metadata: { yucp_domain: 'certificate_billing' },
    syncedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  await harness.convex.insert('creator_billing_catalog_benefits', {
    benefitId: VPM_REPO_BENEFIT_ID,
    type: 'feature_flag',
    description: 'VPM repository capability',
    metadata: { vpm_repo: true },
    featureFlags: { vpm_repo: true },
    capabilityKeys: ['vpm_repo'],
    capabilityKey: 'vpm_repo',
    deviceCap: 1,
    auditRetentionDays: 30,
    supportTier: 'standard',
    tierRank: 1,
    syncedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  await harness.convex.insert('creator_billing_entitlements', {
    workspaceKey,
    authUserId: creator.authUserId,
    creatorProfileId,
    planKey: 'e2e-vpm-repo',
    productId: VPM_REPO_PRODUCT_ID,
    status: 'active',
    allowEnrollment: true,
    allowSigning: true,
    deviceCap: 1,
    auditRetentionDays: 30,
    supportTier: 'standard',
    currentPeriodEnd: now + 86_400_000,
    createdAt: now,
    updatedAt: now,
  });

  const overview = await harness.convex.query<{
    billing: { capabilities: Array<{ capabilityKey: string; status: string }> };
  }>(api.certificateBilling.getAccountOverview, {
    apiSecret: API_SECRET,
    authUserId: creator.authUserId,
  });
  expect(overview.billing.capabilities).toContainEqual({
    capabilityKey: 'vpm_repo',
    status: 'active',
  });

  return {
    ...creator,
    sessionToken: await createBetterAuthSession(creator.authUserId),
  };
}

async function authorizeUpload(input: {
  packageId: string;
  sessionToken: string;
  version: string;
}): Promise<Response> {
  return await getRealApiHarness().app.fetch('/api/creator/uploads/authorize', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: `yucp.session_token=${input.sessionToken}`,
      origin: 'http://127.0.0.1:3001',
    },
    body: JSON.stringify({ packageId: input.packageId, version: input.version }),
  });
}

async function expectValidUploadAuthorization(
  response: Response,
  input: { packageId: string; version: string }
): Promise<void> {
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    exp: string;
    headers: Record<string, string>;
    sig: string;
    tusEndpoint: string;
    versionId: string;
  };
  expect(body.versionId).toMatch(/^[0-9a-f-]{36}$/);
  expect(body.tusEndpoint).toBe(`${E2E_INGEST_TUS_URL}/files`);
  expect(body.headers).toEqual({
    'x-yucp-upload-exp': body.exp,
    'x-yucp-upload-package-id': input.packageId,
    'x-yucp-upload-sig': body.sig,
    'x-yucp-upload-version': input.version,
    'x-yucp-upload-version-id': body.versionId,
  });
  expect(
    await verifyUploadCapability(
      {
        exp: body.exp,
        packageId: input.packageId,
        sig: body.sig,
        version: input.version,
        versionId: body.versionId,
      },
      E2E_UPLOAD_HMAC_KEY
    )
  ).toBe(true);
}

describe('real creator upload authorization route', () => {
  test('authorizes the first upload from an empty package registration state', async () => {
    const harness = getRealApiHarness();
    const creator = await createCreatorWithUploadCapability('First Upload Creator');
    const packageId = 'com.yucp.e2e-first-upload';

    expect(await harness.convex.collect('package_registry')).toHaveLength(0);

    const response = await authorizeUpload({
      packageId,
      sessionToken: creator.sessionToken,
      version: '1.0.0',
    });

    await expectValidUploadAuthorization(response, { packageId, version: '1.0.0' });
    expect(await harness.convex.collect('package_registry')).toHaveLength(0);
  });

  test('rejects an upload when another creator owns the package namespace', async () => {
    const harness = getRealApiHarness();
    const creator = await createCreatorWithUploadCapability('Conflicting Upload Creator');
    const owner = await createBetterAuthUser({ name: 'Existing Package Owner' });
    const packageId = 'com.yucp.e2e-cross-owner';

    await harness.convex.mutation(internal.packageRegistry.registerPackage, {
      packageId,
      packageName: 'Cross-owner package',
      publisherId: 'publisher-existing-owner',
      yucpUserId: owner.authUserId,
    });

    const response = await authorizeUpload({
      packageId,
      sessionToken: creator.sessionToken,
      version: '1.0.0',
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: 'Package namespace owned by another creator',
    });
  });

  test('authorizes another upload when the creator owns the active registration', async () => {
    const harness = getRealApiHarness();
    const creator = await createCreatorWithUploadCapability('Repeat Upload Creator');
    const packageId = 'com.yucp.e2e-repeat-upload';

    await harness.convex.mutation(internal.packageRegistry.registerPackage, {
      packageId,
      packageName: 'Repeat upload package',
      publisherId: 'publisher-repeat-owner',
      yucpUserId: creator.authUserId,
    });

    const response = await authorizeUpload({
      packageId,
      sessionToken: creator.sessionToken,
      version: '1.1.0',
    });

    await expectValidUploadAuthorization(response, { packageId, version: '1.1.0' });
  });
});
