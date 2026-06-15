import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { normalizeGeneratedSource } from './generatedPostprocess';

type PrivateRpcPackageJson = {
  scripts?: Record<string, string>;
};

type BebopConfig = {
  include?: string[];
};

function readJsonFile<T>(relativePath: string): T {
  const filePath = resolve(import.meta.dir, '..', relativePath);
  return JSON.parse(readFileSync(filePath, 'utf8')) as T;
}

describe('private-rpc generation config', () => {
  it('builds from the deterministic combined schema after preprocessing', () => {
    const packageJson = readJsonFile<PrivateRpcPackageJson>('package.json');
    const bebopConfig = readJsonFile<BebopConfig>('bebop.json');

    expect(packageJson.scripts?.generate).toContain('bun run ./scripts/preprocess-schemas.ts &&');
    expect(bebopConfig.include).toEqual(['schema/combined.bop']);
  });

  it('normalizes generated TypeScript to LF when adding the ts-nocheck banner', () => {
    const source = 'export const value = 1;\r\nexport const other = 2;\r\n';

    expect(normalizeGeneratedSource(source)).toBe(
      '// @ts-nocheck\nexport const value = 1;\nexport const other = 2;\n'
    );
  });

  it('normalizes generated TypeScript with bare CR line endings', () => {
    const source = 'export const value = 1;\rexport const other = 2;\r';

    expect(normalizeGeneratedSource(source)).toBe(
      '// @ts-nocheck\nexport const value = 1;\nexport const other = 2;\n'
    );
  });

  it('does not duplicate an existing ts-nocheck banner', () => {
    const source = '// @ts-nocheck\r\nexport const value = 1;\r\n';

    expect(normalizeGeneratedSource(source)).toBe('// @ts-nocheck\nexport const value = 1;\n');
  });
});
