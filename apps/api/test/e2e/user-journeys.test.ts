import { describe, expect, test } from 'bun:test';
import { api } from '../../../../convex/_generated/api';
import { API_SECRET } from '../../../../ops/convex-real/config';
import { PUBLIC_API_SCOPES } from '../../../../packages/shared/src/publicApiScopes';
import { createAuthUserActorBinding } from '../../src/lib/apiActor';
import {
  apiJson,
  apiKeyHeaders,
  createBetterAuthUser,
  createPublicApiKey,
  getRealApiHarness,
  hashLicenseKey,
  installRealApiHarness,
  seedProductCatalog,
  seedSubject,
} from './support/realApiHarness';

installRealApiHarness();

const RAW_LICENSE_KEY = crypto.randomUUID();
const PRODUCT_ID = 'prod_e2e_manual_1';

describe('real API user journeys against self-hosted Convex', () => {
  // [F20] Blocked on createApiKey ArgumentValidationError: apikey.userId required by convex/betterAuth/schema.ts:83, not supplied by @better-auth/api-key@1.6.13.
  test.failing('[F20] smoke reads a seeded API key through the real API router', async () => {
    const creator = await createBetterAuthUser({ name: 'Smoke Creator' });
    const apiKey = await createPublicApiKey(creator.authUserId, PUBLIC_API_SCOPES);

    const { body, response } = await apiJson<{
      authUserId: string;
      expiresAt: number | null;
      keyId: string | null;
      object: string;
      scopes: string[];
    }>('/api/public/v2/me', {
      headers: apiKeyHeaders(apiKey),
    });

    expect(response.status).toBe(200);
    expect(body).toEqual({
      object: 'api_key_info',
      authUserId: creator.authUserId,
      scopes: PUBLIC_API_SCOPES,
      keyId: expect.any(String),
      expiresAt: null,
    });
  });

  // [F20] Blocked on createApiKey ArgumentValidationError: apikey.userId required by convex/betterAuth/schema.ts:83, not supplied by @better-auth/api-key@1.6.13.
  test.failing('[F20] manual-license issue and validate round-trips through raw key HMAC storage', async () => {
    const creator = await createBetterAuthUser({ name: 'Manual License Creator' });
    const apiKey = await createPublicApiKey(creator.authUserId, PUBLIC_API_SCOPES);

    const issued = await apiJson<{ licenseId: string }>('/api/public/v2/manual-licenses', {
      method: 'POST',
      headers: apiKeyHeaders(apiKey),
      body: JSON.stringify({ key: RAW_LICENSE_KEY, product_id: PRODUCT_ID }),
    });

    expect(issued.response.status).toBe(201);
    expect(issued.body.licenseId).toStartWith('j');

    const licenses = await getRealApiHarness().convex.collect('manual_licenses');
    expect(licenses).toHaveLength(1);
    const [license] = licenses;
    expect(String(license._id)).toBe(issued.body.licenseId);
    expect(license.authUserId).toBe(creator.authUserId);
    expect(license.productId).toBe(PRODUCT_ID);
    expect(license.status).toBe('active');
    expect(license.licenseKeyHash).toBe(await hashLicenseKey(RAW_LICENSE_KEY));
    expect(JSON.stringify(license)).not.toContain(RAW_LICENSE_KEY);

    const valid = await apiJson<{
      licenseId?: string;
      reason?: string;
      valid: boolean;
    }>('/api/public/v2/manual-licenses/validate', {
      method: 'POST',
      headers: apiKeyHeaders(apiKey),
      body: JSON.stringify({ key: RAW_LICENSE_KEY, product_id: PRODUCT_ID }),
    });

    expect(valid.response.status).toBe(200);
    expect(valid.body).toMatchObject({
      valid: true,
      licenseId: issued.body.licenseId,
    });

    const invalid = await apiJson<{ reason?: string; valid: boolean }>(
      '/api/public/v2/manual-licenses/validate',
      {
        method: 'POST',
        headers: apiKeyHeaders(apiKey),
        body: JSON.stringify({ key: crypto.randomUUID(), product_id: PRODUCT_ID }),
      }
    );

    expect(invalid.response.status).toBe(200);
    expect(invalid.body).toEqual({ valid: false, reason: 'not_found' });
  });

  test('manual-license reachable layer stores only HMAC and validates by hash', async () => {
    const creator = await createBetterAuthUser({ name: 'Manual License Convex Creator' });
    const actor = await createAuthUserActorBinding({
      authUserId: creator.authUserId,
      source: 'api_key',
      scopes: PUBLIC_API_SCOPES,
    });
    const licenseKeyHash = await hashLicenseKey(RAW_LICENSE_KEY);

    const created = await getRealApiHarness().convex.mutation<{ licenseId: string }>(
      api.manualLicenses.create,
      {
        apiSecret: API_SECRET,
        actor,
        authUserId: creator.authUserId,
        licenseKeyHash,
        productId: PRODUCT_ID,
      }
    );

    const licenses = await getRealApiHarness().convex.collect('manual_licenses');
    expect(licenses).toHaveLength(1);
    const [license] = licenses;
    expect(String(license._id)).toBe(created.licenseId);
    expect(license.licenseKeyHash).toBe(licenseKeyHash);
    expect(JSON.stringify(license)).not.toContain(RAW_LICENSE_KEY);

    const valid = await getRealApiHarness().convex.query<{
      licenseId?: string;
      valid: boolean;
    }>(api.manualLicenses.validateByHash, {
      apiSecret: API_SECRET,
      actor,
      authUserId: creator.authUserId,
      licenseKeyHash,
      productId: PRODUCT_ID,
    });
    expect(valid).toMatchObject({ valid: true, licenseId: created.licenseId });
  });

  // [F21] verifyIntentWithManualLicense -> internal.yucpLicenses.verifyLicenseProof returns invalid_proof, no entitlement minted.
  test.failing('[F21] public-v2 manual license redeem should mint an active entitlement', async () => {
    const creator = await createBetterAuthUser({ name: 'Manual Redeem Creator' });
    const buyer = await createBetterAuthUser({ name: 'Manual Redeem Buyer' });
    const subjectId = await seedSubject(buyer.authUserId);

    await getRealApiHarness().convex.mutation(api.manualLicenses.create, {
      apiSecret: API_SECRET,
      actor: await createAuthUserActorBinding({
        authUserId: creator.authUserId,
        source: 'api_key',
        scopes: PUBLIC_API_SCOPES,
      }),
      authUserId: creator.authUserId,
      licenseKeyHash: await hashLicenseKey(RAW_LICENSE_KEY),
      productId: PRODUCT_ID,
    });
    await seedProductCatalog({
      authUserId: creator.authUserId,
      productId: PRODUCT_ID,
      provider: 'manual',
      providerProductRef: PRODUCT_ID,
    });

    const intent = await getRealApiHarness().convex.mutation<{ intentId: string }>(
      api.verificationIntents.createVerificationIntent,
      {
        apiSecret: API_SECRET,
        authUserId: buyer.authUserId,
        packageId: 'com.yucp.e2e.manual',
        packageName: 'Manual License E2E',
        machineFingerprint: 'machine-e2e-manual',
        codeChallenge: 'challenge-e2e-manual',
        returnUrl: 'http://127.0.0.1:3000/verify/return',
        requirements: [
          {
            methodKey: 'manual-license',
            providerKey: 'manual',
            kind: 'manual_license',
            title: 'Manual license',
            creatorAuthUserId: creator.authUserId,
            productId: PRODUCT_ID,
            providerProductRef: PRODUCT_ID,
          },
        ],
      }
    );

    const result = await getRealApiHarness().convex.action<{ success: boolean }>(
      api.verificationIntents.verifyIntentWithManualLicense,
      {
        apiSecret: API_SECRET,
        authUserId: buyer.authUserId,
        intentId: intent.intentId,
        methodKey: 'manual-license',
        licenseKey: RAW_LICENSE_KEY,
      }
    );

    const entitlements = await getRealApiHarness().convex.collect('entitlements');
    expect(result.success).toBe(true);
    expect(entitlements).toContainEqual(
      expect.objectContaining({
        authUserId: creator.authUserId,
        productId: PRODUCT_ID,
        status: 'active',
        subjectId,
      })
    );
  });

  // [F20] Blocked on createApiKey ArgumentValidationError: apikey.userId required by convex/betterAuth/schema.ts:83, not supplied by @better-auth/api-key@1.6.13.
  test.failing('[F20] webhook create returns a sanitized secret and persists only encrypted storage', async () => {
    const creator = await createBetterAuthUser({ name: 'Webhook Creator' });
    const apiKey = await createPublicApiKey(creator.authUserId, PUBLIC_API_SCOPES);

    const created = await apiJson<{
      _id: string;
      enabled: boolean;
      events: string[];
      signingSecret: string;
      signingSecretEnc?: string;
      status: string;
      url: string;
    }>('/api/public/v2/webhooks', {
      method: 'POST',
      headers: apiKeyHeaders(apiKey),
      body: JSON.stringify({
        url: 'https://example.com/hook',
        events: ['ping'],
        enabled: true,
      }),
    });

    expect(created.response.status).toBe(201);
    expect(created.body._id).toStartWith('j');
    expect(created.body.url).toBe('https://example.com/hook');
    expect(created.body.events).toEqual(['ping']);
    expect(created.body.enabled).toBe(true);
    expect(created.body.status).toBe('active');
    expect(created.body.signingSecret).toStartWith('whsec_');
    expect(created.body.signingSecretEnc).toBeUndefined();

    const subscriptions = await getRealApiHarness().convex.collect('webhook_subscriptions');
    expect(subscriptions).toHaveLength(1);
    const [subscription] = subscriptions;
    expect(String(subscription._id)).toBe(created.body._id);
    expect(subscription.authUserId).toBe(creator.authUserId);
    expect(subscription.signingSecretEnc).toBeString();
    expect(subscription.signingSecretEnc).not.toBe(created.body.signingSecret);
    expect(JSON.stringify(subscription)).not.toContain(created.body.signingSecret);
  });
});
