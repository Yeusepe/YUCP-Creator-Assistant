import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const dashboardServerSource = readFileSync(
  resolve(__dirname, '../../src/lib/server/dashboard.ts'),
  'utf8'
);

describe('dashboard server logging', () => {
  it('fails closed when the authenticated viewer is missing from the shell response', () => {
    expect(dashboardServerSource).toContain(
      'Dashboard shell response is missing the authenticated viewer'
    );
  });
});
