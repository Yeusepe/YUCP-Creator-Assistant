import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPackageInstallerTufRoute } from './packageInstallerTuf';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'yucp-tuf-route-'));
  roots.push(root);
  await mkdir(path.join(root, 'metadata'));
  await mkdir(path.join(root, 'targets'));
  await writeFile(path.join(root, 'metadata', 'timestamp.json'), '{"signed":"timestamp"}');
  await writeFile(
    path.join(root, 'targets', `${'44'.repeat(32)}.package-install-trust.json`),
    '{"schemaVersion":1}'
  );
  return { root, route: createPackageInstallerTufRoute(root) };
}

describe('package installer TUF route', () => {
  test('serves exact signed repository bytes with bounded cache policy', async () => {
    const { route } = await fixture();
    const metadata = await route(
      new Request('https://api.example.test/api/v2/package-installer/tuf/metadata/timestamp.json')
    );
    expect(metadata.status).toBe(200);
    expect(await metadata.text()).toBe('{"signed":"timestamp"}');
    expect(metadata.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate');

    const target = await route(
      new Request(
        `https://api.example.test/api/v2/package-installer/tuf/targets/${'44'.repeat(
          32
        )}.package-install-trust.json`
      )
    );
    expect(target.status).toBe(200);
    expect(target.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  });

  test('rejects traversal and methods before any repository read', async () => {
    const { route } = await fixture();
    expect(
      (
        await route(
          new Request(
            'https://api.example.test/api/v2/package-installer/tuf/metadata/%2e%2e/secret'
          )
        )
      ).status
    ).toBe(404);
    expect(
      (
        await route(
          new Request(
            'https://api.example.test/api/v2/package-installer/tuf/metadata/timestamp.json',
            { method: 'POST' }
          )
        )
      ).status
    ).toBe(405);
  });
});
