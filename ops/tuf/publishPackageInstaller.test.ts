import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  buildRuntimeDescriptor,
  resolvePackageInstallerPublicationEnv,
  verifyPinnedRoot,
} from './publishPackageInstaller';

describe('package installer TUF root pin', () => {
  test('accepts only the exact lowercase SHA-256 chosen by the offline ceremony', () => {
    const root = Buffer.from('signed root metadata');
    const digest = createHash('sha256').update(root).digest('hex');

    expect(verifyPinnedRoot(root, digest)).toBe(digest);
    expect(() => verifyPinnedRoot(root, '0'.repeat(64))).toThrow('does not match');
    expect(() => verifyPinnedRoot(root, digest.toUpperCase())).toThrow('canonical');
  });
});

describe('package installer offline publication environment', () => {
  test('keeps online-role private keys in the explicit offline invocation', async () => {
    const source = {
      CATALOG_DATABASE_URL: 'postgresql://catalog.example.test:30400/yucp',
      MATERIALIZATION_RECEIPT_KEY_ID: 'receipt-key',
      MATERIALIZATION_RECEIPT_PUBLIC_KEY: 'receipt-public-key',
      PACKAGE_INSTALL_SIGNING_KEY_ID: 'install-key',
      PACKAGE_INSTALL_SIGNING_PUBLIC_KEY: 'install-public-key',
      YUCP_TUF_SNAPSHOT_PRIVATE_KEY: 'snapshot-private-key',
      YUCP_TUF_TARGETS_PRIVATE_KEY: 'targets-private-key',
      YUCP_TUF_TIMESTAMP_PRIVATE_KEY: 'timestamp-private-key',
    };
    let requestedKeys: readonly string[] = [];
    const resolved = await resolvePackageInstallerPublicationEnv(
      source,
      async (env, keys) => {
        requestedKeys = keys;
        return {
          ...env,
          CATALOG_DATABASE_URL: 'postgresql://catalog.internal/yucp',
        };
      }
    );

    expect(requestedKeys).not.toContain('YUCP_TUF_TARGETS_PRIVATE_KEY');
    expect(requestedKeys).not.toContain('MATERIALIZATION_RECEIPT_PUBLIC_KEY');
    expect(resolved.CATALOG_DATABASE_URL).toBe(
      'postgresql://catalog.example.test:30400/yucp'
    );
    expect(resolved.YUCP_TUF_TARGETS_PRIVATE_KEY).toBe('targets-private-key');
    expect(resolved.YUCP_TUF_SNAPSHOT_PRIVATE_KEY).toBe('snapshot-private-key');
    expect(resolved.YUCP_TUF_TIMESTAMP_PRIVATE_KEY).toBe('timestamp-private-key');
    expect(resolved.MATERIALIZATION_RECEIPT_PUBLIC_KEY).toBe('receipt-public-key');
  });
});

describe('package installer signed runtime descriptor', () => {
  test('allows the signed TUF repository to use a different origin from the protected API', () => {
    expect(
      JSON.parse(
        buildRuntimeDescriptor({
          apiBaseUrl: 'https://api.example.test',
          authBaseUrl: 'https://dashboard.example.test/api/auth',
          metadataUrl: 'https://dashboard.example.test/api/v2/package-installer/tuf/metadata',
          targetsUrl: 'https://dashboard.example.test/api/v2/package-installer/tuf/targets',
        }).toString('utf8')
      )
    ).toMatchObject({
      apiBaseUrl: 'https://api.example.test',
      authBaseUrl: 'https://dashboard.example.test/api/auth',
      metadataUrl: 'https://dashboard.example.test/api/v2/package-installer/tuf/metadata',
      targetsUrl: 'https://dashboard.example.test/api/v2/package-installer/tuf/targets',
    });
  });

  test('fixes executable targets and rejects mutable or insecure endpoint values', () => {
    expect(
      JSON.parse(
        buildRuntimeDescriptor({
          apiBaseUrl: 'https://api.example.test',
          authBaseUrl: 'https://auth.example.test/api/auth',
          metadataUrl: 'https://api.example.test/api/v2/package-installer/tuf/metadata',
          targetsUrl: 'https://api.example.test/api/v2/package-installer/tuf/targets',
        }).toString('utf8')
      )
    ).toEqual({
      apiBaseUrl: 'https://api.example.test',
      authBaseUrl: 'https://auth.example.test/api/auth',
      brokerTarget: 'broker/windows-amd64/yucp-package-broker.exe',
      helperTarget: 'helper/windows-amd64/yucp-transfer-helper.exe',
      metadataUrl: 'https://api.example.test/api/v2/package-installer/tuf/metadata',
      pipeName: String.raw`\\.\pipe\yucp.package-broker.v1`,
      platform: 'windows-amd64',
      schemaVersion: 1,
      targetsUrl: 'https://api.example.test/api/v2/package-installer/tuf/targets',
      trustTarget: 'package-install-trust.json',
    });
    expect(() =>
      buildRuntimeDescriptor({
        apiBaseUrl: 'http://api.example.test',
        authBaseUrl: 'https://auth.example.test/api/auth',
        metadataUrl: 'https://api.example.test/api/v2/package-installer/tuf/metadata',
        targetsUrl: 'https://api.example.test/api/v2/package-installer/tuf/targets',
      })
    ).toThrow('HTTPS');
    expect(() =>
      buildRuntimeDescriptor({
        apiBaseUrl: 'https://api.example.test/',
        authBaseUrl: 'https://auth.example.test/api/auth',
        metadataUrl: 'https://api.example.test/api/v2/package-installer/tuf/metadata',
        targetsUrl: 'https://api.example.test/api/v2/package-installer/tuf/targets',
      })
    ).toThrow('canonical');
    expect(() =>
      buildRuntimeDescriptor({
        apiBaseUrl: 'https://api.example.test',
        authBaseUrl: 'https://auth.example.test/api/auth',
        metadataUrl: 'https://other.example.test/metadata',
        targetsUrl: 'https://api.example.test/api/v2/package-installer/tuf/targets',
      })
    ).toThrow('signed repository routes');
  });
});
