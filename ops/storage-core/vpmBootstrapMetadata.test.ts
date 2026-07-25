import { describe, expect, test } from 'bun:test';
import { extractVpmBootstrapMetadataFromDocuments } from './vpmBootstrapMetadata';

describe('VPM bootstrap metadata extraction', () => {
  test('extracts the declared public dependencies and repositories', () => {
    const metadata = extractVpmBootstrapMetadataFromDocuments([
      {
        body: JSON.stringify({
          name: 'jammr',
          version: '2.1.7',
          vpmDependencies: {
            'com.vrcfury.vrcfury': '>=0.0.0',
            'com.yucp.components': '>=0.0.0',
          },
          vpmRepositories: {
            'VRCFury Repo': 'https://vcc.vrcfury.com/',
            'YUCP Components Listing': 'https://vpm.yucp.club/index.json',
          },
        }),
        normalizedPath:
          'Packages/yucp.installed-packages/JAMMR/_temp/YUCP_TempInstall_0123456789abcdef.json',
      },
    ]);

    expect(metadata).toEqual({
      vpmDependencies: {
        'com.vrcfury.vrcfury': '>=0.0.0',
        'com.yucp.components': '>=0.0.0',
      },
      vpmRepositories: {
        'VRCFury Repo': 'https://vcc.vrcfury.com/',
        'YUCP Components Listing': 'https://vpm.yucp.club/index.json',
      },
    });
  });

  test('uses an embedded VPM manifest when no install descriptor exists', () => {
    const metadata = extractVpmBootstrapMetadataFromDocuments([
      {
        body: JSON.stringify({
          name: 'com.example.tool',
          version: '1.0.0',
          vpmDependencies: {
            'com.example.runtime': '2.x',
          },
        }),
        normalizedPath: 'Packages/com.example.tool/package.json',
      },
    ]);

    expect(metadata.vpmDependencies).toEqual({
      'com.example.runtime': '2.x',
    });
    expect(metadata.vpmRepositories).toEqual({});
  });

  test('rejects conflicting dependency declarations', () => {
    expect(() =>
      extractVpmBootstrapMetadataFromDocuments([
        {
          body: JSON.stringify({
            vpmDependencies: {
              'com.example.runtime': '1.x',
            },
          }),
          normalizedPath: 'Assets/YUCP_TempInstall_first.json',
        },
        {
          body: JSON.stringify({
            vpmDependencies: {
              'com.example.runtime': '2.x',
            },
          }),
          normalizedPath:
            'Packages/yucp.installed-packages/Product/_temp/YUCP_TempInstall_second.json',
        },
      ])
    ).toThrow('conflicting VPM dependency');
  });

  test('rejects repository URLs that can target local services', () => {
    expect(() =>
      extractVpmBootstrapMetadataFromDocuments([
        {
          body: JSON.stringify({
            vpmRepositories: {
              unsafe: 'http://127.0.0.1:3000/index.json',
            },
          }),
          normalizedPath: 'Assets/YUCP_TempInstall_unsafe.json',
        },
      ])
    ).toThrow('HTTPS');
  });
});
