import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const GENERATION_SOURCE_DEFINITIONS = [
  ['ops/icons/renderGeneratedModule.ts', new URL('./renderGeneratedModule.ts', import.meta.url)],
  ['ops/icons/transform.ts', new URL('./transform.ts', import.meta.url)],
] as const;

type IconManifest = Readonly<Record<string, string>>;

function normalizeSource(source: string): string {
  return source.replaceAll('\r\n', '\n');
}

function compareManifestEntries(
  [leftName]: readonly [string, string],
  [rightName]: readonly [string, string]
): number {
  if (leftName < rightName) {
    return -1;
  }
  if (leftName > rightName) {
    return 1;
  }
  return 0;
}

export async function createLicensedIconGenerationFingerprint(
  manifest: IconManifest
): Promise<string> {
  const generationSources = await Promise.all(
    GENERATION_SOURCE_DEFINITIONS.map(async ([sourcePath, sourceUrl]) => [
      sourcePath,
      normalizeSource(await readFile(sourceUrl, 'utf8')),
    ])
  );
  const inputs = {
    fingerprintVersion: 1,
    generationSources,
    manifest: Object.entries(manifest).sort(compareManifestEntries),
  };

  return createHash('sha256').update(JSON.stringify(inputs)).digest('hex');
}
