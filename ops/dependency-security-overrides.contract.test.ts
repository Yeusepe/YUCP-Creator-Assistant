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
});
