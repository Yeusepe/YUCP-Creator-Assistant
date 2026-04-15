import { afterEach, describe, expect, it } from 'bun:test';
import {
  getPinnedYucpJwkSet,
  getPinnedYucpRootByKeyId,
  getPrimaryPinnedYucpRoot,
  resolveConfiguredYucpTrustBundle,
  setPinnedYucpRootsForTests,
} from './yucpTrust';

afterEach(() => {
  setPinnedYucpRootsForTests(null);
});

describe('yucpTrust', () => {
  it('pins the built-in production root key IDs in code', () => {
    expect(getPinnedYucpRootByKeyId('yucp-root')).toEqual({
      keyId: 'yucp-root',
      algorithm: 'Ed25519',
      publicKeyBase64: 'y+8Zs9/mS1MFZFeF4CFjwqe0nsLW8lCcwmyvBx6H0Zo=',
    });
    expect(getPinnedYucpRootByKeyId('yucp-root-2025')).toEqual({
      keyId: 'yucp-root-2025',
      algorithm: 'Ed25519',
      publicKeyBase64: 'y+8Zs9/mS1MFZFeF4CFjwqe0nsLW8lCcwmyvBx6H0Zo=',
    });
  });

  it('can swap in deterministic fixture roots for tests without mutating production defaults', () => {
    const fixturePublicKeyBase64 = Buffer.from(Uint8Array.from([255, 254, 253])).toString('base64');
    setPinnedYucpRootsForTests([
      {
        keyId: 'test-root',
        algorithm: 'Ed25519',
        publicKeyBase64: fixturePublicKeyBase64,
      },
    ]);

    expect(getPrimaryPinnedYucpRoot()).toEqual({
      keyId: 'test-root',
      algorithm: 'Ed25519',
      publicKeyBase64: fixturePublicKeyBase64,
    });
    expect(getPinnedYucpJwkSet()).toEqual([
      {
        kty: 'OKP',
        crv: 'Ed25519',
        kid: 'test-root',
        x: '__79',
      },
    ]);
  });

  it('parses a configured trust bundle with versioned JWK keys', () => {
    const rotatedPublicKeyBase64 = Buffer.from(Uint8Array.from([255, 254, 253])).toString('base64');
    expect(
      resolveConfiguredYucpTrustBundle(
        JSON.stringify({
          version: 7,
          keys: [
            {
              kty: 'OKP',
              crv: 'Ed25519',
              kid: 'yucp-root-2026',
              x: '__79',
            },
          ],
        })
      )
    ).toEqual({
      version: 7,
      roots: [
        {
          keyId: 'yucp-root-2026',
          algorithm: 'Ed25519',
          publicKeyBase64: rotatedPublicKeyBase64,
        },
      ],
    });
  });

  it('fails closed when a non-empty configured trust bundle is invalid', () => {
    expect(() => resolveConfiguredYucpTrustBundle('{"version":0,"keys":[]}')).toThrow(
      'invalid trust bundle'
    );
  });
});
