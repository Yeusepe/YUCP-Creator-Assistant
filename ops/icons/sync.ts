import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { type IconName, iconManifest } from '../../apps/web/src/icons/manifest';
import { getS3Object } from '../storage-core/s3Control';
import { resolveAssetsConfig } from './assetsConfig';
import { createLicensedIconGenerationFingerprint } from './generationFingerprint';
import { renderGeneratedModule } from './renderGeneratedModule';
import { type GeneratedIconData, transformFlexFlatSvg } from './transform';

const ICON_PREFIX = 'icons/flex-flat-style/';
const GENERATED_MODULE_PATH = resolve(import.meta.dir, '../../apps/web/src/icons/generated.tsx');

function validateSourcePath(sourcePath: string): void {
  const segments = sourcePath.split('/');
  if (
    !sourcePath.endsWith('.svg') ||
    sourcePath.startsWith('/') ||
    sourcePath.includes('\\') ||
    sourcePath.includes('?') ||
    sourcePath.includes('#') ||
    segments.some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error(`Invalid icon manifest source path: ${sourcePath}`);
  }
}

async function fetchIcon(
  name: IconName,
  sourcePath: string,
  config: Awaited<ReturnType<typeof resolveAssetsConfig>>
): Promise<[IconName, GeneratedIconData]> {
  validateSourcePath(sourcePath);
  const objectKey = `${ICON_PREFIX}${sourcePath}`;

  try {
    // Backblaze implements S3 GetObject, while request signing and path encoding stay centralized in
    // ops/storage-core/s3Control.ts. https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html
    const response = await getS3Object(config, objectKey);
    const svg = await response.text();
    return [name, transformFlexFlatSvg(svg, name)];
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown icon sync failure';
    throw new Error(`Failed to fetch or transform icon "${name}" at "${sourcePath}": ${message}`);
  }
}

async function main(): Promise<void> {
  const config = await resolveAssetsConfig();
  const generationFingerprint = await createLicensedIconGenerationFingerprint(iconManifest);
  const manifestEntries = Object.entries(iconManifest) as Array<[IconName, string]>;
  const icons = await Promise.all(
    manifestEntries.map(([name, sourcePath]) => fetchIcon(name, sourcePath, config))
  );
  const generatedModule = renderGeneratedModule(icons, generationFingerprint);
  const temporaryPath = `${GENERATED_MODULE_PATH}.${process.pid}.tmp`;

  await mkdir(dirname(GENERATED_MODULE_PATH), { recursive: true });
  try {
    await writeFile(temporaryPath, generatedModule, 'utf8');
    await rename(temporaryPath, GENERATED_MODULE_PATH);
  } finally {
    await rm(temporaryPath, { force: true });
  }

  console.log(`Fetched and transformed ${icons.length} licensed icons.`);
}

if (import.meta.main) {
  await main();
}
