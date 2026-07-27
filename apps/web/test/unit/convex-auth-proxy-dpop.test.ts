import { generateKeyPairSync, sign } from 'node:crypto';
import { verifyDpopProof } from 'better-auth/oauth2';
import { describe, expect, it } from 'vitest';
import { canonicalizeBetterAuthProxyRequest } from '../../../../convex/auth';

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function createDpopProof(htu: string): string {
  const { privateKey, publicKey } = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
  });
  const protectedHeader = encodeJson({
    alg: 'ES256',
    typ: 'dpop+jwt',
    jwk: publicKey.export({ format: 'jwk' }),
  });
  const payload = encodeJson({
    htm: 'POST',
    htu,
    iat: Math.floor(Date.now() / 1_000),
    jti: 'proxy-contract-proof',
  });
  const signature = sign('sha256', Buffer.from(`${protectedHeader}.${payload}`, 'ascii'), {
    dsaEncoding: 'ieee-p1363',
    key: privateKey,
  }).toString('base64url');

  return `${protectedHeader}.${payload}.${signature}`;
}

function readDpopHtu(proof: string): string {
  const payload = proof.split('.')[1];
  if (!payload) {
    throw new Error('The DPoP proof has no payload');
  }

  const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
    htu?: unknown;
  };
  if (typeof decoded.htu !== 'string') {
    throw new Error('The DPoP proof has no htu claim');
  }

  return decoded.htu;
}

describe('Convex Better Auth proxy DPoP contract', () => {
  it('does not read optional Request properties that the Convex runtime omits', () => {
    const request = {
      url: 'https://example.convex.site/api/auth/get-session',
      method: 'GET',
      headers: new Headers({
        accept: 'application/json',
      }),
      get redirect(): RequestRedirect {
        throw new Error('Not implemented: get redirect for Request');
      },
      get signal(): AbortSignal {
        throw new Error('Not implemented: get signal for Request');
      },
    } as Request;

    expect(() =>
      canonicalizeBetterAuthProxyRequest(request, 'http://localhost:3000')
    ).not.toThrow();
  });

  it('restores the public token URL before Better Auth validates the signed htu claim', async () => {
    const publicTokenUrl = 'http://localhost:3000/api/auth/oauth2/token';
    const proof = createDpopProof(publicTokenUrl);
    const internalRequest = new Request(
      'https://example.convex.site/api/auth/oauth2/token?source=package-broker',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          dpop: proof,
          traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
        },
        body: 'grant_type=authorization_code&code=test-code',
      }
    );

    const canonicalRequest = canonicalizeBetterAuthProxyRequest(
      internalRequest,
      'http://localhost:3000'
    );

    expect(internalRequest.url).toBe(
      'https://example.convex.site/api/auth/oauth2/token?source=package-broker'
    );
    expect(canonicalRequest.url).toBe(
      'http://localhost:3000/api/auth/oauth2/token?source=package-broker'
    );
    expect(readDpopHtu(canonicalRequest.headers.get('dpop') ?? '')).toBe(publicTokenUrl);
    expect(canonicalRequest.method).toBe('POST');
    expect(canonicalRequest.headers.get('traceparent')).toBe(
      '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'
    );
    await expect(
      verifyDpopProof({
        proofJwt: proof,
        method: internalRequest.method,
        url: internalRequest.url,
      })
    ).rejects.toThrow(/htu/i);
    await expect(
      verifyDpopProof({
        proofJwt: proof,
        method: canonicalRequest.method,
        url: canonicalRequest.url,
      })
    ).resolves.toMatchObject({
      htm: 'POST',
      htu: publicTokenUrl,
      jti: 'proxy-contract-proof',
    });
    await expect(canonicalRequest.text()).resolves.toBe(
      'grant_type=authorization_code&code=test-code'
    );
  });
});
