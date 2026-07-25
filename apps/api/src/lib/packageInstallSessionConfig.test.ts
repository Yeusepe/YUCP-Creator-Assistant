import { describe, expect, test } from 'bun:test';
import { loadPackageInstallSessionConfig } from './packageInstallSessionConfig';

describe('package install session configuration', () => {
  test('loads a strict Ed25519 signing seed and origin bindings', () => {
    const privateKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
    expect(
      loadPackageInstallSessionConfig({
        PACKAGE_DELIVERY_AUDIENCE: 'https://delivery.example.test',
        PACKAGE_INSTALL_ISSUER: 'https://api.example.test',
        PACKAGE_INSTALL_SIGNING_KEY_ID: 'package-install-2026-01',
        PACKAGE_INSTALL_SIGNING_PRIVATE_KEY: Buffer.from(privateKey).toString('base64url'),
      })
    ).toEqual({
      audience: 'https://delivery.example.test',
      issuer: 'https://api.example.test',
      keyId: 'package-install-2026-01',
      privateKey,
    });
  });

  test('returns null only when the complete feature is unconfigured', () => {
    expect(loadPackageInstallSessionConfig({})).toBeNull();
  });

  test('rejects partial or malformed configuration', () => {
    expect(() =>
      loadPackageInstallSessionConfig({
        PACKAGE_DELIVERY_AUDIENCE: 'https://delivery.example.test',
      })
    ).toThrow('must be configured together');
    expect(() =>
      loadPackageInstallSessionConfig({
        PACKAGE_DELIVERY_AUDIENCE: 'https://delivery.example.test/path',
        PACKAGE_INSTALL_ISSUER: 'https://api.example.test',
        PACKAGE_INSTALL_SIGNING_KEY_ID: 'package-install-2026-01',
        PACKAGE_INSTALL_SIGNING_PRIVATE_KEY: Buffer.alloc(32, 1).toString('base64url'),
      })
    ).toThrow('origin');
    expect(() =>
      loadPackageInstallSessionConfig({
        PACKAGE_DELIVERY_AUDIENCE: 'https://delivery.example.test',
        PACKAGE_INSTALL_ISSUER: 'https://api.example.test',
        PACKAGE_INSTALL_SIGNING_KEY_ID: 'package-install-2026-01',
        PACKAGE_INSTALL_SIGNING_PRIVATE_KEY: Buffer.alloc(31, 1).toString('base64url'),
      })
    ).toThrow('32-byte');
  });
});
