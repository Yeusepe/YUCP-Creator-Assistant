import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('web vite config', () => {
  it('uses a JavaScript runtime entry for shared auth-origin helpers', () => {
    const viteConfigSource = readFileSync(resolve(process.cwd(), 'apps', 'web', 'vite.config.ts'), 'utf8');
    const sharedPackageJson = JSON.parse(
      readFileSync(resolve(process.cwd(), 'packages', 'shared', 'package.json'), 'utf8')
    ) as {
      exports?: Record<string, string>;
    };

    expect(viteConfigSource).toContain(
      "import { buildAllowedBrowserOrigins } from '@yucp/shared/authOrigins-runtime';"
    );
    expect(viteConfigSource).not.toContain("import { buildAllowedBrowserOrigins } from '@yucp/shared/authOrigins';");
    expect(sharedPackageJson.exports?.['./authOrigins-runtime']).toBe('./src/authOrigins-runtime.js');
  });
});
