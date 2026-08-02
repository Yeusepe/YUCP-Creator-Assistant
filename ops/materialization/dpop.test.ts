import { describe, expect, it, mock } from 'bun:test';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { DpopNonceRequiredError, verifyDpopProof } from '../storage-core/dpop';

const now = 2_000_000_000;
const endpoint = 'https://control.example.test/v2/internal/materialization-capabilities/consume';
const capability = Buffer.from('signed-capability').toString('base64url');

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function createProof(overrides: Record<string, unknown> = {}): string {
  const { privateKey, publicKey } = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
  });
  const jwk = publicKey.export({ format: 'jwk' });
  const protectedHeader = encodeJson({
    alg: 'ES256',
    jwk,
    typ: 'dpop+jwt',
  });
  const payload = encodeJson({
    ath: createHash('sha256').update(capability, 'ascii').digest('base64url'),
    htm: 'POST',
    htu: endpoint,
    iat: now,
    jti: 'proof-1',
    ...overrides,
  });
  const signature = sign('sha256', Buffer.from(`${protectedHeader}.${payload}`, 'ascii'), {
    dsaEncoding: 'ieee-p1363',
    key: privateKey,
  }).toString('base64url');
  return `${protectedHeader}.${payload}.${signature}`;
}

describe('materialization DPoP verification', () => {
  it('binds one ES256 proof to the exact method, URL, and capability', async () => {
    const verified = await verifyDpopProof({
      accessToken: capability,
      method: 'POST',
      now: new Date(now * 1_000),
      proof: createProof(),
      url: endpoint,
    });

    expect(verified.jti).toBe('proof-1');
    expect(verified.thumbprint).toBeInstanceOf(Uint8Array);
    expect(verified.thumbprint).toHaveLength(32);
  });

  it('rejects capability substitution and a different HTTP target', async () => {
    const proof = createProof();
    await expect(
      verifyDpopProof({
        accessToken: Buffer.from('other-capability').toString('base64url'),
        method: 'POST',
        now: new Date(now * 1_000),
        proof,
        url: endpoint,
      })
    ).rejects.toThrow('access token hash');
    await expect(
      verifyDpopProof({
        accessToken: capability,
        method: 'POST',
        now: new Date(now * 1_000),
        proof,
        url: 'https://control.example.test/v2/internal/other',
      })
    ).rejects.toThrow('target URL');
  });

  it('rejects stale proofs before the broker consumes a capability', async () => {
    await expect(
      verifyDpopProof({
        accessToken: capability,
        method: 'POST',
        now: new Date((now + 301) * 1_000),
        proof: createProof(),
        url: endpoint,
      })
    ).rejects.toThrow('outside the permitted clock window');
  });

  it('uses a valid server nonce instead of the client clock while preserving replay expiry', async () => {
    const nonceExpiresAt = new Date((now + 300) * 1_000);
    const reserve = mock(async () => true);
    const verified = await verifyDpopProof({
      acceptedFutureSkewSeconds: 5,
      accessToken: capability,
      method: 'POST',
      nonceVerifier: {
        verify: async (nonce) =>
          nonce === 'server-time-nonce' ? { expiresAt: nonceExpiresAt } : null,
      },
      now: new Date(now * 1_000),
      proof: createProof({ iat: now + 86_400, nonce: 'server-time-nonce' }),
      replayStore: { reserve },
      url: endpoint,
    });

    expect(verified.nonceBound).toBe(true);
    expect(reserve).toHaveBeenCalledWith(
      expect.objectContaining({ expiresAt: nonceExpiresAt, now: new Date(now * 1_000) })
    );
  });

  it('requests a server nonce only when clock skew is the remaining invalid claim', async () => {
    await expect(
      verifyDpopProof({
        acceptedFutureSkewSeconds: 5,
        accessToken: capability,
        method: 'POST',
        nonceVerifier: { verify: async () => null },
        now: new Date(now * 1_000),
        proof: createProof({ iat: now + 6 }),
        url: endpoint,
      })
    ).rejects.toBeInstanceOf(DpopNonceRequiredError);

    await expect(
      verifyDpopProof({
        acceptedFutureSkewSeconds: 5,
        accessToken: 'different-token',
        method: 'POST',
        nonceVerifier: { verify: async () => null },
        now: new Date(now * 1_000),
        proof: createProof({ iat: now + 6 }),
        url: endpoint,
      })
    ).rejects.toThrow('access token hash');
  });
});
