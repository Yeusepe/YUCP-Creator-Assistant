import { describe, expect, it } from 'bun:test';
import { buildPublicJwks } from './jwks';

describe('buildPublicJwks', () => {
  it('serializes stored Better Auth keys into a public JWKS payload', () => {
    const payload = buildPublicJwks([
      {
        id: 'kid_123',
        publicKey: JSON.stringify({
          kty: 'RSA',
          n: 'modulus',
          e: 'AQAB',
          use: 'sig',
        }),
        alg: 'RS256',
        createdAt: Date.now(),
        expiresAt: null,
      },
    ]);

    expect(payload).toEqual({
      keys: [
        {
          kid: 'kid_123',
          kty: 'RSA',
          n: 'modulus',
          e: 'AQAB',
          use: 'sig',
          alg: 'RS256',
          crv: undefined,
        },
      ],
    });
  });

  it('filters keys that are beyond the grace period and preserves curve metadata', () => {
    const now = new Date('2026-03-21T00:00:00.000Z').getTime();
    const payload = buildPublicJwks(
      [
        {
          id: 'expired',
          publicKey: JSON.stringify({
            kty: 'OKP',
            x: 'expired-key',
          }),
          alg: 'EdDSA',
          crv: 'Ed25519',
          createdAt: now,
          expiresAt: now - 31 * 24 * 60 * 60 * 1000,
        },
        {
          id: 'active',
          publicKey: JSON.stringify({
            kty: 'OKP',
            x: 'active-key',
          }),
          alg: 'RS256',
          crv: 'Ed25519',
          createdAt: now,
          expiresAt: now + 60 * 60 * 1000,
        },
      ],
      { now }
    );

    expect(payload).toEqual({
      keys: [
        {
          kid: 'active',
          kty: 'OKP',
          x: 'active-key',
          alg: 'RS256',
          crv: 'Ed25519',
        },
      ],
    });
  });
});
