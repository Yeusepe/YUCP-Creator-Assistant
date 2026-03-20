import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  resolve(__dirname, '../../src/components/dashboard/DashboardSkeletons.tsx'),
  'utf8'
);

describe('dashboard skeleton module contract', () => {
  it('declares its CSSProperties type import before runtime declarations', () => {
    const firstNonEmptyLine = source.split(/\r?\n/).find((line) => line.trim().length > 0);

    expect(firstNonEmptyLine).toBe("import type { CSSProperties } from 'react';");
  });
});
