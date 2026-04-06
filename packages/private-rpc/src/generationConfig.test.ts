import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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
});
