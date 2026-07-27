import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { buildRepresentativePackageCorpus } from './packageCorpus';
import { materializePackageCorpusVersion } from './packageCorpusEvaluation';

const scratchPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    scratchPaths.splice(0).map((path) => rm(path, { force: true, recursive: true }))
  );
});

describe('representative package corpus', () => {
  test('builds deterministic multi-product and multi-format version sequences', async () => {
    const first = await mkdtemp(join(tmpdir(), 'yucp-package-corpus-a-'));
    const second = await mkdtemp(join(tmpdir(), 'yucp-package-corpus-b-'));
    scratchPaths.push(first, second);

    const firstManifest = await buildRepresentativePackageCorpus(first);
    const secondManifest = await buildRepresentativePackageCorpus(second);

    expect(firstManifest).toEqual(secondManifest);
    expect(new Set(firstManifest.archives.map((archive) => archive.format))).toEqual(
      new Set(['spp', 'unitypackage', 'zip'])
    );
    expect(new Set(firstManifest.archives.map((archive) => archive.product))).toEqual(
      new Set(['alpha', 'beta'])
    );
    expect(firstManifest.smallFileSizesKiB).toEqual([1, 4, 16, 32, 64]);

    const alphaV1 = firstManifest.archives.find((archive) => archive.fileName === 'alpha.zip');
    const alphaV2 = firstManifest.archives.find((archive) => archive.fileName === 'alpha (1).zip');
    expect(alphaV1).toBeDefined();
    expect(alphaV2).toBeDefined();
    if (!alphaV1 || !alphaV2) {
      throw new Error('The representative corpus is missing the Alpha ZIP sequence');
    }

    const v1Files = unzipSync(new Uint8Array(await readFile(join(first, alphaV1.fileName))));
    const v2Files = unzipSync(new Uint8Array(await readFile(join(first, alphaV2.fileName))));
    expect(v1Files['Assets/Alpha/Small/sixteen.shader']).toBeDefined();
    expect(v2Files['Assets/Alpha/Renamed/sixteen.shader']).toEqual(
      v1Files['Assets/Alpha/Small/sixteen.shader']
    );
    expect(v1Files['Assets/Alpha/Small/sixty-four.shader']?.length).toBe(64 * 1024);
  });

  test('materializes a Unity package with the platform tar implementation', async () => {
    const corpus = await mkdtemp(join(tmpdir(), 'yucp-package-corpus-unity-'));
    const output = await mkdtemp(join(tmpdir(), 'yucp-package-corpus-logical-'));
    scratchPaths.push(corpus, output);
    await buildRepresentativePackageCorpus(corpus);

    const materialized = await materializePackageCorpusVersion({
      archivePath: join(corpus, 'alpha.unitypackage'),
      format: 'unitypackage',
      outputRoot: output,
    });

    expect(
      materialized.files.some(
        (file) => file.relativePath === 'Assets/Alpha/Small/sixty-four.shader'
      )
    ).toBe(true);
  });
});
