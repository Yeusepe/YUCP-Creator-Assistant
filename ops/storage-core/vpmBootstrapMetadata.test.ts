import { describe, expect, test } from 'bun:test';
import { extractVpmBootstrapMetadataFromDocuments } from './vpmBootstrapMetadata';

describe('VPM bootstrap metadata extraction', () => {
  test('extracts the declared public dependencies and repositories', () => {
    const metadata = extractVpmBootstrapMetadataFromDocuments([
      {
        body: JSON.stringify({
          name: 'jammr',
          displayName: 'JAMMR',
          version: '2.1.7',
          description: 'Cover to start a Spotify jam.',
          author: { name: 'YUCP Studio' },
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
      packageMetadata: {
        author: 'YUCP Studio',
        description: 'Cover to start a Spotify jam.',
        packageName: 'JAMMR',
        version: '2.1.7',
      },
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
          displayName: 'Example Tool',
          version: '1.0.0',
          description: 'Example tool package.',
          author: { name: 'Example Studio' },
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
    expect(metadata.packageMetadata).toEqual({
      author: 'Example Studio',
      description: 'Example tool package.',
      packageName: 'Example Tool',
      version: '1.0.0',
    });
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

  test('normalizes official VCC repository URLs with query flags', () => {
    const metadata = extractVpmBootstrapMetadataFromDocuments([
      {
        body: JSON.stringify({
          vpmRepositories: {
            'VRChat Curated': ' HTTPS://PACKAGES.VRCHAT.COM:443/curated?zeta&download ',
            'VRChat Official': 'https://packages.vrchat.com/official?download',
          },
        }),
        normalizedPath: 'Assets/YUCP_TempInstall_vrchat.json',
      },
    ]);

    expect(metadata.vpmRepositories).toEqual({
      'VRChat Curated': 'https://packages.vrchat.com/curated?download&zeta',
      'VRChat Official': 'https://packages.vrchat.com/official?download',
    });
  });

  test('rejects repository query values, duplicates, unsafe names, and excessive flags', () => {
    for (const url of [
      'https://packages.example.test/index.json?token=secret',
      'https://packages.example.test/index.json?download=',
      'https://packages.example.test/index.json?download&download',
      'https://packages.example.test/index.json?down%2Fload',
      'https://packages.example.test/index.json?1download',
      `https://packages.example.test/index.json?${'x'.repeat(65)}`,
      'https://packages.example.test/index.json?a&b&c&d&e&f&g&h&i',
    ]) {
      expect(() =>
        extractVpmBootstrapMetadataFromDocuments([
          {
            body: JSON.stringify({
              vpmRepositories: {
                unsafe: url,
              },
            }),
            normalizedPath: 'Assets/YUCP_TempInstall_unsafe-query.json',
          },
        ])
      ).toThrow('query');
    }
  });

  test('rejects unsafe repository schemes, credentials, and fragments', () => {
    for (const url of [
      'file:///etc/passwd',
      'ftp://packages.example.test/index.json',
      'https://user:password@packages.example.test/index.json',
      'https://packages.example.test/index.json#override',
    ]) {
      expect(() =>
        extractVpmBootstrapMetadataFromDocuments([
          {
            body: JSON.stringify({
              vpmRepositories: {
                unsafe: url,
              },
            }),
            normalizedPath: 'Assets/YUCP_TempInstall_unsafe.json',
          },
        ])
      ).toThrow('HTTPS');
    }
  });

  test('rejects unsafe and oversized presentation metadata', () => {
    expect(() =>
      extractVpmBootstrapMetadataFromDocuments([
        {
          body: JSON.stringify({
            displayName: '../Unsafe',
            version: '1.0.0',
            author: { name: 'Example Studio' },
          }),
          normalizedPath: 'Packages/com.example.tool/package.json',
        },
      ])
    ).toThrow('package name');

    expect(() =>
      extractVpmBootstrapMetadataFromDocuments([
        {
          body: JSON.stringify({
            displayName: 'Example Tool',
            version: '1.0.0',
            description: 'x'.repeat(501),
            author: { name: 'Example Studio' },
          }),
          normalizedPath: 'Packages/com.example.tool/package.json',
        },
      ])
    ).toThrow('description');
  });
});
