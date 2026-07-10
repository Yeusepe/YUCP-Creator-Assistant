import { beforeEach, describe, expect, it, mock } from 'bun:test';

const apiMock = {
  manualLicenses: {
    create: 'manualLicenses.create',
    bulkCreate: 'manualLicenses.bulkCreate',
    listByTenant: 'manualLicenses.listByTenant',
  },
  subjects: {
    resolveSubjectForPublicApi: 'subjects.resolveSubjectForPublicApi',
  },
  entitlements: {
    getEntitlementsBySubject: 'entitlements.getEntitlementsBySubject',
  },
} as const;

let mutationImpl: (fn: unknown, args: unknown) => Promise<unknown>;
let queryImpl: (fn: unknown, args: unknown) => Promise<unknown>;

const mutationMock = mock((fn: unknown, args: unknown) => mutationImpl(fn, args));
const queryMock = mock((fn: unknown, args: unknown) => queryImpl(fn, args));
const convexFactoryCalls: unknown[][] = [];

mock.module('../../../../../convex/_generated/api', () => ({
  api: apiMock,
}));

mock.module('../../lib/convex', () => ({
  getConvexClientFromUrl: (...args: unknown[]) => {
    convexFactoryCalls.push(args);
    return { mutation: mutationMock, query: queryMock };
  },
}));

mock.module('./auth', () => ({
  resolveAuth: async () => ({
    authUserId: 'user_abc',
    actorBinding: {
      payload: 'test-payload',
      signature: 'test-signature',
    },
    scopes: ['licenses:manage'],
  }),
}));

const { handleManualLicensesRoutes } = await import('./manual-licenses');
const { handleSubjectsRoutes } = await import('./subjects');
const { handleVerificationRoutes } = await import('./verification');

const config = {
  apiBaseUrl: 'https://api.test',
  convexUrl: 'https://test.convex.cloud',
  convexApiSecret: 'test-secret',
  convexSiteUrl: 'https://test.convex.site',
  encryptionSecret: 'test-enc',
  frontendBaseUrl: 'https://creators.test',
};

function makeRequest(method: string, subPath: string, body?: unknown): Request {
  const url = `http://localhost/api/public/v2${subPath}`;
  return new Request(url, {
    method,
    headers: {
      authorization: 'Bearer test-token',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

beforeEach(() => {
  mutationMock.mockClear();
  queryMock.mockClear();
  convexFactoryCalls.length = 0;
  mutationImpl = async (fn) => {
    if (fn === apiMock.manualLicenses.create) return { licenseId: 'license_001' };
    if (fn === apiMock.manualLicenses.bulkCreate) {
      return { created: 1, licenseIds: ['license_001'] };
    }
    throw new Error(`Unhandled mutation: ${String(fn)}`);
  };
  queryImpl = async (fn) => {
    if (fn === apiMock.manualLicenses.listByTenant) {
      return { data: [{ _id: 'license_001' }], hasMore: true, nextCursor: 'license_001' };
    }
    throw new Error(`Unhandled query: ${String(fn)}`);
  };
});

// hashLicenseKey is private to manual-licenses.ts, replicate the identical algorithm here
// so we can test its properties independently without importing the production module.
async function hashKey(key: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

describe('hashKey (SHA-256 hex)', () => {
  it('produces a deterministic 64-character hex string for "test"', async () => {
    const result = await hashKey('test');
    expect(result).toHaveLength(64);
    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });

  it('matches the known SHA-256 hex digest for "hello"', async () => {
    const result = await hashKey('hello');
    expect(result).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });

  it('is deterministic, same input always produces same hash', async () => {
    const a = await hashKey('consistent-input');
    const b = await hashKey('consistent-input');
    expect(a).toBe(b);
  });

  it('different keys produce different hashes', async () => {
    const a = await hashKey('abc');
    const b = await hashKey('xyz');
    expect(a).not.toBe(b);
  });

  it('produces a valid 64-char hex even for an empty string', async () => {
    const result = await hashKey('');
    expect(result).toHaveLength(64);
    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });

  it('handles unicode input without throwing', async () => {
    const result = await hashKey('héllo wörld 🎉');
    expect(result).toHaveLength(64);
    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('handleManualLicensesRoutes', () => {
  it('GET /manual-licenses passes list pagination through the caller-bound Convex client', async () => {
    const res = await handleManualLicensesRoutes(
      new Request(
        'http://localhost/api/public/v2/manual-licenses?limit=1&starting_after=license_000',
        {
          headers: { authorization: 'Bearer test-token' },
        }
      ),
      '/manual-licenses',
      config
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      data: [{ _id: 'license_001' }],
      hasMore: true,
      nextCursor: 'license_001',
    });
    expect(queryMock.mock.calls[0]).toEqual([
      apiMock.manualLicenses.listByTenant,
      {
        apiSecret: 'test-secret',
        authUserId: 'user_abc',
        productId: undefined,
        status: undefined,
        cursor: 'license_000',
        limit: 1,
      },
    ]);
    expect(convexFactoryCalls).toEqual([
      [
        config.convexUrl,
        {
          payload: 'test-payload',
          signature: 'test-signature',
        },
      ],
    ]);
  });

  it('POST /manual-licenses sends canonical licenseKeyHash to Convex create', async () => {
    const res = await handleManualLicensesRoutes(
      makeRequest('POST', '/manual-licenses', {
        key: 'plain-license-key',
        product_id: 'product_001',
      }),
      '/manual-licenses',
      config
    );

    expect(res.status).toBe(201);
    const [, args] = mutationMock.mock.calls[0] ?? [];
    expect(args).toMatchObject({
      authUserId: 'user_abc',
      productId: 'product_001',
    });
    expect((args as Record<string, unknown>).licenseKeyHash).toMatch(/^[0-9a-f]{64}$/);
    expect((args as Record<string, unknown>).hashedKey).toBeUndefined();
  });

  it('POST /manual-licenses/bulk sends canonical license fields to Convex bulkCreate', async () => {
    const res = await handleManualLicensesRoutes(
      makeRequest('POST', '/manual-licenses/bulk', {
        licenses: [
          {
            key: 'plain-license-key',
            product_id: 'product_001',
            max_uses: 2,
            expires_at: 1_800_000_000_000,
            notes: 'test note',
            buyer_email: 'buyer@example.com',
          },
        ],
      }),
      '/manual-licenses/bulk',
      config
    );

    expect(res.status).toBe(201);
    const [, args] = mutationMock.mock.calls[0] ?? [];
    const license = (args as { licenses: Array<Record<string, unknown>> }).licenses[0];
    expect(license).toMatchObject({
      productId: 'product_001',
      maxUses: 2,
      expiresAt: 1_800_000_000_000,
      notes: 'test note',
      buyerEmail: 'buyer@example.com',
    });
    expect(license.licenseKeyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(license.hashedKey).toBeUndefined();
    expect(license.key).toBeUndefined();
    expect(license.product_id).toBeUndefined();
  });

  it('POST /manual-licenses/bulk rejects empty license keys before Convex', async () => {
    const res = await handleManualLicensesRoutes(
      makeRequest('POST', '/manual-licenses/bulk', {
        licenses: [
          {
            key: '',
            product_id: 'product_001',
          },
        ],
      }),
      '/manual-licenses/bulk',
      config
    );

    expect(res.status).toBe(400);
    expect(mutationMock).not.toHaveBeenCalled();
  });

  it('POST /manual-licenses/bulk rejects empty product ids before Convex', async () => {
    const res = await handleManualLicensesRoutes(
      makeRequest('POST', '/manual-licenses/bulk', {
        licenses: [
          {
            key: 'plain-license-key',
            product_id: '',
          },
        ],
      }),
      '/manual-licenses/bulk',
      config
    );

    expect(res.status).toBe(400);
    expect(mutationMock).not.toHaveBeenCalled();
  });
});

describe('public subject resolution', () => {
  it('returns 404 when the subject resolver reports found:false', async () => {
    queryImpl = async () => ({ found: false, subject: null });

    const response = await handleSubjectsRoutes(
      makeRequest('GET', '/subjects/subject_missing'),
      '/subjects/subject_missing',
      config
    );

    expect(response.status).toBe(404);
  });

  it('returns the resolved subject rather than the resolver wrapper', async () => {
    const subject = { _id: 'subject_123', displayName: 'Test subject' };
    queryImpl = async () => ({ found: true, subject });

    const response = await handleSubjectsRoutes(
      makeRequest('GET', '/subjects/subject_123'),
      '/subjects/subject_123',
      config
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(subject);
  });

  it('treats found:false as an absent verification-status subject', async () => {
    queryImpl = async () => ({ found: false, subject: null });

    const response = await handleVerificationRoutes(
      makeRequest('GET', '/verification/status'),
      '/verification/status',
      config
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      object: 'verification_status',
      subject: null,
      entitlements: [],
    });
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it('uses the unwrapped subject for verification checks', async () => {
    const subject = { _id: 'subject_123', displayName: 'Test subject' };
    queryImpl = async (fn) => {
      if (fn === apiMock.subjects.resolveSubjectForPublicApi) {
        return { found: true, subject };
      }
      return [{ productId: 'product_123', status: 'active' }];
    };

    const response = await handleVerificationRoutes(
      makeRequest('POST', '/verification/check', {
        subject: { subjectId: 'subject_123' },
        productIds: ['product_123'],
      }),
      '/verification/check',
      config
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      subject,
      results: [{ productId: 'product_123', entitled: true }],
    });
  });
});
