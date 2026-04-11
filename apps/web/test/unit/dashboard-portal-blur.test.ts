import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('dashboard portal blur contract', () => {
  it('keeps the root portal mounted with the portal-root class for overlay blur', () => {
    const rootSource = readFileSync(resolve(__dirname, '../../src/routes/__root.tsx'), 'utf8');

    expect(rootSource).toContain('<div id="portal-root" className="portal-root" />');
  });

  it('styles the portal root as a fixed isolated overlay layer', () => {
    const globalsSource = readFileSync(resolve(__dirname, '../../src/styles/globals.css'), 'utf8');

    expect(globalsSource).toContain('.portal-root');
    expect(globalsSource).toContain('position: fixed;');
    expect(globalsSource).toContain('inset: 0;');
    expect(globalsSource).toContain('isolation: isolate;');
    expect(globalsSource).toContain('pointer-events: none;');
    expect(globalsSource).toContain('.portal-root > *');
    expect(globalsSource).toContain('pointer-events: auto;');
  });
});
