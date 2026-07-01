import { writeFileSync } from 'node:fs';
import { setPinnedYucpRootsForTests } from '@yucp/shared/yucpTrust';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { api, internal } from './_generated/api';
import { buildCreatorProfileWorkspaceKey } from './lib/certificateBillingConfig';
import { buildPublicAuthIssuer } from './lib/publicAuthIssuer';
import * as yucpCrypto from './lib/yucpCrypto';
import {
  makeTestConvex,
  seedCertificateBillingCatalog,
  seedCreatorProfile,
  seedSubject,
} from './testHelpers';

// Cross-layer attribution e2e, convex leg: runs the real issueCouplingJob, then resolves the trace
// back to a buyer identity, and emits the minted token/seed/candidate to E2E_OUT_JSON for the Bun leg.
const issuerBaseUrl = 'https://coupling-e2e.test.example';
const packageId = 'pkg.coupling.e2e';
const publisherId = 'publisher-coupling-e2e';
const creatorAuthUserId = 'auth-coupling-e2e-creator';
const machineFingerprint = 'a604eb0948054b9acb9f40da80a6a4c8e711b98c59e54a11089fea3a2b77dc1c';
const projectId = '0123456789abcdef0123456789abcdef';
const licenseSubject = 'f'.repeat(64);
const assetPath = 'Assets/Character/body.png';
const provider = 'jinxxy';
const runtimeVersion = '2026.03.27.1';
const runtimePlaintextSha256 = 'b'.repeat(64);

const SEED_HEX = (process.env.E2E_SEED_HEX ?? '7'.repeat(64)).toLowerCase();
const OUT_JSON = process.env.E2E_OUT_JSON ?? '';

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Buffer.from(new Uint8Array(digest)).toString('hex');
}

describe('coupling attribution cross-layer e2e (convex leg)', () => {
  let rootPrivateKey = '';
  let originalFetch: typeof fetch;

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    process.env.CONVEX_API_SECRET = 'test-secret';
    process.env.ENCRYPTION_SECRET = 'test-encryption-secret-for-coupling-e2e-flow';
    process.env.API_BASE_URL = issuerBaseUrl;
    rootPrivateKey = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');
    process.env.YUCP_ROOT_PRIVATE_KEY = rootPrivateKey;
    const rootPublicKey = await yucpCrypto.getPublicKeyFromPrivate(rootPrivateKey);
    process.env.YUCP_ROOT_PUBLIC_KEY = rootPublicKey;
    process.env.YUCP_ROOT_KEY_ID = 'yucp-root';
    setPinnedYucpRootsForTests([
      { keyId: 'yucp-root', algorithm: 'Ed25519', publicKeyBase64: rootPublicKey },
    ]);

    process.env.YUCP_COUPLING_SERVICE_BASE_URL = 'https://coupling-service.test';
    process.env.COUPLING_SERVICE_SECRET = 'test-coupling-relay-token';
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://coupling-service.test/v1/coupling/internal/derive-seeds');
      const body = JSON.parse(String(init?.body ?? '{}')) as { assetPaths?: string[] };
      return new Response(
        JSON.stringify({ seeds: (body.assetPaths ?? []).map((p) => ({ assetPath: p, seedHex: SEED_HEX })) }),
        { status: 200 }
      );
    }) as typeof fetch;
  });

  afterEach(() => {
    setPinnedYucpRootsForTests(null);
    globalThis.fetch = originalFetch;
  });

  async function mintLicenseToken() {
    const nowSeconds = Math.floor(Date.now() / 1000);
    return await yucpCrypto.signLicenseJwt(
      {
        iss: buildPublicAuthIssuer(issuerBaseUrl),
        aud: 'yucp-license-gate',
        sub: licenseSubject,
        jti: `nonce-${nowSeconds}-${crypto.getRandomValues(new Uint32Array(1))[0]}`,
        package_id: packageId,
        machine_fingerprint: machineFingerprint,
        provider,
        iat: nowSeconds,
        exp: nowSeconds + 3600,
      },
      rootPrivateKey,
      'yucp-root'
    );
  }

  it('issues a real coupling job, retrieves the candidate, and resolves the buyer identity', async () => {
    const t = makeTestConvex();
    const now = Date.now();

    await seedCertificateBillingCatalog(t, {
      productId: 'plan-coupling-traceability',
      capabilityKeys: ['coupling_traceability'],
      capabilityKey: 'coupling_traceability',
      featureFlags: { coupling_traceability: true },
      benefitMetadata: { coupling_traceability: true },
    });
    const creatorProfileId = await seedCreatorProfile(t, {
      authUserId: creatorAuthUserId,
      ownerDiscordUserId: 'discord-creator-e2e',
    });
    const buyerSubjectId = await seedSubject(t, {
      authUserId: 'buyer-auth-user-e2e',
      primaryDiscordUserId: 'discord-buyer-e2e',
      displayName: 'Buyer E2E',
    });

    await t.run(async (ctx) => {
      await ctx.db.insert('creator_billing_entitlements', {
        workspaceKey: buildCreatorProfileWorkspaceKey(creatorProfileId),
        authUserId: creatorAuthUserId,
        creatorProfileId,
        planKey: 'creator-suite-plus',
        productId: 'plan-coupling-traceability',
        status: 'active',
        allowEnrollment: true,
        allowSigning: true,
        deviceCap: 5,
        auditRetentionDays: 30,
        supportTier: 'standard',
        currentPeriodEnd: now + 86_400_000,
        graceUntil: now + 3 * 86_400_000,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert('package_registry', {
        packageId,
        packageName: 'Coupling E2E Bundle',
        publisherId,
        yucpUserId: creatorAuthUserId,
        status: 'active',
        registeredAt: now,
        updatedAt: now,
      });
      const storageId = await ctx.storage.store(new Blob([new Uint8Array([1, 2, 3, 4])]));
      await ctx.db.insert('signed_release_artifacts', {
        artifactKey: 'coupling-runtime',
        channel: 'stable',
        platform: 'win-x64',
        version: runtimeVersion,
        metadataVersion: 1,
        storageId,
        contentType: 'application/octet-stream',
        deliveryName: 'yucp_coupling.dll',
        envelopeCipher: 'aes-256-gcm',
        envelopeIvBase64: Buffer.from(new Uint8Array(12)).toString('base64'),
        ciphertextSha256: 'a'.repeat(64),
        ciphertextSize: 4,
        plaintextSha256: runtimePlaintextSha256,
        plaintextSize: 4,
        status: 'active',
        activatedAt: now,
        createdAt: now,
        updatedAt: now,
      });
      const externalAccountId = await ctx.db.insert('external_accounts', {
        provider,
        providerUserId: 'customer-e2e-123',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert('bindings', {
        authUserId: creatorAuthUserId,
        subjectId: buyerSubjectId,
        externalAccountId,
        bindingType: 'verification',
        status: 'active',
        createdBy: buyerSubjectId,
        reason: 'Manual license verification',
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert('license_subject_links', {
        licenseSubject,
        authUserId: creatorAuthUserId,
        packageId,
        provider,
        licenseKey: '11111111-2222-3333-4444-555555555555',
        purchaserEmail: 'buyer-e2e@example.com',
        providerUserId: 'customer-e2e-123',
        externalOrderId: 'order-e2e-123',
        providerProductId: 'product-e2e-123',
        createdAt: now,
      });
    });

    const licenseToken = await mintLicenseToken();
    const job = await t.action(internal.yucpLicenses.issueCouplingJob, {
      packageId,
      projectId,
      machineFingerprint,
      licenseToken,
      assetPaths: [assetPath],
      issuerBaseUrl,
    });
    expect(job.success).toBe(true);
    const file = job.files?.[0];
    expect(file).toBeTruthy();
    if (!file) throw new Error('coupling job returned no files');
    expect(file.assetPath).toBe(assetPath);
    expect(file.seedHex).toBe(SEED_HEX);
    expect(file.tokenHex).toMatch(/^[0-9a-f]{16}$/);
    const tokenHash = await sha256Hex(file.tokenHex);

    const candidateResult = await t.query(
      api.couplingForensics.listCouplingTraceCandidatesForAuthUser,
      { apiSecret: 'test-secret', authUserId: creatorAuthUserId, packageId }
    );
    expect(candidateResult.capabilityEnabled).toBe(true);
    expect(candidateResult.packageOwned).toBe(true);
    expect(candidateResult.candidates).toContainEqual({ assetPath, licenseSubject, tokenHash });

    const lookup = await t.query(api.couplingForensics.lookupTraceMatchesForAuthUser, {
      apiSecret: 'test-secret',
      authUserId: creatorAuthUserId,
      packageId,
      matchedCandidates: [{ assetPath, licenseSubject, tokenHash }],
    });
    expect(lookup.capabilityEnabled).toBe(true);
    expect(lookup.packageOwned).toBe(true);
    const match = lookup.matches.find((m: { tokenHash: string }) => m.tokenHash === tokenHash);
    expect(match).toBeTruthy();
    expect(match).toMatchObject({
      licenseSubject,
      provider,
      buyerProviderUserId: 'customer-e2e-123',
      buyerSubjectDisplayName: 'Buyer E2E',
      buyerSubjectDiscordUserId: 'discord-buyer-e2e',
    });

    if (OUT_JSON) {
      writeFileSync(
        OUT_JSON,
        JSON.stringify(
          {
            assetPath,
            licenseSubject,
            seedHex: file.seedHex,
            tokenHex: file.tokenHex,
            tokenHash,
            candidate: { assetPath, licenseSubject, tokenHash },
            buyer: {
              provider: match?.provider,
              buyerProviderUserId: match?.buyerProviderUserId,
              buyerSubjectDisplayName: match?.buyerSubjectDisplayName,
              buyerSubjectDiscordUserId: match?.buyerSubjectDiscordUserId,
            },
          },
          null,
          2
        ),
        'utf8'
      );
    }
  });
});
