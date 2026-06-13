import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type PackageJson = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

type StylelintConfig = {
  rules?: Record<string, unknown>;
};

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function getDeclaredPackages(): Set<string> {
  const packageJson = readJson<PackageJson>(resolve(process.cwd(), 'package.json'));
  return new Set([
    ...Object.keys(packageJson.dependencies ?? {}),
    ...Object.keys(packageJson.devDependencies ?? {}),
  ]);
}

function getIgnoredAtRules(config: StylelintConfig, ruleName: string): string[] {
  const rule = config.rules?.[ruleName];
  if (!Array.isArray(rule)) {
    return [];
  }

  const options = rule[1];
  if (!options || typeof options !== 'object' || !('ignoreAtRules' in options)) {
    return [];
  }

  const ignoreAtRules = (options as { ignoreAtRules?: unknown }).ignoreAtRules;
  return Array.isArray(ignoreAtRules)
    ? ignoreAtRules.filter((value): value is string => typeof value === 'string')
    : [];
}

describe('web Stylelint config', () => {
  test('does not require undeclared Stylelint plugins', () => {
    const config = readJson<StylelintConfig>(resolve(process.cwd(), '.stylelintrc.json'));
    const declaredPackages = getDeclaredPackages();

    for (const ruleName of Object.keys(config.rules ?? {})) {
      if (ruleName.startsWith('scss/')) {
        expect(
          declaredPackages.has('stylelint-scss'),
          `${ruleName} requires the stylelint-scss package`
        ).toBe(true);
      }
    }
  });

  test('allows Tailwind v4 at-rules used by the web global stylesheet', () => {
    const config = readJson<StylelintConfig>(resolve(process.cwd(), '.stylelintrc.json'));

    expect(getIgnoredAtRules(config, 'at-rule-no-unknown')).toEqual(
      expect.arrayContaining(['custom-variant', 'source', 'theme', 'utility'])
    );
  });
});
