/**
 * @vitest-environment node
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadViteConfig() {
  vi.resetModules();
  const module = await import('../../vite.config');
  const config = module.default;
  // Async defineConfig returns a function; resolve it.
  return typeof config === 'function'
    ? await config({ command: 'serve' as const, mode: 'development', isSsrBuild: false })
    : config;
}

describe('web vite allowed hosts', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('allows the configured frontend hostname when api and ui origins differ', async () => {
    vi.stubEnv('SITE_URL', 'http://api.creators.yucp.club');
    vi.stubEnv('FRONTEND_URL', 'https://verify.creators.yucp.club');

    const config = await loadViteConfig();

    expect(config.preview?.allowedHosts).toContain('api.creators.yucp.club');
    expect(config.preview?.allowedHosts).toContain('verify.creators.yucp.club');
  });

  it('keeps localhost hostnames allowed for local web development', async () => {
    vi.stubEnv('SITE_URL', 'http://localhost:3001');
    vi.stubEnv('FRONTEND_URL', 'http://localhost:3000');

    const config = await loadViteConfig();

    expect(config.server?.allowedHosts).toEqual(expect.arrayContaining(['localhost', '127.0.0.1']));
    expect(config.preview?.allowedHosts).toEqual(
      expect.arrayContaining(['localhost', '127.0.0.1'])
    );
  });
});
