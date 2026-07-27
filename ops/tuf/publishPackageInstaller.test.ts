import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { buildRuntimeDescriptor, verifyPinnedRoot } from './publishPackageInstaller';

describe('package installer TUF root pin', () => {
  test('accepts only the exact lowercase SHA-256 chosen by the offline ceremony', () => {
    const root = Buffer.from('signed root metadata');
    const digest = createHash('sha256').update(root).digest('hex');

    expect(verifyPinnedRoot(root, digest)).toBe(digest);
    expect(() => verifyPinnedRoot(root, '0'.repeat(64))).toThrow('does not match');
    expect(() => verifyPinnedRoot(root, digest.toUpperCase())).toThrow('canonical');
  });
});

describe('package installer signed runtime descriptor', () => {
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
    ).toThrow('must use the package API');
  });
});
