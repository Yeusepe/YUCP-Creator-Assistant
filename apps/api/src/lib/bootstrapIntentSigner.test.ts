import { describe, expect, it } from 'bun:test';
import * as ed25519 from '@noble/ed25519';
import { signYucpBootstrapIntent, verifyYucpBootstrapIntent } from './bootstrapIntentSigner';

describe('bootstrap intent signing', () => {
  it('signs exact release identity and rejects target tampering', async () => {
    const privateKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
    const publicKey = await ed25519.getPublicKeyAsync(privateKey);
    const intent = await signYucpBootstrapIntent({
      aliasId: 'com.yucp.jammr',
      config: {
        keyId: 'package-install-test',
        privateKey,
      },
      intent: {
        schemaVersion: 1,
        intentId: '00000000-0000-4000-8000-000000000805',
        mode: 'specific',
        issuedAt: 1_775_000_000,
        editionId: 'standard',
        version: '2.4.0',
        versionId: 'version-jammr-240',
        releaseRoot: 'c'.repeat(64),
      },
    });

    expect(
      await verifyYucpBootstrapIntent({
        aliasId: 'com.yucp.jammr',
        intent,
        publicKey,
      })
    ).toBe(true);
    expect(
      await verifyYucpBootstrapIntent({
        aliasId: 'com.yucp.jammr',
        intent: { ...intent, releaseRoot: 'd'.repeat(64) },
        publicKey,
      })
    ).toBe(false);
  });
});
