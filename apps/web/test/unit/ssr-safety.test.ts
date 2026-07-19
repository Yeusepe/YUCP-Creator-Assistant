/**
 * SSR safety tests execute every route in a true Node environment. Module
 * evaluation catches browser globals at import time, while server rendering
 * catches browser globals used from component bodies.
 *
 * @vitest-environment node
 */

import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

const ROUTES_DIR = join(__dirname, '../../src/routes');

function collectRouteFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      results.push(...collectRouteFiles(full));
    } else if (entry.endsWith('.tsx') && !entry.startsWith('__')) {
      results.push(full);
    }
  }
  return results;
}

const routeFiles = collectRouteFiles(ROUTES_DIR);
const SKIP_RENDER_FILES = new Set(['index.tsx']);

describe('SSR Safety: route module evaluation', () => {
  it('found route files to test', () => {
    expect(routeFiles.length).toBeGreaterThan(10);
  });

  it('runs in a true Node environment without browser globals', () => {
    expect(typeof globalThis.window).toBe('undefined');
    expect(typeof globalThis.document).toBe('undefined');
  });

  for (const file of routeFiles) {
    const rel = relative(ROUTES_DIR, file).split(sep).join('/');

    it(`${rel} loads without browser globals`, async () => {
      const routeModule = await import(file);
      expect(routeModule.Route).toBeDefined();
    });
  }
});

describe('SSR Safety: route component rendering', () => {
  for (const file of routeFiles) {
    const rel = relative(ROUTES_DIR, file).split(sep).join('/');
    if (SKIP_RENDER_FILES.has(rel)) continue;

    it(`${rel} renders without SSR browser-global crashes`, async () => {
      const routeModule = await import(file);
      const route = routeModule.Route;
      const component = route?.options?.component;
      if (!component) return;

      try {
        renderToString(createElement(component));
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        if (
          message.includes('is not defined') &&
          (message.includes('window') ||
            message.includes('document') ||
            message.includes('localStorage') ||
            message.includes('navigator'))
        ) {
          throw new Error(`SSR browser-global crash in ${rel}: ${message}`);
        }
      }
    });
  }
});
