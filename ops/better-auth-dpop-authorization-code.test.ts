import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { oauthProvider } from '@better-auth/oauth-provider';
import { describe, expect, test } from 'bun:test';
import { betterAuth } from 'better-auth';

const authOrigin = 'https://auth.example.test';
const authBasePath = '/api/auth';
const tokenEndpoint = `${authOrigin}${authBasePath}/oauth2/token`;
const redirectUri = 'http://127.0.0.1:49152/callback';

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function createProof(
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'],
  publicKey: ReturnType<typeof generateKeyPairSync>['publicKey'],
  iat: number
): string {
  const protectedHeader = encodeJson({
    alg: 'ES256',
    jwk: publicKey.export({ format: 'jwk' }),
    typ: 'dpop+jwt',
  });
  const payload = encodeJson({
    htm: 'POST',
    htu: tokenEndpoint,
    iat,
    jti: randomUUID(),
  });
  const signature = sign('sha256', Buffer.from(`${protectedHeader}.${payload}`, 'ascii'), {
    dsaEncoding: 'ieee-p1363',
    key: privateKey,
  }).toString('base64url');
  return `${protectedHeader}.${payload}.${signature}`;
}

describe('Better Auth DPoP authorization-code consumption', () => {
  test('preserves the single-use code when DPoP validation fails before a corrected retry', async () => {
    const auth = betterAuth({
      basePath: authBasePath,
      baseURL: authOrigin,
      secret: 'test-secret-123456789012345678901234',
      plugins: [
        oauthProvider({
          consentPage: '/oauth/consent',
          disableJwtPlugin: true,
          grantTypes: ['authorization_code'],
          loginPage: '/oauth/login',
          scopes: ['package:operate'],
          storeTokens: { hash: async (token) => token },
        }),
      ],
    });
    const context = await auth.$context;
    const now = new Date();
    const user = await context.internalAdapter.createUser(
      {
        email: 'buyer@example.test',
        emailVerified: true,
        name: 'Buyer',
      },
      { providerId: 'credential' }
    );
    const session = await context.internalAdapter.createSession(user.id, false);
    const clientId = 'yucp-package-broker-test';
    await context.adapter.create({
      model: 'oauthClient',
      data: {
        clientId,
        createdAt: now,
        dpopBoundAccessTokens: true,
        grantTypes: ['authorization_code'],
        public: true,
        redirectUris: ['http://127.0.0.1/callback'],
        requirePKCE: true,
        responseTypes: ['code'],
        scopes: ['package:operate'],
        tokenEndpointAuthMethod: 'none',
        updatedAt: now,
      },
    });

    const code = 'single-use-code';
    const codeVerifier = 'A'.repeat(64);
    const codeChallenge = createHash('sha256').update(codeVerifier, 'ascii').digest('base64url');
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const publicJwk = publicKey.export({ format: 'jwk' });
    const dpopJkt = createHash('sha256')
      .update(
        JSON.stringify({
          crv: publicJwk.crv,
          kty: publicJwk.kty,
          x: publicJwk.x,
          y: publicJwk.y,
        })
      )
      .digest('base64url');
    await context.internalAdapter.createVerificationValue({
      createdAt: now,
      expiresAt: new Date(now.getTime() + 600_000),
      identifier: code,
      updatedAt: now,
      value: JSON.stringify({
        type: 'authorization_code',
        query: {
          client_id: clientId,
          code_challenge: codeChallenge,
          code_challenge_method: 'S256',
          dpop_jkt: dpopJkt,
          redirect_uri: redirectUri,
          response_type: 'code',
          scope: 'package:operate',
        },
        sessionId: session.id,
        userId: user.id,
      }),
    });

    const tokenRequest = (proof: string) =>
      auth.handler(
        new Request(tokenEndpoint, {
          body: new URLSearchParams({
            client_id: clientId,
            code,
            code_verifier: codeVerifier,
            grant_type: 'authorization_code',
            redirect_uri: redirectUri,
          }),
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            dpop: proof,
          },
          method: 'POST',
        })
      );

    const serverTime = Math.floor(Date.now() / 1_000);
    const skewedResponse = await tokenRequest(createProof(privateKey, publicKey, serverTime + 19));
    expect(skewedResponse.status).toBe(400);
    await expect(skewedResponse.json()).resolves.toEqual({
      error: 'invalid_dpop_proof',
      error_description: 'DPoP proof iat is outside the accepted window',
    });

    const correctedResponses = await Promise.all([
      tokenRequest(createProof(privateKey, publicKey, serverTime)),
      tokenRequest(createProof(privateKey, publicKey, serverTime)),
    ]);
    expect(correctedResponses.map((response) => response.status).sort()).toEqual([200, 400]);
    const successfulResponse = correctedResponses.find((response) => response.status === 200);
    const rejectedResponse = correctedResponses.find((response) => response.status === 400);
    expect(await successfulResponse?.json()).toMatchObject({
      token_type: 'DPoP',
    });
    expect(await rejectedResponse?.json()).toEqual({
      error: 'invalid_grant',
      error_description: 'invalid code',
    });
  });
});
