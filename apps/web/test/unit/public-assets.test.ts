import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC_DIR = join(__dirname, '../../src');
const PUBLIC_DIR = join(__dirname, '../../public');

function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stats = statSync(fullPath);

    if (stats.isDirectory()) {
      files.push(...collectSourceFiles(fullPath));
      continue;
    }

    if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
      files.push(fullPath);
    }
  }

  return files;
}

describe('public asset references', () => {
  it('keeps every /Icons reference owned by the web app public directory', () => {
    const iconReferences = new Map<string, string[]>();
    const sourceFiles = collectSourceFiles(SRC_DIR);

    for (const file of sourceFiles) {
      const source = readFileSync(file, 'utf8');
      const relPath = relative(SRC_DIR, file).split(sep).join('/');
      const matches = source.matchAll(/['"`](\/Icons\/[^'"`]+)['"`]/g);

      for (const match of matches) {
        const publicPath = match[1];
        if (publicPath.includes('${')) {
          continue;
        }
        const existingRefs = iconReferences.get(publicPath) ?? [];
        existingRefs.push(relPath);
        iconReferences.set(publicPath, existingRefs);
      }
    }

    expect(iconReferences.size).toBeGreaterThan(0);

    const missingAssets = [...iconReferences.entries()]
      .filter(([publicPath]) => !existsSync(join(PUBLIC_DIR, publicPath.slice(1))))
      .map(([publicPath, refs]) => `${publicPath} referenced by ${refs.join(', ')}`);

    expect(missingAssets).toEqual([]);
  });
});
