import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const packageJson = JSON.parse(
  readFileSync(resolve(import.meta.dir, '../../package.json'), 'utf8')
) as { scripts?: Record<string, string> };

describe('package delivery CI platform boundary', () => {
  it('keeps the Windows Unity lifecycle outside the Linux storage aggregate', () => {
    const storageSuite = packageJson.scripts?.['test:storage:e2e'];
    const importerSuite = packageJson.scripts?.['test:importer:e2e'];

    expect(storageSuite).toBeDefined();
    expect(storageSuite).not.toContain('test:importer:e2e');
    expect(importerSuite).toBe('bun run test:vpm-cli:e2e');
  });
});
