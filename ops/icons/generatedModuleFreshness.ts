import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { iconManifest } from '../../apps/web/src/icons/manifest';
import { createLicensedIconGenerationFingerprint } from './generationFingerprint';
import { isGeneratedModuleContentFresh } from './renderGeneratedModule';

const GENERATED_MODULE_PATH = resolve(import.meta.dir, '../../apps/web/src/icons/generated.tsx');

export async function isLicensedIconGeneratedModuleFresh(): Promise<boolean> {
  try {
    const [generatedModule, expectedFingerprint] = await Promise.all([
      readFile(GENERATED_MODULE_PATH, 'utf8'),
      createLicensedIconGenerationFingerprint(iconManifest),
    ]);

    return isGeneratedModuleContentFresh(
      generatedModule,
      expectedFingerprint,
      Object.keys(iconManifest)
    );
  } catch {
    return false;
  }
}
