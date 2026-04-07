import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const tokensCss = readFileSync(resolve(__dirname, '../../src/styles/tokens.css'), 'utf8');

describe('typography scale', () => {
  it('defines font-size scale as CSS variables', () => {
    expect(tokensCss).toContain('--font-size-xs:');
    expect(tokensCss).toContain('--font-size-sm:');
    expect(tokensCss).toContain('--font-size-base:');
    expect(tokensCss).toContain('--font-size-lg:');
    expect(tokensCss).toContain('--font-size-xl:');
  });
  it('defines line-height scale as CSS variables', () => {
    expect(tokensCss).toContain('--line-height-tight:');
    expect(tokensCss).toContain('--line-height-normal:');
    expect(tokensCss).toContain('--line-height-relaxed:');
  });
  it('defines transition duration tokens', () => {
    expect(tokensCss).toContain('--transition-fast:');
    expect(tokensCss).toContain('--transition-base:');
    expect(tokensCss).toContain('--transition-slow:');
  });
  it('defines focus ring token', () => {
    expect(tokensCss).toContain('--focus-ring:');
  });
});
