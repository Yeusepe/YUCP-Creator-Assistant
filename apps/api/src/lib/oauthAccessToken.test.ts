import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';

let verifyBearerTokenImpl: (token: string, options: unknown) => Promise<unknown>;
let verifyAccessTokenRequestImpl: (request: unknown, options: unknown) => Promise<unknown>;
let verifyJwsAccessTokenImpl: (token: string, options: unknown) => Promise<unknown>;

const verifyBearerTokenMock = mock((token: string, options: unknown) =>
  verifyBearerTokenImpl(token, options)
);
const verifyAccessTokenRequestMock = mock((request: unknown, options: unknown) =>
  verifyAccessTokenRequestImpl(request, options)
);
const verifyJwsAccessTokenMock = mock((token: string, options: unknown) =>
  verifyJwsAccessTokenImpl(token, options)
);

mock.module('better-auth/oauth2', () => ({
  getDpopJktFromPayload: (payload: { cnf?: { jkt?: string } }) => payload.cnf?.jkt,
  requestToResourceInput: (request: Request) => ({
    authorizationHeader: request.headers.get('authorization'),
    dpopProofJwt: request.headers.get('dpop'),
    method: request.method,
    url: request.url,
  }),
  verifyAccessTokenRequest: verifyAccessTokenRequestMock,
  verifyBearerToken: verifyBearerTokenMock,
  verifyJwsAccessToken: verifyJwsAccessTokenMock,
}));

const { verifyBetterAuthAccessRequest, verifyBetterAuthAccessToken } = await import(
  './oauthAccessToken'
);

describe('verifyBetterAuthAccessToken', () => {
  const debug = mock(() => {});
  const warn = mock(() => {});
  const options = {
    audience: 'yucp-public-api',
    convexSiteUrl: 'https://test.convex.site',
    logger: { debug, warn },
    logContext: 'OAuth token verification failed',
    publicResourceBaseUrl: 'https://api.example.test',
  };

  beforeEach(() => {
    verifyBearerTokenMock.mockClear();
    verifyAccessTokenRequestMock.mockClear();
    verifyJwsAccessTokenMock.mockClear();
    debug.mockClear();
    warn.mockClear();
    verifyBearerTokenImpl = async () => ({ sub: 'user_123', scope: 'profile:read' });
    verifyAccessTokenRequestImpl = async () => ({
      azp: 'yucp-package-broker',
      cnf: { jkt: Buffer.from('44'.repeat(32), 'hex').toString('base64url') },
      scope: 'package:operate',
      sub: 'user_123',
    });
    verifyJwsAccessTokenImpl = async () => ({
      azp: 'yucp-package-broker',
      cnf: { jkt: Buffer.from('44'.repeat(32), 'hex').toString('base64url') },
      scope: 'package:operate',
      sub: 'user_123',
    });
  });

  it('uses the Better Auth 1.7 bearer-token verifier', async () => {
    const result = await verifyBetterAuthAccessToken('valid-token', options);

    expect(result).toEqual({
      ok: true,
      token: {
        sub: 'user_123',
        scope: 'profile:read',
        grantedScopes: ['profile:read'],
      },
    });
    expect(verifyBearerTokenMock).toHaveBeenCalledTimes(1);
  });

  it('logs expected invalid-token verifier failures at debug instead of warn', async () => {
    verifyBearerTokenImpl = async () => {
      const error = new Error('no applicable key found in the JSON Web Key Set');
      error.name = 'JWKSNoMatchingKey';
      throw error;
    };

    const result = await verifyBetterAuthAccessToken('bad-token', options);

    expect(result).toEqual({ ok: false, reason: 'invalid' });
    expect(debug).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps unexpected verifier failures at warn', async () => {
    verifyBearerTokenImpl = async () => {
      const error = new Error('network timeout while fetching jwks');
      error.name = 'TypeError';
      throw error;
    };

    const result = await verifyBetterAuthAccessToken('bad-token', options);

    expect(result).toEqual({ ok: false, reason: 'invalid' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(debug).not.toHaveBeenCalled();
  });

  it('uses request-aware DPoP verification and exposes only the public thumbprint', async () => {
    const request = new Request('https://api.example.test/api/v2/package-installs/authorizations', {
      method: 'POST',
      headers: {
        Authorization: 'DPoP access-token',
        DPoP: 'proof-jwt',
      },
    });
    const replayStore = { reserve: mock(async () => true) };

    const result = await verifyBetterAuthAccessRequest(request, {
      ...options,
      audience: 'https://api.example.test',
      dpopReplayStore: replayStore,
      requiredAuthorizedParty: 'yucp-package-broker',
      requiredScopes: ['package:operate'],
    });

    expect(result).toEqual({
      ok: true,
      token: {
        deviceKeyThumbprint: '44'.repeat(32),
        grantedScopes: ['package:operate'],
        scope: 'package:operate',
        sub: 'user_123',
      },
    });
    expect(verifyAccessTokenRequestMock).toHaveBeenCalledTimes(1);
    expect(verifyAccessTokenRequestMock.mock.calls[0]?.[1]).toMatchObject({
      dpop: {
        proofMaxAgeSeconds: 300,
        replayStore,
        signingAlgorithms: ['ES256'],
      },
    });
  });

  it('verifies DPoP htu against the trusted public resource URL behind a proxy', async () => {
    const request = new Request(
      'http://10.42.0.30:8080/api/v2/package-installs/authorizations?attempt=1',
      {
        method: 'POST',
        headers: {
          Authorization: 'DPoP access-token',
          DPoP: 'proof-jwt',
          'X-Forwarded-Host': 'attacker.example.test',
          'X-Forwarded-Proto': 'http',
        },
      }
    );

    await verifyBetterAuthAccessRequest(request, {
      ...options,
      audience: 'https://api.example.test/package-operations',
      dpopReplayStore: { reserve: async () => true },
      publicResourceBaseUrl: 'https://api.example.test',
    });

    expect(verifyAccessTokenRequestMock.mock.calls[0]?.[0]).toMatchObject({
      method: 'POST',
      url: 'https://api.example.test/api/v2/package-installs/authorizations?attempt=1',
    });
  });

  it('reports a DPoP verifier dependency outage separately from invalid credentials', async () => {
    verifyAccessTokenRequestImpl = async () => {
      throw Object.assign(new Error('connect ECONNREFUSED database:5432'), {
        code: 'ECONNREFUSED',
      });
    };

    const result = await verifyBetterAuthAccessRequest(
      new Request('https://api.example.test/api/v2/package-installs/authorizations', {
        method: 'POST',
        headers: {
          Authorization: 'DPoP access-token',
          DPoP: 'proof-jwt',
        },
      }),
      {
        ...options,
        audience: 'https://api.example.test',
        dpopReplayStore: { reserve: async () => true },
      }
    );

    expect(result).toEqual({ ok: false, reason: 'unavailable' });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('rejects a request token without a DPoP confirmation key', async () => {
    verifyAccessTokenRequestImpl = async () => ({
      scope: 'package:operate',
      sub: 'user_123',
    });

    const result = await verifyBetterAuthAccessRequest(
      new Request('https://api.example.test/api/v2/package-installs/authorizations', {
        method: 'POST',
        headers: { Authorization: 'Bearer access-token' },
      }),
      {
        ...options,
        audience: 'https://api.example.test',
        dpopReplayStore: { reserve: async () => true },
      }
    );

    expect(result).toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects a DPoP token issued to another OAuth client', async () => {
    verifyAccessTokenRequestImpl = async () => ({
      azp: 'another-native-client',
      cnf: { jkt: Buffer.from('44'.repeat(32), 'hex').toString('base64url') },
      scope: 'package:operate',
      sub: 'user_123',
    });

    const result = await verifyBetterAuthAccessRequest(
      new Request('https://api.example.test/api/v2/package-installs/authorizations', {
        method: 'POST',
        headers: {
          Authorization: 'DPoP access-token',
          DPoP: 'proof-jwt',
        },
      }),
      {
        ...options,
        audience: 'https://api.example.test',
        dpopReplayStore: { reserve: async () => true },
        requiredAuthorizedParty: 'yucp-package-broker',
      }
    );

    expect(result).toEqual({ ok: false, reason: 'invalid' });
  });

  it('challenges an otherwise-valid clock-skewed proof and accepts its nonce-bound retry', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = publicKey.export({ format: 'jwk' });
    const jkt = createHash('sha256')
      .update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }))
      .digest('base64url');
    verifyJwsAccessTokenImpl = async () => ({
      azp: 'yucp-package-broker',
      cnf: { jkt },
      scope: 'package:operate',
      sub: 'user_123',
    });
    verifyAccessTokenRequestImpl = async () => {
      throw new Error('DPoP proof iat is outside the accepted window');
    };
    const endpoint = 'https://api.example.test/api/v2/package-installs/sessions';
    const createProof = (nonce?: string) => {
      const encodedHeader = Buffer.from(
        JSON.stringify({ alg: 'ES256', jwk, typ: 'dpop+jwt' })
      ).toString('base64url');
      const encodedPayload = Buffer.from(
        JSON.stringify({
          ath: createHash('sha256').update('access-token').digest('base64url'),
          htm: 'POST',
          htu: endpoint,
          iat: Math.floor(Date.now() / 1_000) + 3_600,
          jti: crypto.randomUUID(),
          ...(nonce ? { nonce } : {}),
        })
      ).toString('base64url');
      const signature = sign('sha256', Buffer.from(`${encodedHeader}.${encodedPayload}`, 'ascii'), {
        dsaEncoding: 'ieee-p1363',
        key: privateKey,
      }).toString('base64url');
      return `${encodedHeader}.${encodedPayload}.${signature}`;
    };
    const dpopNonceManager = {
      issue: mock(async () => ({
        expiresAt: new Date(Date.now() + 300_000),
        nonce: 'server-time-nonce',
      })),
      verify: mock(async (nonce: string) =>
        nonce === 'server-time-nonce' ? { expiresAt: new Date(Date.now() + 300_000) } : null
      ),
    };
    const request = (proof: string) =>
      new Request(endpoint, {
        method: 'POST',
        headers: { Authorization: 'DPoP access-token', DPoP: proof },
      });
    const nonceOptions = {
      ...options,
      audience: 'https://api.example.test',
      dpopNonceManager,
      dpopReplayStore: { reserve: async () => true },
      requiredAuthorizedParty: 'yucp-package-broker',
      requiredScopes: ['package:operate'],
    };

    await expect(
      verifyBetterAuthAccessRequest(request(createProof()), nonceOptions)
    ).resolves.toEqual({
      dpopNonce: 'server-time-nonce',
      ok: false,
      reason: 'use_dpop_nonce',
    });
    await expect(
      verifyBetterAuthAccessRequest(request(createProof('server-time-nonce')), nonceOptions)
    ).resolves.toEqual({
      ok: true,
      token: {
        deviceKeyThumbprint: Buffer.from(jkt, 'base64url').toString('hex'),
        grantedScopes: ['package:operate'],
        scope: 'package:operate',
        sub: 'user_123',
      },
    });
  });
});
