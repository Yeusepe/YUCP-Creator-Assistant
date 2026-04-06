import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const APP_DIR = join(__dirname, '../..');

describe('production server contract', () => {
  it('uses a dedicated production server entry instead of vite preview', () => {
    const packageJson = JSON.parse(readFileSync(join(APP_DIR, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.start).toBe('bun run serve.ts');
    expect(packageJson.scripts?.start).not.toContain('vite preview');
    expect(existsSync(join(APP_DIR, 'serve.ts'))).toBe(true);
  });

  it('keeps the container startup free of vite preview', () => {
    const dockerfile = readFileSync(join(APP_DIR, 'Dockerfile'), 'utf8');

    expect(dockerfile).toContain('bun run start');
    expect(dockerfile).not.toContain('vite preview');
  });

  it('bootstraps runtime secrets before loading the built server', () => {
    const serveSource = readFileSync(join(APP_DIR, 'serve.ts'), 'utf8');

    expect(serveSource).toContain('fetchInfisicalSecrets');
    expect(serveSource).toContain('await bootstrapInfisicalSecrets()');
  });
});
