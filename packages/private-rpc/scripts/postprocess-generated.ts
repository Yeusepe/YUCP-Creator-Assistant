import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { normalizeGeneratedSource } from '../src/generatedPostprocess';

const generatedPath = resolve(import.meta.dir, '../src/generated.ts');

function main() {
  const source = readFileSync(generatedPath, 'utf8');
  const normalized = normalizeGeneratedSource(source);
  if (normalized !== source) {
    writeFileSync(generatedPath, normalized);
  }
}

if (import.meta.main) {
  main();
}
