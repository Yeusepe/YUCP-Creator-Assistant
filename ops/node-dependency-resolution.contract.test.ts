import { describe, expect, it } from 'bun:test';
import { resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dir, '..');

describe('Node dependency resolution', () => {
  for (const [name, specifier] of [
    ['Polar SDK Zod 4 entry point', '@polar-sh/sdk/models/components/webhookbenefitcreatedpayload'],
    ['HyperDX Node instrumentation', '@hyperdx/node-opentelemetry'],
  ] as const) {
    it(`loads the ${name} under Node ESM`, () => {
      const result = Bun.spawnSync({
        cmd: ['node', '--input-type=module', '--eval', `await import('${specifier}')`],
        cwd: repositoryRoot,
        stderr: 'pipe',
        stdout: 'pipe',
      });

      expect(new TextDecoder().decode(result.stderr)).toBe('');
      expect(result.exitCode).toBe(0);
    });
  }
});
