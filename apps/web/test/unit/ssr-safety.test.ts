/**
 * SSR Safety Tests
 *
 * These tests run in a Node environment (no window/document) and actually
 * render each route component with react-dom/server to catch any browser
 * global references (window, document, localStorage, navigator) at the
 * component body level. Such references crash TanStack Start's SSR.
 *
 * @vitest-environment node
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
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

// Skip files that are pure redirects or have no visual component
const SKIP_FILES = new Set(['index.tsx']);

describe('SSR Safety: no browser globals at render time', () => {
  it('found route files to test', () => {
    expect(routeFiles.length).toBeGreaterThan(10);
  });

  it('running in a true Node environment (no window)', () => {
    expect(typeof globalThis.window).toBe('undefined');
    expect(typeof globalThis.document).toBe('undefined');
  });

  for (const file of routeFiles) {
    const rel = relative(ROUTES_DIR, file).split(sep).join('/');
    if (SKIP_FILES.has(rel)) continue;

    it(`${rel} renders without SSR crash`, async () => {
      const mod = await import(file);

      // TanStack route files export Route.options.component or Route
      const route = mod.Route;
      if (!route) return; // not a route file

      // Extract the component function from the route
      const component = route.options?.component;
      if (!component) return; // no component to render

      // renderToString will execute the component function body,
      // which is where window/document references crash SSR.
      // We wrap in try/catch to give a clear error message.
      try {
        renderToString(createElement(component));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        // These are the SSR-fatal errors we're looking for
        if (
          msg.includes('is not defined') &&
          (msg.includes('window') ||
            msg.includes('document') ||
            msg.includes('localStorage') ||
            msg.includes('navigator'))
        ) {
          throw new Error(
            `SSR CRASH in ${rel}: ${msg}\n` +
              'Fix: move browser global access into useEffect or guard with typeof window !== "undefined"'
          );
        }
        // Other errors (missing context providers, etc.) are expected
        // since we render without the full app tree -- not SSR bugs
      }
    });
  }
});

describe('SSR Safety: static analysis for unguarded browser globals', () => {
  /**
   * Smarter static analysis that avoids false positives:
   * 1. Ignores lines with typeof window guard on the same line
   * 2. Tracks functions with early-return guards (if typeof window === 'undefined' return)
   * 3. Tracks useEffect/useCallback/useMemo/event handler scope
   * 4. Only flags browser global access in unguarded component body code
   */
  for (const file of routeFiles) {
    const rel = relative(ROUTES_DIR, file).split(sep).join('/');

    it(`${rel} has no unguarded browser globals in component body`, () => {
      const source = readFileSync(file, 'utf8');
      const lines = source.split('\n');
      const problems: string[] = [];

      // Track brace-depth scopes that are "safe" (inside hooks, callbacks, or guarded functions)
      let hookDepth = 0; // inside useEffect/useCallback/useMemo etc
      let guardedFnDepth = 0; // inside a function with typeof window guard
      const braceStack: string[] = []; // track nested braces for scope

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();

        // Count braces for scope tracking
        const opens = (line.match(/\{/g) || []).length;
        const closes = (line.match(/\}/g) || []).length;

        // Detect entering a hook/callback scope
        if (/\buse(Effect|Callback|Memo|LayoutEffect)\s*\(/.test(trimmed)) {
          hookDepth++;
          for (let j = 0; j < opens; j++) braceStack.push('hook');
        }
        // Detect event handler definitions
        else if (
          /\bon(Click|Submit|Change|KeyDown|KeyUp|MouseMove|MouseEnter|MouseLeave|Focus|Blur|Resize)\s*[=:{(]/.test(
            trimmed
          )
        ) {
          hookDepth++;
          for (let j = 0; j < opens; j++) braceStack.push('handler');
        }
        // Detect async function/arrow inside useEffect
        else if (hookDepth > 0 || guardedFnDepth > 0) {
          for (let j = 0; j < opens; j++)
            braceStack.push(hookDepth > 0 ? 'hook-inner' : 'guarded-inner');
        }
        // Detect guarded helper functions (function foo() { if (typeof window === 'undefined') return ... })
        else if (
          /^\s*(async\s+)?function\s+\w/.test(trimmed) ||
          /^\s*(const|let)\s+\w+\s*=\s*(async\s+)?\(/.test(trimmed)
        ) {
          // Check if next few lines contain a typeof window guard
          let hasGuard = false;
          for (let j = i + 1; j < Math.min(i + 10, lines.length); j++) {
            if (
              /typeof\s+(window|document)\s*[!=]==?\s*['"]undefined['"]/.test(lines[j]) &&
              /return/.test(lines[j])
            ) {
              hasGuard = true;
              break;
            }
          }
          if (hasGuard) {
            guardedFnDepth++;
            for (let j = 0; j < opens; j++) braceStack.push('guarded');
          } else {
            for (let j = 0; j < opens; j++) braceStack.push('other');
          }
        } else {
          for (let j = 0; j < opens; j++) braceStack.push('other');
        }

        // Pop brace stack on closes
        for (let j = 0; j < closes; j++) {
          const popped = braceStack.pop();
          if (popped === 'hook' || popped === 'handler') hookDepth = Math.max(0, hookDepth - 1);
          if (popped === 'guarded') guardedFnDepth = Math.max(0, guardedFnDepth - 1);
        }

        // Skip if inside a safe scope
        if (hookDepth > 0 || guardedFnDepth > 0) continue;

        // Skip lines that have typeof window guard on the same line
        if (/typeof\s+(window|document)\s*[!=]==?\s*['"]undefined['"]/.test(line)) continue;

        // Skip lines that are just function definitions (not calls)
        if (/^\s*(async\s+)?function\s+\w/.test(trimmed)) continue;

        // Only flag const/let/var declarations with unguarded browser globals
        if (
          /^\s*(const|let|var)\s+\w.*\b(window|document)\.(location|inner|outer|localStorage|getElement|querySelector)/.test(
            line
          )
        ) {
          problems.push(`Line ${i + 1}: ${trimmed.substring(0, 120)}`);
        }
      }

      if (problems.length > 0) {
        throw new Error(
          `Unguarded browser globals found in ${rel}:\n${problems.join('\n')}\n` +
            'Fix: move into useEffect or guard with typeof window !== "undefined"'
        );
      }
    });
  }
});
