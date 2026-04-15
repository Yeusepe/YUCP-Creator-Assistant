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
    setPinnedYucpRootsForTests([
      {
        keyId: 'test-root',
        algorithm: 'Ed25519',
        publicKeyBase64: 'fixture-public-key',
      },
    ]);

    expect(getPrimaryPinnedYucpRoot()).toEqual({
      keyId: 'test-root',
      algorithm: 'Ed25519',
      publicKeyBase64: 'fixture-public-key',
    });
    expect(getPinnedYucpJwkSet()).toEqual([
      {
        kty: 'OKP',
        crv: 'Ed25519',
        kid: 'test-root',
        x: 'fixture-public-key',
      },
    ]);
  });

  it('parses a configured trust bundle with versioned JWK keys', () => {
    expect(
      resolveConfiguredYucpTrustBundle(
        JSON.stringify({
          version: 7,
          keys: [
            {
              kty: 'OKP',
              crv: 'Ed25519',
              kid: 'yucp-root-2026',
              x: 'rotated-public-key',
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
          publicKeyBase64: 'rotated-public-key',
        },
      ],
    });
  });
});
