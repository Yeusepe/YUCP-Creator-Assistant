import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

type VersionTuple = readonly [major: number, minor: number, patch: number];

const packageJson = JSON.parse(
  readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8')
) as {
  dependencies: Record<string, string>;
  overrides: Record<string, string>;
};

function parseExactVersion(name: string, value: string): VersionTuple {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  if (!match) {
    throw new Error(`${name} must use an exact semantic version, received ${value}`);
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function expectVersionAtLeast(name: string, value: string, minimum: VersionTuple): void {
  const version = parseExactVersion(name, value);
  const comparison = version[0] - minimum[0] || version[1] - minimum[1] || version[2] - minimum[2];
  expect(
    comparison,
    `${name} ${value} must be at least ${minimum.join('.')}`
  ).toBeGreaterThanOrEqual(0);
}

describe('security dependency overrides', () => {
  it('pins packages above the current GitHub Advisory Database patched floors', () => {
    const minimums: Readonly<Record<string, VersionTuple>> = {
      'js-yaml': [4, 3, 0],
      protobufjs: [7, 6, 5],
      'shell-quote': [1, 9, 0],
      tar: [7, 5, 18],
    };

    for (const [name, minimum] of Object.entries(minimums)) {
      expectVersionAtLeast(name, packageJson.overrides[name], minimum);
    }
    expect(packageJson.dependencies.tar).toBe(packageJson.overrides.tar);
  });

  it('pins the current package-storage program dependency advisories above patched floors', () => {
    const minimumRanges: Readonly<Record<string, string>> = {
      '@better-auth/oauth-provider': '>=1.7.0-beta.4',
      '@opentelemetry/auto-instrumentations-node': '>=0.78.0',
      '@opentelemetry/core': '>=2.10.0',
      '@opentelemetry/exporter-prometheus': '>=0.221.0',
      '@opentelemetry/propagator-jaeger': '>=2.9.0',
      '@opentelemetry/sdk-node': '>=0.221.0',
      sharp: '>=0.35.0',
    };

    for (const [name, minimumRange] of Object.entries(minimumRanges)) {
      const version = packageJson.overrides[name];
      expect(version, `${name} must have a root override`).toBeDefined();
      expect(
        Bun.semver.satisfies(version, minimumRange),
        `${name} ${version} must satisfy ${minimumRange}`
      ).toBe(true);
    }

    for (const plugin of [
      '@better-auth/api-key',
      '@better-auth/core',
      '@better-auth/oauth-provider',
      '@better-auth/passkey',
    ]) {
      expect(packageJson.overrides[plugin]).toBe(packageJson.overrides['better-auth']);
    }
  });
});
