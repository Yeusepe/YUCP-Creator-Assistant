import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  collectFixturePackages,
  parseAddRepoUrl,
  resolveBackstageRepoTestConfig,
  runBackstageRepoSmokeTest,
} from './test-backstage-repo';

describe('test-backstage-repo', () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it('parses a VCC add-repo url into the repository url and auth headers', () => {
    expect(
      parseAddRepoUrl(
        'vcc://vpm/addRepo?url=https%3A%2F%2Frepo.test%2Findex.json&headers%5B%5D=X-YUCP-Repo-Token%3Aybt_example&headers%5B%5D=X-Extra%3Avalue'
      )
    ).toEqual({
      repositoryHeaders: {
        'X-Extra': 'value',
        'X-YUCP-Repo-Token': 'ybt_example',
      },
      repositoryUrl: 'https://repo.test/index.json',
    });
  });

  it('collects package fixture labels and versions from a configurable directory', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'backstage-repo-fixtures-'));
    writeFileSync(join(tempDir, 'Song Thing_1.0.6.unitypackage'), Buffer.from('fixture-a'));
    writeFileSync(join(tempDir, 'JAMMR_2.1.5.unitypackage'), Buffer.from('fixture-b'));

    expect(collectFixturePackages(tempDir)).toEqual([
      {
        fileName: 'JAMMR_2.1.5.unitypackage',
        label: 'JAMMR',
        version: '2.1.5',
      },
      {
        fileName: 'Song Thing_1.0.6.unitypackage',
        label: 'Song Thing',
        version: '1.0.6',
      },
    ]);
  });

  it('resolves config from an add-repo url and environment-backed fixture directory', () => {
    const packageDir = join(tmpdir(), 'fixtures');
    const config = resolveBackstageRepoTestConfig(
      [
        '--addRepoUrl',
        'vcc://vpm/addRepo?url=https%3A%2F%2Frepo.test%2Findex.json&headers%5B%5D=X-YUCP-Repo-Token%3Aybt_example',
      ],
      {
        YUCP_BACKSTAGE_PACKAGE_DIR: packageDir,
      } as NodeJS.ProcessEnv
    );

    expect(config).toEqual({
      packageDir: resolve(packageDir),
      repositoryHeaders: {
        'X-YUCP-Repo-Token': 'ybt_example',
      },
      repositoryUrl: 'https://repo.test/index.json',
    });
  });

  it('fetches the repo document, checks package endpoints, and matches fixture labels by displayName and version', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'backstage-repo-smoke-'));
    writeFileSync(join(tempDir, 'Song Thing_1.0.6.unitypackage'), Buffer.from('fixture-a'));

    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      const headers = new Headers(init?.headers);
      calls.push({
        url,
        headers: Object.fromEntries(headers.entries()),
      });

      if (url === 'https://repo.test/index.json') {
        return Response.json({
          name: 'Backstage Repos',
          packages: {
            'com.yucp.songthing': {
              versions: {
                '1.0.6': {
                  name: 'com.yucp.songthing',
                  version: '1.0.6',
                  displayName: 'Song Thing',
                  url: 'https://repo.test/package?packageId=com.yucp.songthing&version=1.0.6&channel=stable',
                  headers: {
                    'X-YUCP-Repo-Token': 'ybt_example',
                  },
                },
              },
            },
          },
        });
      }

      if (url === 'https://repo.test/package?packageId=com.yucp.songthing&version=1.0.6&channel=stable') {
        return new Response(null, {
          status: 302,
          headers: {
            location: 'https://downloads.test/song-thing-1.0.6.zip',
          },
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    };

    const result = await runBackstageRepoSmokeTest(
      {
        packageDir: tempDir,
        repositoryHeaders: {
          'X-YUCP-Repo-Token': 'ybt_example',
        },
        repositoryUrl: 'https://repo.test/index.json',
      },
      fetchImpl
    );

    expect(result).toEqual({
      checkedPackageUrls: [
        'https://repo.test/package?packageId=com.yucp.songthing&version=1.0.6&channel=stable',
      ],
      fixtureMatches: [
        {
          fileName: 'Song Thing_1.0.6.unitypackage',
          label: 'Song Thing',
          packageId: 'com.yucp.songthing',
          version: '1.0.6',
        },
      ],
      repositoryPackageCount: 1,
      repositoryUrl: 'https://repo.test/index.json',
    });
    expect(calls).toEqual([
      {
        url: 'https://repo.test/index.json',
        headers: {
          'x-yucp-repo-token': 'ybt_example',
        },
      },
      {
        url: 'https://repo.test/package?packageId=com.yucp.songthing&version=1.0.6&channel=stable',
        headers: {
          'x-yucp-repo-token': 'ybt_example',
        },
      },
    ]);
  });
});
