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

    expect(packageJson.scripts?.['icons:sync']).toBe('bun run --cwd ../.. icons:sync');
    expect(packageJson.scripts?.build).toBe('bun run icons:sync && vite build');
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

  test('regenerates licensed icons before every Vite development entrypoint', () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(process.cwd(), 'apps', 'web', 'package.json'), 'utf8')
    ) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.dev).toBe('bun run icons:sync && vite dev');
    expect(packageJson.scripts?.['worker:dev']).toBe(
      'bun run icons:sync && bun run ../../ops/prepare-web-worker-env.ts && vite dev'
    );
  });

  test('mounts every licensed asset setting only for the Docker build instruction', () => {
    const dockerfile = readFileSync(resolve(process.cwd(), 'apps', 'web', 'Dockerfile'), 'utf8');
    const assetKeys = [
      'ASSETS_S3_BUCKET',
      'ASSETS_S3_ENDPOINT',
      'ASSETS_S3_REGION',
      'ASSETS_S3_READONLY_ACCESS_KEY_ID',
      'ASSETS_S3_READONLY_SECRET_ACCESS_KEY',
    ];

    for (const key of assetKeys) {
      expect(dockerfile).toContain(`--mount=type=secret,id=${key},required=true`);
      expect(dockerfile).toContain(`${key}="$(cat /run/secrets/${key})"`);
      expect(dockerfile).not.toMatch(new RegExp(`^(?:ARG|ENV)\\s+${key}\\b`, 'm'));
    }
    expect(dockerfile).toMatch(/RUN --mount=type=secret,id=ASSETS_S3_BUCKET[\s\S]*bun run build/);
  });

  test('keeps host dependencies, local secrets, and generated icons out of the Docker context', () => {
    const dockerignore = readFileSync(resolve(process.cwd(), '.dockerignore'), 'utf8');

    expect(dockerignore).toMatch(/^\.git$/m);
    expect(dockerignore).toMatch(/^\.env\.\*$/m);
    expect(dockerignore).toMatch(/^\*\*\/node_modules$/m);
    expect(dockerignore).toMatch(/^\*\*\/dist$/m);
    expect(dockerignore).toMatch(/^\*\*\/\*\.tsbuildinfo$/m);
    expect(dockerignore).toMatch(/^apps\/web\/src\/icons\/generated\.tsx$/m);
  });

  test('uses the Bun base image supplied non-root user', () => {
    const dockerfile = readFileSync(resolve(process.cwd(), 'apps', 'web', 'Dockerfile'), 'utf8');

    expect(dockerfile).not.toMatch(/\b(?:addgroup|adduser)\b/);
    expect(dockerfile).toContain('USER bun');
  });
});
