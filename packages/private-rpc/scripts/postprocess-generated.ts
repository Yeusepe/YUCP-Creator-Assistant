import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const generatedPath = resolve(import.meta.dir, '../src/generated.ts');
const source = readFileSync(generatedPath, 'utf8');

if (!source.startsWith('// @ts-nocheck')) {
  writeFileSync(generatedPath, `// @ts-nocheck\n${source}`);
}
