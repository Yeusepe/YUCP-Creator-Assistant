import { describe, expect, it } from 'bun:test';
import * as ed from '@noble/ed25519';
import { bytesToBase64 } from '@yucp/shared/crypto';
import { signYucpTrustBundleJwt, verifyYucpTrustBundleJwt } from './yucpCrypto';

describe('yucp trust bundle rotation', () => {
  it('signs and verifies authenticated trust bundles for root rotation', async () => {
    const rootPrivateKey = ed.utils.randomPrivateKey();
    const rootPublicKey = await ed.getPublicKeyAsync(rootPrivateKey);

    const jwt = await signYucpTrustBundleJwt(
      {
        issuer: 'https://api.creators.yucp.club',
        version: 2,
        keys: [
          {
            kty: 'OKP',
            crv: 'Ed25519',
            kid: 'yucp-root-2026',
            x: 'rotated-public-key',
          },
        ],
      },
      bytesToBase64(rootPrivateKey),
      'yucp-root'
    );

    await expect(
      verifyYucpTrustBundleJwt(
        jwt,
        [
          {
            keyId: 'yucp-root',
            algorithm: 'Ed25519',
            publicKeyBase64: bytesToBase64(rootPublicKey),
          },
        ],
        'https://api.creators.yucp.club'
      )
    ).resolves.toEqual({
      iss: 'https://api.creators.yucp.club',
      aud: 'yucp-trust-bundle',
      version: 2,
      keys: [
        {
          kty: 'OKP',
          crv: 'Ed25519',
          kid: 'yucp-root-2026',
          x: 'rotated-public-key',
        },
      ],
      iat: expect.any(Number),
      exp: expect.any(Number),
    });
  });
});
