import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROUTES_DIR = join(__dirname, '../../src/routes');

function collectRouteFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      results.push(...collectRouteFiles(full));
      continue;
    }
    if (entry.endsWith('.tsx')) {
      results.push(full);
    }
  }
  return results;
}

const routeFiles = collectRouteFiles(ROUTES_DIR);

describe('Route architecture', () => {
  it('does not globally import page-specific stylesheets from route modules', () => {
    const offenders: string[] = [];

    for (const file of routeFiles) {
      const rel = relative(ROUTES_DIR, file).split(sep).join('/');
      const source = readFileSync(file, 'utf8');

      const matches = source.match(/import\s+['"]@\/styles\/([^'"]+\.css)(?!\?url)['"];?/g) ?? [];
      const disallowed = matches.filter(
        (value) =>
          !value.includes('@/styles/tokens.css') &&
          !value.includes('@/styles/loading.css') &&
          !value.includes('@/styles/globals.css')
      );

      if (disallowed.length > 0) {
        offenders.push(`${rel}: ${disallowed.join(', ')}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('does not leave bare cloud mount placeholders that depend on the old site boot script', () => {
    const offenders: string[] = [];

    for (const file of routeFiles) {
      const rel = relative(ROUTES_DIR, file).split(sep).join('/');
      const source = readFileSync(file, 'utf8');

      if (!source.includes('id="bg-canvas-root"')) continue;

      const hasCloudMount =
        source.includes('CloudBackground') ||
        source.includes('CloudBackgroundLayer') ||
        source.includes('BackgroundCanvasRoot');

      if (!hasCloudMount) {
        offenders.push(rel);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('does not ship removed sticker placeholders or sticker classes in route markup', () => {
    const offenders: string[] = [];
    const stickerClassPattern = /className\s*=\s*["'`][^"'`]*\bsticker\b/;

    for (const file of routeFiles) {
      const rel = relative(ROUTES_DIR, file).split(sep).join('/');
      const source = readFileSync(file, 'utf8');

      if (source.includes('id="holo-') || stickerClassPattern.test(source)) {
        offenders.push(rel);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('does not nest button elements inside other buttons', () => {
    const offenders: string[] = [];

    for (const file of routeFiles) {
      const rel = relative(ROUTES_DIR, file).split(sep).join('/');
      const source = readFileSync(file, 'utf8');
      const buttonTagPattern = /<\/?button\b[^>]*>/g;
      let depth = 0;

      for (const match of source.matchAll(buttonTagPattern)) {
        const token = match[0];

        if (token.startsWith('</button')) {
          depth = Math.max(0, depth - 1);
          continue;
        }

        if (depth > 0) {
          offenders.push(rel);
          break;
        }

        if (!token.endsWith('/>')) {
          depth += 1;
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
