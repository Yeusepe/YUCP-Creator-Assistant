import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Cloudflare Workers Builds contract', () => {
  test('exposes clean-checkout commands that install dependencies with build secrets', () => {
    const packageJson = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.['cloudflare:worker:deploy']).toBe(
      'bun install --frozen-lockfile && bun run --filter @yucp/web worker:deploy -- --prod'
    );
    expect(packageJson.scripts?.['cloudflare:worker:version:upload']).toBe(
      'bun install --frozen-lockfile && bun run --filter @yucp/web worker:version:upload'
    );
  });
});
