import { beforeEach, describe, expect, it } from 'vitest';
import { internal } from './_generated/api';
import { buildCreatorProfileWorkspaceKey } from './lib/certificateBillingConfig';
import { unsealProtectedMaterializationGrant } from './lib/protectedMaterializationGrant';
import { buildPublicAuthIssuer } from './lib/publicAuthIssuer';
import { getPublicKeyFromPrivate, signLicenseJwt, verifyProtectedUnlockJwt } from './lib/yucpCrypto';
import { makeTestConvex, seedCertificateBillingCatalog } from './testHelpers';

describe('protected materialization grant issuance', () => {
  const issuerBaseUrl = 'https://protected-grant.test.example';
  const packageId = 'pkg-protected-grant';
  const packageVersion = '1.0.0';
  const contentHash = 'c'.repeat(64);
  const protectedAssetId = '46c90a22a12b44fe88fcd9be626bdedb';
  const machineFingerprint =
    'a604eb0948054b9acb9f40da80a6a4c8e711b98c59e54a11089fea3a2b77dc1c';
  const projectId = '0123456789abcdef0123456789abcdef';
  const creatorAuthUserId = 'auth-protected-grant';
  const publisherId = 'publisher-protected-grant';
  const certNonce = 'cert-protected-grant';
  const couplingRuntimeVersion = '2026.03.26.1';
  const couplingRuntimePlaintextSha256 = 'b'.repeat(64);
  const contentKeyBase64 = Buffer.from('protected-grant-content-key').toString('base64');

  let rootPrivateKey = '';
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    rootPrivateKey = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');
    process.env.YUCP_ROOT_PRIVATE_KEY = rootPrivateKey;
    process.env.YUCP_ROOT_PUBLIC_KEY = await getPublicKeyFromPrivate(rootPrivateKey);
    process.env.YUCP_ROOT_KEY_ID = 'yucp-root';
    process.env.ENCRYPTION_SECRET = 'test-encryption-secret-for-protected-materialization-grant';
    process.env.POLAR_ACCESS_TOKEN = 'test-polar-access-token';
    process.env.POLAR_WEBHOOK_SECRET = 'test-polar-webhook-secret';
    process.env.YUCP_COUPLING_SERVICE_BASE_URL = 'https://coupling.internal';
    process.env.YUCP_COUPLING_SERVICE_SHARED_SECRET = 'coupling-secret';
    globalThis.fetch = originalFetch;
  });

  async function seedPackageRegistration(t: ReturnType<typeof makeTestConvex>) {
    await t.run(async (ctx) => {
      await ctx.db.insert('package_registry', {
        packageId,
        publisherId,
        yucpUserId: creatorAuthUserId,
        registeredAt: Date.now(),
        updatedAt: Date.now(),
      });
    });
  }

  async function seedActiveCouplingBilling(t: ReturnType<typeof makeTestConvex>) {
    const now = Date.now();
    await seedCertificateBillingCatalog(t, {
      productId: 'cd93ea04-eccf-4cec-a72e-aecf7d8f8f47',
      slug: 'creator-cert',
      displayName: 'Creator Suite+',
      description: 'Test plan',
      highlights: ['Test'],
      benefitMetadata: {
        protected_exports: true,
        coupling_traceability: true,
        device_cap: 3,
        audit_retention_days: 30,
        support_tier: 'standard',
        tier_rank: 1,
      },
      featureFlags: {
        protected_exports: true,
        coupling_traceability: true,
      },
      capabilityKeys: ['coupling_traceability', 'protected_exports'],
      capabilityKey: 'coupling_traceability',
      deviceCap: 3,
      auditRetentionDays: 30,
      supportTier: 'standard',
      tierRank: 1,
    });
    const creatorProfileId = await t.run(async (ctx) => {
      return await ctx.db.insert('creator_profiles', {
        authUserId: creatorAuthUserId,
        name: 'Protected Grant Creator',
        ownerDiscordUserId: 'discord-protected-grant',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
    });

    await t.run(async (ctx) => {
      await ctx.db.insert('creator_billing_entitlements', {
        workspaceKey: buildCreatorProfileWorkspaceKey(creatorProfileId),
        authUserId: creatorAuthUserId,
        creatorProfileId,
        planKey: 'creator-cert',
        status: 'active',
        allowEnrollment: true,
        allowSigning: true,
        deviceCap: 3,
        auditRetentionDays: 30,
        supportTier: 'standard',
        currentPeriodEnd: now + 86_400_000,
        graceUntil: now + 3 * 86_400_000,
        createdAt: now,
        updatedAt: now,
      });
    });
  }

  async function seedProtectedAsset(t: ReturnType<typeof makeTestConvex>) {
    await t.mutation(internal.yucpLicenses.upsertProtectedAssets, {
      packageId,
      contentHash,
      packageVersion,
      publisherId,
      yucpUserId: creatorAuthUserId,
      certNonce,
      protectedAssets: [
        {
          protectedAssetId,
          unlockMode: 'content_key_b64',
          contentKeyBase64,
          contentHash,
          displayName: 'Protected Blob',
        },
      ],
    });
  }

  function mockRuntimeArtifact() {
    globalThis.fetch = (async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (
        url ===
        'https://coupling.internal/v1/runtime-artifacts/manifest?artifactKey=coupling-runtime'
      ) {
        return new Response(
          JSON.stringify({
            success: true,
            artifactKey: 'coupling-runtime',
            channel: 'stable',
            platform: 'win-x64',
            version: couplingRuntimeVersion,
            metadataVersion: 1,
            deliveryName: 'yucp-coupling.dll',
            contentType: 'application/octet-stream',
            envelopeCipher: 'none',
            envelopeIvBase64: '',
            ciphertextSha256: couplingRuntimePlaintextSha256,
            ciphertextSize: 3,
            plaintextSha256: couplingRuntimePlaintextSha256,
            plaintextSize: 3,
            downloadUrl: 'https://coupling.internal/v1/licenses/coupling-runtime',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;
  }

  async function mintLicenseToken() {
    const nowSeconds = Math.floor(Date.now() / 1000);
    return await signLicenseJwt(
      {
        iss: buildPublicAuthIssuer(issuerBaseUrl),
        aud: 'yucp-license-gate',
        sub: 'license-subject-protected-grant',
        jti: 'nonce-protected-grant',
        package_id: packageId,
        machine_fingerprint: machineFingerprint,
        provider: 'gumroad',
        iat: nowSeconds,
        exp: nowSeconds + 3600,
      },
      rootPrivateKey,
      'yucp-root'
    );
  }

  it('returns an opaque broker-oriented grant without exposing raw coupling outputs on the public surface', async () => {
    const t = makeTestConvex();
    await seedPackageRegistration(t);
    await seedProtectedAsset(t);
    await seedActiveCouplingBilling(t);
    mockRuntimeArtifact();
    const licenseToken = await mintLicenseToken();

    const result = await t.action(internal.yucpLicenses.issueProtectedMaterializationGrant, {
      packageId,
      protectedAssetId,
      machineFingerprint,
      projectId,
      licenseToken,
      assetPaths: ['Assets/Protected/Model.fbx'],
      issuerBaseUrl,
    });

    expect(result).toMatchObject({ success: true, expiresAt: expect.any(Number), grant: expect.any(String) });
    expect(result.grant).toBeTruthy();
    expect(result.grant).not.toContain(contentKeyBase64);

    const payload = await unsealProtectedMaterializationGrant(result.grant ?? '');
    expect(payload).toMatchObject({
      schemaVersion: 1,
      creatorAuthUserId,
      packageId,
      protectedAssetId,
      licenseSubject: 'license-subject-protected-grant',
      machineFingerprint,
      projectId,
      coupling: {
        subject: 'license-subject-protected-grant',
        jobs: [{ assetPath: 'Assets/Protected/Model.fbx' }],
      },
    });
    expect(payload.grantId).toBeTruthy();
    expect(payload.unlockToken).toBeTruthy();
    expect(payload.coupling.jobs).toHaveLength(1);
    expect(payload.coupling.jobs[0]?.tokenHex).toMatch(/^[0-9a-f]+$/);
    expect(result.grant).not.toContain(payload.coupling.jobs[0]?.tokenHex ?? '');
    expect(result.grant).not.toContain(payload.unlockToken);

    const issuedState = await t.run(async (ctx) => {
      return {
        traces: await (ctx.db as any).query('coupling_trace_records').collect(),
        auditEvents: await (ctx.db as any).query('audit_events').collect(),
      };
    });

    expect(issuedState.traces).toHaveLength(1);
    expect(issuedState.traces[0]).toMatchObject({
      authUserId: creatorAuthUserId,
      packageId,
      licenseSubject: 'license-subject-protected-grant',
      assetPath: 'Assets/Protected/Model.fbx',
      grantId: payload.grantId,
      grantIssuanceStatus: 'issued',
    });

    const grantIssuedEvents = issuedState.auditEvents.filter(
      (event: { eventType?: string; metadata?: { grantId?: string } }) =>
        event.eventType === 'protected.materialization.grant.issued' &&
        event.metadata?.grantId === payload.grantId
    );
    expect(grantIssuedEvents).toHaveLength(1);

    const claims = await verifyProtectedUnlockJwt(
      payload.unlockToken,
      process.env.YUCP_ROOT_PUBLIC_KEY!,
      buildPublicAuthIssuer(issuerBaseUrl)
    );

    expect(claims).toMatchObject({
      package_id: packageId,
      protected_asset_id: protectedAssetId,
      machine_fingerprint: machineFingerprint,
      project_id: projectId,
      unlock_mode: 'content_key_b64',
      content_hash: contentHash,
    });

    const redeemed = await t.action(internal.yucpLicenses.redeemProtectedMaterializationGrant, {
      grant: result.grant ?? '',
      issuerBaseUrl,
    });

    expect(redeemed).toMatchObject({
      success: true,
      creatorAuthUserId,
      packageId,
      protectedAssetId,
      machineFingerprint,
      projectId,
      licenseSubject: 'license-subject-protected-grant',
      contentKeyBase64,
      contentHash,
      couplingJobs: [{ assetPath: 'Assets/Protected/Model.fbx' }],
    });

    const redeemedState = await t.run(async (ctx) => {
      return {
        auditEvents: await (ctx.db as any).query('audit_events').collect(),
      };
    });

    const grantRedeemedEvents = redeemedState.auditEvents.filter(
      (event: { eventType?: string; metadata?: { grantId?: string } }) =>
        event.eventType === 'protected.materialization.grant.redeemed' &&
        event.metadata?.grantId === payload.grantId
    );
    expect(grantRedeemedEvents).toHaveLength(1);

    const receiptResult = await t.mutation(internal.yucpLicenses.receiptProtectedMaterializationGrant, {
      grant: result.grant ?? '',
    });

    expect(receiptResult).toMatchObject({
      success: true,
      updatedCount: 1,
    });

    const receiptedState = await t.run(async (ctx) => {
      return {
        traces: await (ctx.db as any).query('coupling_trace_records').collect(),
        auditEvents: await (ctx.db as any).query('audit_events').collect(),
      };
    });

    expect(receiptedState.traces[0]).toMatchObject({
      grantId: payload.grantId,
      grantIssuanceStatus: 'receipted',
      grantReceiptedAt: expect.any(Number),
    });

    const grantReceiptedEvents = receiptedState.auditEvents.filter(
      (event: { eventType?: string; metadata?: { grantId?: string } }) =>
        event.eventType === 'protected.materialization.grant.receipted' &&
        event.metadata?.grantId === payload.grantId
    );
    expect(grantReceiptedEvents).toHaveLength(1);
  });

  it('treats receipt as a no-op when no coupling traces were issued', async () => {
    const t = makeTestConvex();
    await seedPackageRegistration(t);
    await seedProtectedAsset(t);
    mockRuntimeArtifact();
    const licenseToken = await mintLicenseToken();

    const result = await t.action(internal.yucpLicenses.issueProtectedMaterializationGrant, {
      packageId,
      protectedAssetId,
      machineFingerprint,
      projectId,
      licenseToken,
      assetPaths: ['Assets/Protected/Model.fbx'],
      issuerBaseUrl,
    });

    expect(result).toMatchObject({ success: true, grant: expect.any(String), expiresAt: expect.any(Number) });

    const payload = await unsealProtectedMaterializationGrant(result.grant ?? '');
    expect(payload.coupling).toMatchObject({
      jobs: [],
      skipReason: 'capability_disabled',
    });

    const redeemed = await t.action(internal.yucpLicenses.redeemProtectedMaterializationGrant, {
      grant: result.grant ?? '',
      issuerBaseUrl,
    });

    expect(redeemed).toMatchObject({
      success: true,
      creatorAuthUserId,
      packageId,
      protectedAssetId,
      machineFingerprint,
      projectId,
      licenseSubject: 'license-subject-protected-grant',
      contentKeyBase64,
      contentHash,
      couplingJobs: [],
      skipReason: 'capability_disabled',
    });

    const receiptResult = await t.mutation(internal.yucpLicenses.receiptProtectedMaterializationGrant, {
      grant: result.grant ?? '',
    });

    expect(receiptResult).toMatchObject({
      success: true,
      updatedCount: 0,
    });
  });
});
