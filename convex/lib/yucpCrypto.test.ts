import { describe, expect, it } from 'bun:test';
import * as ed from '@noble/ed25519';
import {
  base64ToBytes,
  bytesToBase64,
  canonicalizePackageCertificate,
  signPackageCertificateData,
  type PackageCertificateData,
} from './yucpCrypto';

describe('yucpCrypto package certificate compatibility', () => {
  it('canonicalizes package certificate fields in importer order', () => {
    const certificate: PackageCertificateData = {
      keyId: 'publisher-cert:nonce-123',
      publicKey: 'publisher-public-key',
      issuerKeyId: 'yucp-root-2025',
      certificateType: 'Publisher',
      publisherId: 'publisher-123',
      notBefore: '2026-03-24T00:00:00.000Z',
      notAfter: '2026-04-24T00:00:00.000Z',
    };

    expect(canonicalizePackageCertificate(certificate)).toBe(
      '{"certificateType":"Publisher","issuerKeyId":"yucp-root-2025","keyId":"publisher-cert:nonce-123","notAfter":"2026-04-24T00:00:00.000Z","notBefore":"2026-03-24T00:00:00.000Z","publicKey":"publisher-public-key","publisherId":"publisher-123"}'
    );
  });

  it('signs package certificate payloads compatibly with Ed25519 verification', async () => {
    const rootPrivateKey = ed.utils.randomPrivateKey();
    const rootPublicKey = await ed.getPublicKeyAsync(rootPrivateKey);
    const certificate: PackageCertificateData = {
      keyId: 'publisher-cert:nonce-123',
      publicKey: 'publisher-public-key',
      issuerKeyId: 'yucp-root-2025',
      certificateType: 'Publisher',
      publisherId: 'publisher-123',
      notBefore: '2026-03-24T00:00:00.000Z',
      notAfter: '2026-04-24T00:00:00.000Z',
    };

    const signature = await signPackageCertificateData(
      certificate,
      bytesToBase64(rootPrivateKey)
    );

    await expect(
      ed.verifyAsync(
        base64ToBytes(signature),
        new TextEncoder().encode(canonicalizePackageCertificate(certificate)),
        rootPublicKey
      )
    ).resolves.toBe(true);
  });
});
