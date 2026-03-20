import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const thisFile = fileURLToPath(import.meta.url);
const thisDir = path.dirname(thisFile);
const docsIndexBundlePath = path.resolve(thisDir, '../../../docs/assets/index/index.js');

describe('docs index bundle', () => {
  it('does not ship unresolved browser runtime package imports', () => {
    const bundle = readFileSync(docsIndexBundlePath, 'utf8');

    expect(bundle).not.toContain('from"react"');
    expect(bundle).not.toContain("from'react'");
    expect(bundle).not.toContain('from"react-dom/client"');
    expect(bundle).not.toContain("from'react-dom/client'");
    expect(bundle).not.toContain('from"three"');
    expect(bundle).not.toContain("from'three'");
    expect(bundle).not.toContain('from"@react-three/fiber"');
    expect(bundle).not.toContain("from'@react-three/fiber'");
    expect(bundle).not.toContain('from"@react-three/drei"');
    expect(bundle).not.toContain("from'@react-three/drei'");
  });
});
