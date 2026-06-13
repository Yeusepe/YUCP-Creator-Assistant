import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

type RegisteredRoute = {
  method: string;
  path?: string;
  pathPrefix?: string;
  handler: (ctx: unknown, request: Request) => Promise<Response>;
};

const registeredRoutes: RegisteredRoute[] = [];
const verifyCertEnvelopeAgainstPinnedRootsMock = mock(async (_envelope?: unknown) => true);
const resolvePinnedYucpSigningRootMock = mock(
  async (_privateKey?: string, configuredKeyId?: string | null) => ({
    keyId: configuredKeyId ?? 'root-key-id',
    publicKeyBase64: 'root-public-key',
    privateKeyBase64: 'root-private-key',
  })
);
const verifySigningProofMock = mock(async (_payload?: unknown, _signature?: string) => true);
const isSigningRequestTimestampFreshMock = mock((_timestamp: number) => true);

mock.module('convex/server', () => ({
  httpRouter: () => ({
    route(definition: RegisteredRoute) {
      registeredRoutes.push(definition);
    },
  }),
}));

mock.module('./_generated/server', () => ({
  httpAction: (handler: RegisteredRoute['handler']) => handler,
}));

const internalMock = {
  lib: {
    httpRateLimit: {
      checkAndIncrement: 'internal.lib.httpRateLimit.checkAndIncrement',
    },
  },
  signingLog: {
    getEntriesByContentHash: 'internal.signingLog.getEntriesByContentHash',
  },
  yucpCertificates: {
    getCertByPublisherId: 'internal.yucpCertificates.getCertByPublisherId',
    getCertByNonce: 'internal.yucpCertificates.getCertByNonce',
  },
  packageRegistry: {
    getRegistration: 'internal.packageRegistry.getRegistration',
    registerPackage: 'internal.packageRegistry.registerPackage',
  },
  certificateBilling: {
    resolveForAuthUser: 'internal.certificateBilling.resolveForAuthUser',
  },
  yucpLicenses: {
    checkAndConsumeNonce: 'internal.yucpLicenses.checkAndConsumeNonce',
  },
} as const;

mock.module('./_generated/api', () => ({
  api: {},
  components: {
    betterAuth: {
      adapter: {
        findMany: 'components.betterAuth.adapter.findMany',
        findOne: 'components.betterAuth.adapter.findOne',
      },
    },
  },
  internal: internalMock,
}));

mock.module('./auth', () => ({
  authComponent: {
    registerRoutes: () => undefined,
  },
  createAuth: () => ({}),
}));

mock.module('./betterAuth/jwks', () => ({
  buildPublicJwks: () => ({ keys: [] }),
}));

mock.module('./lib/apiActor', () => ({
  createServiceActorBinding: () => ({}),
}));

mock.module('./lib/betterAuthAdapter', () => ({
  buildBetterAuthUserLookupWhere: () => ({}),
  buildBetterAuthUserProviderLookupWhere: () => ({}),
  getBetterAuthPage: (result: { page?: unknown[] }) => result.page ?? [],
}));

mock.module('./lib/certificateSigning', () => ({
  isSigningRequestTimestampFresh: isSigningRequestTimestampFreshMock,
  verifySigningProof: verifySigningProofMock,
}));

mock.module('./lib/publicAuthIssuer', () => ({
  buildPublicAuthIssuer: () => 'https://issuer.example.com',
  resolveConfiguredPublicApiBaseUrl: () => 'https://public-api.example.com',
}));

mock.module('./lib/yucpCrypto', () => ({
  base64ToBytes: (_value: string) => new Uint8Array(),
  getConfiguredYucpJwkSet: () => ({ keys: [] }),
  resolvePinnedYucpSigningRoot: resolvePinnedYucpSigningRootMock,
  signLicenseJwt: mock(async () => 'signed-license-jwt'),
  signPackageCertificateData: mock(async () => 'signed-certificate'),
  signYucpTrustBundleJwt: mock(async () => 'signed-trust-bundle'),
  verifyCertEnvelope: mock(async () => true),
  verifyCertEnvelopeAgainstPinnedRoots: verifyCertEnvelopeAgainstPinnedRootsMock,
}));

mock.module('./oauthDiscovery', () => ({
  handleOAuthAuthorizationServerMetadata: () =>
    new Response('{}', {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
      },
    }),
}));

mock.module('./polyfills', () => ({}));

mock.module('@yucp/providers/providerMetadata', () => ({
  PROVIDER_REGISTRY: [],
  PROVIDER_REGISTRY_BY_KEY: {},
}));

await import('./http');

const originalFetch = globalThis.fetch;
const originalRootPrivateKey = process.env.YUCP_ROOT_PRIVATE_KEY;
const originalRootKeyId = process.env.YUCP_ROOT_KEY_ID;

function getRoute(method: string, path: string): RegisteredRoute {
  const route = registeredRoutes.find(
    (candidate) =>
      candidate.method === method && (candidate.path === path || candidate.pathPrefix === path)
  );
  if (!route) {
    throw new Error(`Route not registered: ${method} ${path}`);
  }
  return route;
}

describe('Convex HTTP surface hardening', () => {
  beforeEach(() => {
    process.env.YUCP_ROOT_PRIVATE_KEY = 'root-private-key';
    process.env.YUCP_ROOT_KEY_ID = 'root-key-id';
    verifyCertEnvelopeAgainstPinnedRootsMock.mockReset();
    resolvePinnedYucpSigningRootMock.mockReset();
    verifySigningProofMock.mockReset();
    isSigningRequestTimestampFreshMock.mockReset();

    verifyCertEnvelopeAgainstPinnedRootsMock.mockResolvedValue(true);
    resolvePinnedYucpSigningRootMock.mockResolvedValue({
      keyId: 'root-key-id',
      publicKeyBase64: 'root-public-key',
      privateKeyBase64: 'root-private-key',
    });
    verifySigningProofMock.mockResolvedValue(true);
    isSigningRequestTimestampFreshMock.mockReturnValue(true);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env.YUCP_ROOT_PRIVATE_KEY = originalRootPrivateKey;
    process.env.YUCP_ROOT_KEY_ID = originalRootKeyId;
  });

  it('returns sanitized package lookup payloads without leaking owner identifiers or raw cert envelopes', async () => {
    const runMutationMock = mock(async (reference: unknown) => {
      if (reference !== internalMock.lib.httpRateLimit.checkAndIncrement) {
        throw new Error(`Unexpected mutation reference: ${String(reference)}`);
      }
      return false;
    });
    const runQueryMock = mock(async (reference: unknown) => {
      if (reference === internalMock.signingLog.getEntriesByContentHash) {
        return [
          {
            publisherId: 'publisher-1',
            packageId: 'package-1',
            yucpUserId: 'signing-user-1',
          },
        ];
      }
      if (reference === internalMock.yucpCertificates.getCertByPublisherId) {
        return {
          status: 'revoked',
          revocationReason: 'developer_request',
          certData: { raw: 'should-not-leak' },
        };
      }
      if (reference === internalMock.packageRegistry.getRegistration) {
        return {
          yucpUserId: 'owner-user-2',
          registeredOwnerYucpUserId: 'owner-user-2',
        };
      }
      throw new Error(`Unexpected query reference: ${String(reference)}`);
    });

    const route = getRoute('GET', '/v1/packages/');
    const response = await route.handler(
      {
        runMutation: runMutationMock,
        runQuery: runQueryMock,
      },
      new Request('https://convex.example.com/v1/packages/hash-123', {
        headers: {
          'cf-connecting-ip': '203.0.113.10',
        },
      })
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({
      known: true,
      status: 'revoked',
      revocationReason: 'developer_request',
      ownershipConflict: true,
    });
    expect(body.registeredOwnerYucpUserId).toBeUndefined();
    expect(body.signingYucpUserId).toBeUndefined();
    expect(body.certData).toBeUndefined();
  });

  it('returns a generic namespace-conflict payload when signature registration hits another owner', async () => {
    const runMutationMock = mock(async (reference: unknown) => {
      if (reference === internalMock.lib.httpRateLimit.checkAndIncrement) {
        return false;
      }
      if (reference === internalMock.yucpLicenses.checkAndConsumeNonce) {
        return undefined;
      }
      if (reference === internalMock.packageRegistry.registerPackage) {
        return {
          registered: false,
          conflict: true,
          ownedBy: 'owner-user-2',
        };
      }
      throw new Error(`Unexpected mutation reference: ${String(reference)}`);
    });
    const runQueryMock = mock(async (reference: unknown) => {
      if (reference === internalMock.yucpCertificates.getCertByNonce) {
        return {
          status: 'active',
        };
      }
      if (reference === internalMock.certificateBilling.resolveForAuthUser) {
        return {
          allowSigning: true,
          billingEnabled: true,
        };
      }
      throw new Error(`Unexpected query reference: ${String(reference)}`);
    });

    const envelope = {
      cert: {
        nonce: 'cert-nonce-1',
        devPublicKey: 'dev-public-key',
        publisherId: 'publisher-1',
        yucpUserId: 'signing-user-1',
        issuedAt: new Date(Date.now() - 1_000).toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      signature: {
        keyId: 'root-key-id',
        sig: 'signature-bytes',
      },
    };

    const route = getRoute('POST', '/v1/signatures');
    const response = await route.handler(
      {
        runMutation: runMutationMock,
        runQuery: runQueryMock,
      },
      new Request('https://convex.example.com/v1/signatures', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${btoa(JSON.stringify(envelope))}`,
          'Content-Type': 'application/json',
          'cf-connecting-ip': '203.0.113.10',
        },
        body: JSON.stringify({
          packageId: 'package-1',
          packageName: 'Runtime Package',
          contentHash: 'a'.repeat(64),
          requestNonce: 'request-nonce-1',
          requestTimestamp: Date.now(),
          requestSignature: 'request-signature',
        }),
      })
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: 'PACKAGE_OWNERSHIP_CONFLICT',
      message: 'Package ownership conflict detected.',
    });
  });
});
