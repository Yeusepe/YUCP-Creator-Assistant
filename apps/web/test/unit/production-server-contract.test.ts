import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const APP_DIR = join(__dirname, '../..');
const REPO_ROOT_DIR = join(APP_DIR, '..', '..');

describe('production server contract', () => {
  it('exposes Cloudflare worker scripts instead of the legacy Bun production server', () => {
    const packageJson = JSON.parse(readFileSync(join(APP_DIR, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.start).toBe('vite preview');
    expect(packageJson.scripts?.['worker:dev']).toContain('prepare-web-worker-env.ts');
    expect(packageJson.scripts?.['worker:preview']).toContain('wrangler dev');
    expect(packageJson.scripts?.['worker:sync:setup']).toContain(
      'setup-infisical-cloudflare-worker-sync.ts'
    );
    expect(packageJson.scripts?.['worker:deploy']).toContain('deploy-web-worker.ts');
    expect(existsSync(join(APP_DIR, 'serve.ts'))).toBe(false);
  });

  it('routes root web development through the Worker bootstrap path', () => {
    const rootPackageJson = JSON.parse(
      readFileSync(join(REPO_ROOT_DIR, 'package.json'), 'utf8')
    ) as {
      scripts?: Record<string, string>;
    };
    const prepareScriptSource = readFileSync(
      join(REPO_ROOT_DIR, 'ops', 'prepare-web-worker-env.ts'),
      'utf8'
    );
    const infisicalWatchSource = readFileSync(
      join(REPO_ROOT_DIR, 'ops', 'run-web-worker-infisical.ts'),
      'utf8'
    );

    expect(rootPackageJson.scripts?.['dev:web']).toContain('worker:dev');
    expect(rootPackageJson.scripts?.['dev:web:infisical']).toContain('run-web-worker-infisical.ts');
    expect(prepareScriptSource).toContain('process.env');
    expect(prepareScriptSource).toContain('hasProcessWorkerBindings');
    expect(prepareScriptSource).toContain('PROCESS_ENV_REFRESH_KEYS');
    expect(prepareScriptSource).toContain('REPO_ROOT_ENV_LOCAL_PATH');
    expect(prepareScriptSource).not.toContain('if (existsSync(WEB_LOCAL_ENV_PATH))');
    expect(infisicalWatchSource).toContain("'infisical'");
    expect(infisicalWatchSource).toContain("'run'");
    expect(infisicalWatchSource).toContain('--watch');
  });

  it('uses wrangler and local worker env files for runtime configuration', () => {
    const viteConfigSource = readFileSync(join(APP_DIR, 'vite.config.ts'), 'utf8');
    const wranglerConfigSource = readFileSync(join(APP_DIR, 'wrangler.jsonc'), 'utf8');
    const rootRouteSource = readFileSync(join(APP_DIR, 'src', 'routes', '__root.tsx'), 'utf8');
    const routerSource = readFileSync(join(APP_DIR, 'src', 'router.tsx'), 'utf8');
    const runtimeConfigSource = readFileSync(
      join(APP_DIR, 'src', 'lib', 'runtimeConfig.tsx'),
      'utf8'
    );
    const runtimeEnvSource = readFileSync(
      join(APP_DIR, 'src', 'lib', 'server', 'runtimeEnv.ts'),
      'utf8'
    );

    expect(viteConfigSource).toContain('@cloudflare/vite-plugin');
    expect(viteConfigSource).toContain('.dev.vars');
    expect(viteConfigSource).toContain('.env.local');
    expect(viteConfigSource).toContain("dedupe: ['react', 'react-dom']");
    expect(viteConfigSource).not.toContain('import.meta.env.CONVEX_URL');
    expect(viteConfigSource).not.toContain('import.meta.env.HYPERDX_API_KEY');
    expect(viteConfigSource).not.toContain('fetchInfisicalSecrets');
    expect(rootRouteSource).toContain('__YUCP_PUBLIC_RUNTIME_CONFIG__');
    expect(rootRouteSource).not.toContain('@/lib/server/runtimeEnv');
    expect(rootRouteSource).toContain('RuntimeConfigProvider');
    expect(routerSource).not.toContain('@/lib/server/runtimeEnv');
    expect(runtimeConfigSource).toContain('convexUrl');
    expect(runtimeConfigSource).toContain('hyperdxApiKey');
    expect(runtimeEnvSource).toContain('Worker runtime started');
    expect(runtimeEnvSource).toContain('import.meta.hot.dispose');
    expect(wranglerConfigSource).toContain('@tanstack/react-start/server-entry');
    expect(wranglerConfigSource).toContain('"name": "creator-assistant-dashboard"');
    expect(wranglerConfigSource).toContain('nodejs_compat');
    expect(wranglerConfigSource).toContain('nodejs_compat_populate_process_env');
  });
});
