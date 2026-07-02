import { setPinnedYucpRootsForTests } from '@yucp/shared/yucpTrust';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { api, internal } from './_generated/api';
import * as couplingForensics from './couplingForensics';
import { buildCreatorProfileWorkspaceKey } from './lib/certificateBillingConfig';
import { PII_PURPOSES } from './lib/credentialKeys';
import { encryptPii } from './lib/piiCrypto';
import { buildPublicAuthIssuer } from './lib/publicAuthIssuer';
import * as yucpCrypto from './lib/yucpCrypto';
import {
  makeTestConvex,
  seedCertificateBillingCatalog,
  seedCreatorProfile,
} from './testHelpers';

const issuerBaseUrl = 'https://coupling-job.test.example';
const packageId = 'pkg.coupling.bundle';
const machineFingerprint = 'a604eb0948054b9acb9f40da80a6a4c8e711b98c59e54a11089fea3a2b77dc1c';
const projectId = '0123456789abcdef0123456789abcdef';
const creatorAuthUserId = 'auth-coupling-job';
const publisherId = 'publisher-coupling-job';
const licenseSubject = 'f'.repeat(64);
const runtimeVersion = '2026.03.27.1';
const runtimePlaintextSha256 = 'b'.repeat(64);

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Buffer.from(new Uint8Array(digest)).toString('hex');
}

describe('coupling job + license redaction', () => {
  let rootPrivateKey = '';
  let originalFetch: typeof fetch;
  let originalCouplingServiceBaseUrl: string | undefined;
  let originalCouplingServiceSecret: string | undefined;
  let originalCouplingServiceSharedSecret: string | undefined;

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    originalCouplingServiceBaseUrl = process.env.YUCP_COUPLING_SERVICE_BASE_URL;
    originalCouplingServiceSecret = process.env.COUPLING_SERVICE_SECRET;
    originalCouplingServiceSharedSecret = process.env.YUCP_COUPLING_SERVICE_SHARED_SECRET;
    process.env.CONVEX_API_SECRET = 'test-secret';
    process.env.ENCRYPTION_SECRET = 'test-encryption-secret-for-coupling-job-flow';
    process.env.API_BASE_URL = issuerBaseUrl;
    rootPrivateKey = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');
    process.env.YUCP_ROOT_PRIVATE_KEY = rootPrivateKey;
    const rootPublicKey = await yucpCrypto.getPublicKeyFromPrivate(rootPrivateKey);
    process.env.YUCP_ROOT_PUBLIC_KEY = rootPublicKey;
    process.env.YUCP_ROOT_KEY_ID = 'yucp-root';
    setPinnedYucpRootsForTests([
      { keyId: 'yucp-root', algorithm: 'Ed25519', publicKeyBase64: rootPublicKey },
    ]);
  });

  afterEach(() => {
    setPinnedYucpRootsForTests(null);
    globalThis.fetch = originalFetch;
    if (originalCouplingServiceBaseUrl === undefined) {
      delete process.env.YUCP_COUPLING_SERVICE_BASE_URL;
    } else {
      process.env.YUCP_COUPLING_SERVICE_BASE_URL = originalCouplingServiceBaseUrl;
    }
    if (originalCouplingServiceSecret === undefined) {
      delete process.env.COUPLING_SERVICE_SECRET;
    } else {
      process.env.COUPLING_SERVICE_SECRET = originalCouplingServiceSecret;
    }
    if (originalCouplingServiceSharedSecret === undefined) {
      delete process.env.YUCP_COUPLING_SERVICE_SHARED_SECRET;
    } else {
      process.env.YUCP_COUPLING_SERVICE_SHARED_SECRET = originalCouplingServiceSharedSecret;
    }
  });

  function mockSeedRelay(seedHex = '1'.repeat(64)) {
    const expectedSecret = 'test-coupling-relay-token';
    process.env.YUCP_COUPLING_SERVICE_BASE_URL = 'https://coupling-service.test';
    process.env.COUPLING_SERVICE_SECRET = expectedSecret;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://coupling-service.test/v1/coupling/internal/derive-seeds');
      expect(init?.method).toBe('POST');
      const headers = new Headers(init?.headers);
      expect(headers.get('Authorization')).toBe(`Bearer ${expectedSecret}`);
      expect(headers.get('Content-Type')).toBe('application/json');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      const body = JSON.parse(String(init?.body ?? '{}')) as { assetPaths?: string[] };
      return new Response(
        JSON.stringify({
          seeds: (body.assetPaths ?? []).map((assetPath) => ({ assetPath, seedHex })),
        }),
        { status: 200 }
      );
    }) as typeof fetch;
  }

  function mockFallbackSeedRelay(seedHex = '2'.repeat(64)) {
    const expectedSecret = 'test-fallback-coupling-relay-token';
    process.env.YUCP_COUPLING_SERVICE_BASE_URL = 'https://coupling-service.test';
    process.env.COUPLING_SERVICE_SECRET = '';
    process.env.YUCP_COUPLING_SERVICE_SHARED_SECRET = expectedSecret;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://coupling-service.test/v1/coupling/internal/derive-seeds');
      const headers = new Headers(init?.headers);
      expect(headers.get('Authorization')).toBe(`Bearer ${expectedSecret}`);
      const body = JSON.parse(String(init?.body ?? '{}')) as { assetPaths?: string[] };
      return new Response(
        JSON.stringify({
          seeds: (body.assetPaths ?? []).map((assetPath) => ({ assetPath, seedHex })),
        }),
        { status: 200 }
      );
    }) as typeof fetch;
  }

  function mockPreferredSeedRelay(seedHex = '3'.repeat(64)) {
    const expectedSecret = 'test-preferred-coupling-relay-token';
    let observedAuthorization: string | null = null;
    process.env.YUCP_COUPLING_SERVICE_BASE_URL = 'https://coupling-service.test';
    process.env.COUPLING_SERVICE_SECRET = 'stale-legacy-coupling-relay-token';
    process.env.YUCP_COUPLING_SERVICE_SHARED_SECRET = expectedSecret;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://coupling-service.test/v1/coupling/internal/derive-seeds');
      const headers = new Headers(init?.headers);
      observedAuthorization = headers.get('Authorization');
      const body = JSON.parse(String(init?.body ?? '{}')) as { assetPaths?: string[] };
      return new Response(
        JSON.stringify({
          seeds: (body.assetPaths ?? []).map((assetPath) => ({ assetPath, seedHex })),
        }),
        { status: 200 }
      );
    }) as typeof fetch;
    return {
      expectedAuthorization: `Bearer ${expectedSecret}`,
      getObservedAuthorization: () => observedAuthorization,
    };
  }

  function mockStreamingSeedRelay(seedHex = '4'.repeat(64)) {
    const expectedSecret = 'test-streaming-coupling-relay-token';
    process.env.YUCP_COUPLING_SERVICE_BASE_URL = 'https://coupling-service.test';
    process.env.YUCP_COUPLING_SERVICE_SHARED_SECRET = expectedSecret;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://coupling-service.test/v1/coupling/internal/derive-seeds');
      const headers = new Headers(init?.headers);
      expect(headers.get('Authorization')).toBe(`Bearer ${expectedSecret}`);
      const body = JSON.parse(String(init?.body ?? '{}')) as { assetPaths?: string[] };
      const payload = JSON.stringify({
        seeds: (body.assetPaths ?? []).map((assetPath) => ({ assetPath, seedHex })),
      });
      const bytes = new TextEncoder().encode(payload);
      const response = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
        { status: 200 }
      );
      response.text = async () => {
        throw new Error('seed relay responses must use the bounded stream reader');
      };
      return response;
    }) as typeof fetch;
  }

  async function seedPackageRegistration(t: ReturnType<typeof makeTestConvex>) {
    await t.run(async (ctx) => {
      await ctx.db.insert('package_registry', {
        packageId,
        publisherId,
        yucpUserId: creatorAuthUserId,
        status: 'active',
        registeredAt: Date.now(),
        updatedAt: Date.now(),
      });
    });
  }

  async function seedActiveCouplingRuntime(t: ReturnType<typeof makeTestConvex>) {
    const now = Date.now();
    await t.run(async (ctx) => {
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
    });
  }

  async function mintLicenseToken(overrides?: Partial<{ machine_fingerprint: string; package_id: string }>) {
    const nowSeconds = Math.floor(Date.now() / 1000);
    return await yucpCrypto.signLicenseJwt(
      {
        iss: buildPublicAuthIssuer(issuerBaseUrl),
        aud: 'yucp-license-gate',
        sub: licenseSubject,
        jti: `nonce-${nowSeconds}-${Math.floor(crypto.getRandomValues(new Uint32Array(1))[0])}`,
        package_id: overrides?.package_id ?? packageId,
        machine_fingerprint: overrides?.machine_fingerprint ?? machineFingerprint,
        provider: 'gumroad',
        iat: nowSeconds,
        exp: nowSeconds + 3600,
      },
      rootPrivateKey,
      'yucp-root'
    );
  }

  it('rejects an invalid license token', async () => {
    const t = makeTestConvex();
    await seedPackageRegistration(t);
    await seedActiveCouplingRuntime(t);

    const result = await t.action(internal.yucpLicenses.issueCouplingJob, {
      packageId,
      projectId,
      machineFingerprint,
      licenseToken: 'not-a-jwt',
      assetPaths: ['Assets/body.png'],
      issuerBaseUrl,
    });

    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('rejects a token whose machine fingerprint does not match the request', async () => {
    const t = makeTestConvex();
    await seedPackageRegistration(t);
    await seedActiveCouplingRuntime(t);
    const licenseToken = await mintLicenseToken({ machine_fingerprint: 'c'.repeat(64) });

    const result = await t.action(internal.yucpLicenses.issueCouplingJob, {
      packageId,
      projectId,
      machineFingerprint,
      licenseToken,
      assetPaths: ['Assets/body.png'],
      issuerBaseUrl,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('machine');
  });

  it('skips (without failing) when no coupling-runtime artifact is active', async () => {
    const t = makeTestConvex();
    await seedPackageRegistration(t);
    const licenseToken = await mintLicenseToken();

    const result = await t.action(internal.yucpLicenses.issueCouplingJob, {
      packageId,
      projectId,
      machineFingerprint,
      licenseToken,
      assetPaths: ['Assets/body.png'],
      issuerBaseUrl,
    });

    expect(result.success).toBe(true);
    expect(result.skipReason).toBe('no_runtime');
    expect(result.files).toEqual([]);
  });

  it('issues per-asset tokens and records hash-only forensic traces bound to the license subject', async () => {
    const t = makeTestConvex();
    await seedPackageRegistration(t);
    await seedActiveCouplingRuntime(t);
    mockSeedRelay();
    const licenseToken = await mintLicenseToken();
    const assetPaths = ['Assets/Character/body.png', 'Assets/Model/model.fbx'];

    const result = await t.action(internal.yucpLicenses.issueCouplingJob, {
      packageId,
      projectId,
      machineFingerprint,
      licenseToken,
      assetPaths,
      issuerBaseUrl,
    });

    expect(result.success).toBe(true);
    expect(result.runtimeToken).toBeTruthy();
    expect(result.runtimeSha256).toBe(runtimePlaintextSha256);
    expect(result.files).toHaveLength(2);
    expect(result.files?.map((file) => file.seedHex)).toEqual(['1'.repeat(64), '1'.repeat(64)]);

    // The runtime token round-trips and is bound to the same artifact.
    const runtimeClaims = await yucpCrypto.verifyCouplingRuntimeJwtAgainstPinnedRoots(
      result.runtimeToken ?? '',
      buildPublicAuthIssuer(issuerBaseUrl)
    );
    expect(runtimeClaims).toMatchObject({
      package_id: packageId,
      machine_fingerprint: machineFingerprint,
      artifact_version: runtimeVersion,
      plaintext_sha256: runtimePlaintextSha256,
    });

    const traces = await t.run(async (ctx) =>
      ctx.db
        .query('coupling_trace_records')
        .withIndex('by_auth_user_created', (q) => q.eq('authUserId', creatorAuthUserId))
        .collect()
    );
    expect(traces).toHaveLength(2);
    for (const trace of traces) {
      expect(trace.licenseSubject).toBe(licenseSubject);
      expect(trace.machineFingerprintHash).toBe(await sha256Hex(machineFingerprint));
      expect(trace.projectIdHash).toBe(await sha256Hex(projectId));
      expect(trace.runtimePlaintextSha256).toBe(runtimePlaintextSha256);
    }
    // tokenHash is the SHA-256 of the per-file tokenHex; plaintext token is never stored.
    for (const file of result.files ?? []) {
      const expectedHash = await sha256Hex(file.tokenHex);
      expect(traces.some((trace) => trace.tokenHash === expectedHash)).toBe(true);
    }
  });

  it('does not record gateway traces when runtime token signing is unavailable', async () => {
    const t = makeTestConvex();
    await seedPackageRegistration(t);
    const licenseToken = await mintLicenseToken();
    delete process.env.YUCP_ROOT_PRIVATE_KEY;

    await expect(
      t.action(api.yucpLicenses.assembleCouplingJob, {
        apiSecret: 'test-secret',
        packageId,
        projectId,
        machineFingerprint,
        licenseToken,
        assetPaths: ['Assets/Character/body.png'],
        runtimeManifest: {
          artifactKey: 'coupling-runtime',
          channel: 'stable',
          platform: 'win-x64',
          version: runtimeVersion,
          metadataVersion: 1,
          deliveryName: 'yucp_coupling.dll',
          contentType: 'application/octet-stream',
          envelopeCipher: 'none',
          envelopeIvBase64: '',
          ciphertextSha256: runtimePlaintextSha256,
          ciphertextSize: 4,
          plaintextSha256: runtimePlaintextSha256,
          plaintextSize: 4,
        },
        seeds: [{ assetPath: 'Assets/Character/body.png', seedHex: '1'.repeat(64) }],
      })
    ).rejects.toThrow('YUCP_ROOT_PRIVATE_KEY not configured');

    const traces = await t.run(async (ctx) =>
      ctx.db
        .query('coupling_trace_records')
        .withIndex('by_auth_user_created', (q) => q.eq('authUserId', creatorAuthUserId))
        .collect()
    );
    expect(traces).toHaveLength(0);
  });

  it('uses the fallback coupling relay secret when the primary secret is blank', async () => {
    const t = makeTestConvex();
    await seedPackageRegistration(t);
    await seedActiveCouplingRuntime(t);
    mockFallbackSeedRelay();
    const licenseToken = await mintLicenseToken();

    const result = await t.action(internal.yucpLicenses.issueCouplingJob, {
      packageId,
      projectId,
      machineFingerprint,
      licenseToken,
      assetPaths: ['Assets/Character/body.png'],
      issuerBaseUrl,
    });

    expect(result.success).toBe(true);
    expect(result.files?.map((file) => file.seedHex)).toEqual(['2'.repeat(64)]);
  });

  it('prefers the YUCP coupling relay secret when both secret env vars are present', async () => {
    const t = makeTestConvex();
    await seedPackageRegistration(t);
    await seedActiveCouplingRuntime(t);
    const relay = mockPreferredSeedRelay();
    const licenseToken = await mintLicenseToken();

    const result = await t.action(internal.yucpLicenses.issueCouplingJob, {
      packageId,
      projectId,
      machineFingerprint,
      licenseToken,
      assetPaths: ['Assets/Character/body.png'],
      issuerBaseUrl,
    });

    expect(result.success).toBe(true);
    expect(result.files?.map((file) => file.seedHex)).toEqual(['3'.repeat(64)]);
    expect(relay.getObservedAuthorization()).toBe(relay.expectedAuthorization);
  });

  it('preserves private coupling relay base paths when deriving seeds', async () => {
    const t = makeTestConvex();
    await seedPackageRegistration(t);
    await seedActiveCouplingRuntime(t);
    process.env.YUCP_COUPLING_SERVICE_BASE_URL = 'https://coupling-service.test/private/coupling';
    process.env.YUCP_COUPLING_SERVICE_SHARED_SECRET = 'test-prefixed-coupling-relay-token';
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe(
        'https://coupling-service.test/private/coupling/v1/coupling/internal/derive-seeds'
      );
      const body = JSON.parse(String(init?.body ?? '{}')) as { assetPaths?: string[] };
      return new Response(
        JSON.stringify({
          seeds: (body.assetPaths ?? []).map((assetPath) => ({
            assetPath,
            seedHex: '5'.repeat(64),
          })),
        }),
        { status: 200 }
      );
    }) as typeof fetch;
    const licenseToken = await mintLicenseToken();

    const result = await t.action(internal.yucpLicenses.issueCouplingJob, {
      packageId,
      projectId,
      machineFingerprint,
      licenseToken,
      assetPaths: ['Assets/Character/body.png'],
      issuerBaseUrl,
    });

    expect(result.success).toBe(true);
    expect(result.files?.map((file) => file.seedHex)).toEqual(['5'.repeat(64)]);
  });

  it('does not send the relay bearer secret to non-loopback HTTP endpoints', async () => {
    const t = makeTestConvex();
    await seedPackageRegistration(t);
    await seedActiveCouplingRuntime(t);
    process.env.YUCP_COUPLING_SERVICE_BASE_URL = 'http://coupling-service.test';
    process.env.YUCP_COUPLING_SERVICE_SHARED_SECRET = 'test-coupling-relay-token';
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response(
        JSON.stringify({
          seeds: [{ assetPath: 'Assets/Character/body.png', seedHex: '4'.repeat(64) }],
        }),
        { status: 200 }
      );
    }) as typeof fetch;
    const licenseToken = await mintLicenseToken();

    const result = await t.action(internal.yucpLicenses.issueCouplingJob, {
      packageId,
      projectId,
      machineFingerprint,
      licenseToken,
      assetPaths: ['Assets/Character/body.png'],
      issuerBaseUrl,
    });

    expect(result.success).toBe(true);
    expect(result.skipReason).toBe('seed_unavailable');
    expect(result.files).toEqual([]);
    expect(fetchCalled).toBe(false);
  });

  it('reads coupling relay responses through the bounded stream reader', async () => {
    const t = makeTestConvex();
    await seedPackageRegistration(t);
    await seedActiveCouplingRuntime(t);
    mockStreamingSeedRelay();
    const licenseToken = await mintLicenseToken();

    const result = await t.action(internal.yucpLicenses.issueCouplingJob, {
      packageId,
      projectId,
      machineFingerprint,
      licenseToken,
      assetPaths: ['Assets/Character/body.png'],
      issuerBaseUrl,
    });

    expect(result.success).toBe(true);
    expect(result.files?.map((file) => file.seedHex)).toEqual(['4'.repeat(64)]);
  });

  // ── License redaction ─────────────────────────────────────────────────────

  async function seedCouplingTraceability(t: ReturnType<typeof makeTestConvex>) {
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
      ownerDiscordUserId: 'discord-coupling-job',
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
    });
  }

  async function seedTraceAndLink(
    t: ReturnType<typeof makeTestConvex>,
    licenseKey: string
  ) {
    const now = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.insert('coupling_trace_records', {
        authUserId: creatorAuthUserId,
        packageId,
        licenseSubject,
        assetPath: 'Assets/Character/body.png',
        tokenHash: 'a'.repeat(64),
        tokenLength: 32,
        machineFingerprintHash: 'c'.repeat(64),
        projectIdHash: 'd'.repeat(64),
        runtimeArtifactVersion: runtimeVersion,
        runtimePlaintextSha256: runtimePlaintextSha256,
        correlationId: 'corr-coupling-reveal',
        createdAt: now,
        provider: 'gumroad',
      });
    });
    const encrypted = await encryptPii(licenseKey, PII_PURPOSES.forensicsLicenseKey);
    await t.run(async (ctx) => {
      await ctx.db.insert('license_subject_links', {
        licenseSubject,
        authUserId: creatorAuthUserId,
        packageId,
        provider: 'gumroad',
        licenseKeyEncrypted: encrypted,
        providerProductId: 'product-coupling',
        createdAt: now,
      });
    });
  }

  it('surfaces a non-secret masked license id but never the raw key in lookups', async () => {
    const t = makeTestConvex();
    await seedCouplingTraceability(t);
    await seedPackageRegistration(t);
    await seedTraceAndLink(t, 'LICENSE-KEY-12345');

    const result = await t.query(api.couplingForensics.lookupTraceMatchesForAuthUser, {
      apiSecret: 'test-secret',
      authUserId: creatorAuthUserId,
      packageId,
      tokenHashes: ['a'.repeat(64)],
    });

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].licenseMasked).toBe(`gumroad · ${licenseSubject.slice(0, 10)}`);
    expect(result.matches[0]).not.toHaveProperty('licenseKey');
  });

  it('does not export a plaintext license key reveal mutation', () => {
    expect('revealCouplingLicenseKey' in couplingForensics).toBe(false);
  });
});
