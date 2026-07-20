import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getWebBuildCommand } from './deploy-web-worker';

describe('Cloudflare Workers Builds contract', () => {
  test('exposes clean-checkout commands that install dependencies with build secrets', () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')
    ) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.['icons:sync']).toBe(
      'bun run --env-file=.env.infisical ops/icons/sync.ts'
    );
    expect(packageJson.scripts?.['cloudflare:worker:deploy']).toBe(
      'bun install --frozen-lockfile && bun run --filter @yucp/web worker:deploy -- --prod'
    );
    expect(packageJson.scripts?.['cloudflare:worker:version:upload']).toBe(
      'bun install --frozen-lockfile && bun run --filter @yucp/web worker:version:upload'
    );
  });

  test('regenerates licensed icons through the shared web build used by every deploy path', () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(process.cwd(), 'apps', 'web', 'package.json'), 'utf8')
    ) as {
      scripts?: Record<string, string>;
    };
    const versionUploadSource = readFileSync(
      resolve(process.cwd(), 'ops', 'upload-web-worker-version.ts'),
      'utf8'
    );

    expect(packageJson.scripts?.build).toBe('bun run --cwd ../.. icons:sync && vite build');
    expect(getWebBuildCommand()).toEqual(['bun', 'run', '--filter', '@yucp/web', 'build']);
    expect(versionUploadSource).toContain("import { runWebBuild } from './deploy-web-worker';");
    expect(versionUploadSource).toContain('await runWebBuild();');
    expect(packageJson.scripts?.['cloudflare:worker:deploy']).toBe(
      'cd ../.. && bun run cloudflare:worker:deploy'
    );
    expect(packageJson.scripts?.['cloudflare:worker:version:upload']).toBe(
      'cd ../.. && bun run cloudflare:worker:version:upload'
    );
  });
});
