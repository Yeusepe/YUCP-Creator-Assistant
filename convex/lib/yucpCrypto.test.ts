import { describe, expect, it } from 'bun:test';
import * as ed from '@noble/ed25519';
import * as yucpCrypto from './yucpCrypto';

const { base64ToBytes, bytesToBase64, canonicalizePackageCertificate, signPackageCertificateData } =
  yucpCrypto;

type PackageCertificateData = yucpCrypto.PackageCertificateData;

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

    const signature = await signPackageCertificateData(certificate, bytesToBase64(rootPrivateKey));

    await expect(
      ed.verifyAsync(
        base64ToBytes(signature),
        new TextEncoder().encode(canonicalizePackageCertificate(certificate)),
        rootPublicKey
      )
    ).resolves.toBe(true);
  });

  it('canonicalizes and signs package manifest payloads compatibly with Ed25519 verification', async () => {
    const rootPrivateKey = ed.utils.randomPrivateKey();
    const rootPublicKey = await ed.getPublicKeyAsync(rootPrivateKey);
    const manifest = {
      schemaVersion: 1,
      packageId: 'pkg-protected-ticket',
      contentHash: 'c'.repeat(64),
      packageVersion: '1.0.0',
      publisherId: 'publisher-protected-ticket',
      yucpUserId: 'auth-protected-ticket',
      certNonce: 'cert-protected-ticket',
      protectedDelivery: {
        outerFormat: 'unitypackage',
        payloadFormat: 'yucp-protected-blob',
        unlockMode: 'live_ticket_only',
        offlineGraceAllowed: false,
      },
      protectedAssets: [
        {
          protectedAssetId: '46c90a22a12b44fe88fcd9be626bdedb',
          unlockMode: 'content_key_b64',
          displayName: 'Protected Blob',
        },
      ],
      forensic: {
        recipeVersion: 'yucp-protected-blob-forensics-v1',
        couplingTokenAlgorithm: 'hmac-sha256-truncated-v1',
        runtime: {
          artifactKey: 'yucp.coupling.runtime',
          channel: 'stable',
          platform: 'win-x64',
          version: '2026.03.26.1',
          metadataVersion: 1,
          plaintextSha256: 'b'.repeat(64),
        },
      },
    };

    const canonicalizePackageManifest = (yucpCrypto as any).canonicalizePackageManifest as
      | ((value: typeof manifest) => string)
      | undefined;
    const signPackageManifestData = (yucpCrypto as any).signPackageManifestData as
      | ((value: typeof manifest, privateKeyBase64: string) => Promise<string>)
      | undefined;

    expect(typeof canonicalizePackageManifest).toBe('function');
    expect(typeof signPackageManifestData).toBe('function');

    const canonical = canonicalizePackageManifest?.(manifest);
    expect(canonical).toBe(
      '{"certNonce":"cert-protected-ticket","contentHash":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","forensic":{"couplingTokenAlgorithm":"hmac-sha256-truncated-v1","recipeVersion":"yucp-protected-blob-forensics-v1","runtime":{"artifactKey":"yucp.coupling.runtime","channel":"stable","metadataVersion":1,"plaintextSha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","platform":"win-x64","version":"2026.03.26.1"}},"packageId":"pkg-protected-ticket","packageVersion":"1.0.0","protectedAssets":[{"displayName":"Protected Blob","protectedAssetId":"46c90a22a12b44fe88fcd9be626bdedb","unlockMode":"content_key_b64"}],"protectedDelivery":{"offlineGraceAllowed":false,"outerFormat":"unitypackage","payloadFormat":"yucp-protected-blob","unlockMode":"live_ticket_only"},"publisherId":"publisher-protected-ticket","schemaVersion":1,"yucpUserId":"auth-protected-ticket"}'
    );

    const signature = await signPackageManifestData?.(manifest, bytesToBase64(rootPrivateKey));

    await expect(
      ed.verifyAsync(
        base64ToBytes(signature ?? ''),
        new TextEncoder().encode(canonical ?? ''),
        rootPublicKey
      )
    ).resolves.toBe(true);
  });

});
