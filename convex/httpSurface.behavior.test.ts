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
  attestation: {
    issueChallenge: 'internal.attestation.issueChallenge',
    consumeChallenge: 'internal.attestation.consumeChallenge',
    recordResolution: 'internal.attestation.recordResolution',
    recordCouplingProof: 'internal.attestation.recordCouplingProof',
    attachPaymentAnchor: 'internal.attestation.attachPaymentAnchor',
    flagIdentityForReview: 'internal.attestation.flagIdentityForReview',
    reviewIdentityBlock: 'internal.attestation.reviewIdentityBlock',
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
  verifyLicenseJwtAgainstPinnedRoots: mock(async () => null),
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
const originalConvexApiSecret = process.env.CONVEX_API_SECRET;

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
    if (originalRootPrivateKey === undefined) {
      delete process.env.YUCP_ROOT_PRIVATE_KEY;
    } else {
      process.env.YUCP_ROOT_PRIVATE_KEY = originalRootPrivateKey;
    }
    if (originalRootKeyId === undefined) {
      delete process.env.YUCP_ROOT_KEY_ID;
    } else {
      process.env.YUCP_ROOT_KEY_ID = originalRootKeyId;
    }
    if (originalConvexApiSecret === undefined) {
      delete process.env.CONVEX_API_SECRET;
    } else {
      process.env.CONVEX_API_SECRET = originalConvexApiSecret;
    }
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

  it('rejects malformed attestation record payloads before consuming a nonce', async () => {
    process.env.CONVEX_API_SECRET = 'relay-test-secret';
    const runMutationMock = mock(async () => ({
      correlationId: 'corr-1',
      blocked: false,
      nodeId: 'identity-node-1',
    }));

    const route = getRoute('POST', '/v1/attestation/internal/record');
    const response = await route.handler(
      { runMutation: runMutationMock },
      new Request('https://convex.example.com/v1/attestation/internal/record', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer relay-test-secret',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          nonce: 'a'.repeat(64),
          anchors: [{ anchorType: 'tpm_ek', anchorHash: 'not-a-hash' }],
          attestation: {
            tpmVerified: true,
            flags: [],
            fingerprintVector: [],
            osAnchorHashes: [],
            correlationId: 'corr-1',
          },
        }),
      })
    );

    expect(response.status).toBe(400);
    expect(runMutationMock.mock.calls).toHaveLength(0);
  });

  it('rejects attestation records whose consumed nonce belongs to a different correlationId', async () => {
    process.env.CONVEX_API_SECRET = 'relay-test-secret';
    const runMutationMock = mock(async (reference: unknown) => {
      if (reference === internalMock.attestation.consumeChallenge) {
        return { correlationId: 'corr-issued' };
      }
      if (reference === internalMock.attestation.recordResolution) {
        return { blocked: false, nodeId: 'identity-node-1' };
      }
      throw new Error(`Unexpected mutation reference: ${String(reference)}`);
    });

    const route = getRoute('POST', '/v1/attestation/internal/record');
    const response = await route.handler(
      { runMutation: runMutationMock },
      new Request('https://convex.example.com/v1/attestation/internal/record', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer relay-test-secret',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          nonce: 'b'.repeat(64),
          anchors: [{ anchorType: 'tpm_ek', anchorHash: 'c'.repeat(64) }],
          attestation: {
            ekHash: 'c'.repeat(64),
            tpmVerified: true,
            flags: [],
            fingerprintVector: [],
            osAnchorHashes: [],
            machineFingerprintHash: 'd'.repeat(64),
            correlationId: 'corr-submitted',
          },
        }),
      })
    );

    expect(response.status).toBe(422);
    expect(
      runMutationMock.mock.calls.some(
        ([reference]) => reference === internalMock.attestation.recordResolution
      )
    ).toBe(false);
  });

  it('rejects attestation records without a machine fingerprint hash', async () => {
    process.env.CONVEX_API_SECRET = 'relay-test-secret';
    const runMutationMock = mock(async (reference: unknown) => {
      if (reference === internalMock.attestation.consumeChallenge) {
        return { correlationId: 'corr-1' };
      }
      if (reference === internalMock.attestation.recordResolution) {
        return { blocked: false, nodeId: 'identity-node-1' };
      }
      throw new Error(`Unexpected mutation reference: ${String(reference)}`);
    });

    const route = getRoute('POST', '/v1/attestation/internal/record');
    const response = await route.handler(
      { runMutation: runMutationMock },
      new Request('https://convex.example.com/v1/attestation/internal/record', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer relay-test-secret',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          nonce: 'c'.repeat(64),
          anchors: [{ anchorType: 'tpm_ek', anchorHash: 'c'.repeat(64) }],
          attestation: {
            ekHash: 'c'.repeat(64),
            tpmVerified: true,
            flags: [],
            fingerprintVector: [],
            osAnchorHashes: [],
            correlationId: 'corr-1',
          },
        }),
      })
    );

    expect(response.status).toBe(400);
    expect(runMutationMock.mock.calls).toHaveLength(0);
  });

  it('rejects malformed coupling proofs before consuming a nonce', async () => {
    process.env.CONVEX_API_SECRET = 'relay-test-secret';
    const runMutationMock = mock(async () => ({
      correlationId: 'corr-proof',
      proofId: 'proof-1',
    }));

    const route = getRoute('POST', '/v1/attestation/internal/coupling-record');
    const response = await route.handler(
      { runMutation: runMutationMock },
      new Request('https://convex.example.com/v1/attestation/internal/coupling-record', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer relay-test-secret',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          nonce: 'd'.repeat(64),
          proof: {
            correlationId: 'corr-proof',
            tpmVerified: true,
            flags: [],
            assets: [{ pathHash: 'e'.repeat(64), contentSha256: 'bad-sha' }],
          },
        }),
      })
    );

    expect(response.status).toBe(400);
    expect(runMutationMock.mock.calls).toHaveLength(0);
  });

  it('rejects coupling proofs whose consumed nonce belongs to a different correlationId', async () => {
    process.env.CONVEX_API_SECRET = 'relay-test-secret';
    const runMutationMock = mock(async (reference: unknown) => {
      if (reference === internalMock.attestation.consumeChallenge) {
        return { correlationId: 'corr-issued' };
      }
      if (reference === internalMock.attestation.recordCouplingProof) {
        return { proofId: 'proof-1' };
      }
      throw new Error(`Unexpected mutation reference: ${String(reference)}`);
    });

    const route = getRoute('POST', '/v1/attestation/internal/coupling-record');
    const response = await route.handler(
      { runMutation: runMutationMock },
      new Request('https://convex.example.com/v1/attestation/internal/coupling-record', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer relay-test-secret',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          nonce: 'e'.repeat(64),
          proof: {
            correlationId: 'corr-submitted',
            tpmVerified: true,
            flags: [],
            assets: [{ pathHash: 'f'.repeat(64), contentSha256: 'a'.repeat(64) }],
          },
        }),
      })
    );

    expect(response.status).toBe(422);
    expect(
      runMutationMock.mock.calls.some(
        ([reference]) => reference === internalMock.attestation.recordCouplingProof
      )
    ).toBe(false);
  });

  it('rejects malformed payment anchors before mutation', async () => {
    process.env.CONVEX_API_SECRET = 'relay-test-secret';
    const runMutationMock = mock(async () => ({ attached: true }));

    const route = getRoute('POST', '/v1/attestation/internal/payment-anchor');
    const response = await route.handler(
      { runMutation: runMutationMock },
      new Request('https://convex.example.com/v1/attestation/internal/payment-anchor', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer relay-test-secret',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          licenseSubject: 'a'.repeat(64),
          paymentFingerprintHash: 'not-a-hash',
        }),
      })
    );

    expect(response.status).toBe(400);
    expect(runMutationMock.mock.calls).toHaveLength(0);
  });

  it('exposes confirmed identity block creation through the authenticated internal surface', async () => {
    process.env.CONVEX_API_SECRET = 'relay-test-secret';
    const runMutationMock = mock(async (reference: unknown, args: unknown) => {
      if (reference === internalMock.attestation.flagIdentityForReview) {
        expect(args).toEqual({
          identityNodeId: 'identity-node-1',
          reason: 'confirmed leaked trace',
          evidenceRef: 'trace:release:asset',
        });
        return { blockId: 'block-1' };
      }
      throw new Error(`Unexpected mutation reference: ${String(reference)}`);
    });

    const route = getRoute('POST', '/v1/attestation/internal/identity-blocks');
    const response = await route.handler(
      { runMutation: runMutationMock },
      new Request('https://convex.example.com/v1/attestation/internal/identity-blocks', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer relay-test-secret',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          identityNodeId: 'identity-node-1',
          reason: 'confirmed leaked trace',
          evidenceRef: 'trace:release:asset',
        }),
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true, blockId: 'block-1' });
    expect(runMutationMock.mock.calls).toHaveLength(1);
  });

  it('exposes identity block review through the authenticated internal surface', async () => {
    process.env.CONVEX_API_SECRET = 'relay-test-secret';
    const runMutationMock = mock(async (reference: unknown, args: unknown) => {
      if (reference === internalMock.attestation.reviewIdentityBlock) {
        expect(args).toEqual({
          blockId: 'block-1',
          decision: 'active',
          reviewedByUserId: 'reviewer-1',
          appeal: 'confirmed by closed-service threshold',
        });
        return undefined;
      }
      throw new Error(`Unexpected mutation reference: ${String(reference)}`);
    });

    const route = getRoute('POST', '/v1/attestation/internal/identity-block-reviews');
    const response = await route.handler(
      { runMutation: runMutationMock },
      new Request('https://convex.example.com/v1/attestation/internal/identity-block-reviews', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer relay-test-secret',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          blockId: 'block-1',
          decision: 'active',
          reviewedByUserId: 'reviewer-1',
          appeal: 'confirmed by closed-service threshold',
        }),
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true });
    expect(runMutationMock.mock.calls).toHaveLength(1);
  });
});
