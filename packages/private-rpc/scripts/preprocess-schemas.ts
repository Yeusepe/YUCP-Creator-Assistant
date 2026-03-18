/**
 * Combines all .bop schema files alphabetically into a single file.
 * This ensures bebopc processes types in the same order on all platforms
 * regardless of OS-specific readdir ordering (ext4 vs NTFS differ).
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const schemaDir = resolve(import.meta.dir, '../schema');
const outputFile = resolve(schemaDir, 'combined.bop');

const files = readdirSync(schemaDir)
  .filter(f => f.endsWith('.bop') && f !== 'combined.bop')
  .sort();

const combined = files
  .map(f => readFileSync(join(schemaDir, f), 'utf8').trim())
  .join('\n\n');

writeFileSync(outputFile, combined + '\n');
