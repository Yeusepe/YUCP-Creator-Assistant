import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(resolve(__dirname, './convexActor.ts'), 'utf8');

describe('bot convex actor wrapper contract', () => {
  it('does not auto-attach over an explicitly provided actor', () => {
    expect(source).toContain("!('actor' in (args as Record<string, unknown>))");
  });
});
