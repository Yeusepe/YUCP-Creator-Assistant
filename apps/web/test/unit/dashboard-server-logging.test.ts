import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const dashboardServerSource = readFileSync(
  resolve(__dirname, '../../src/lib/server/dashboard.ts'),
  'utf8'
);

describe('dashboard server logging', () => {
  it('logs the dashboard token, viewer, guild, and shell failure phases', () => {
    expect(dashboardServerSource).toContain('dashboard-require-token');
    expect(dashboardServerSource).toContain('dashboard-load-viewer');
    expect(dashboardServerSource).toContain('dashboard-load-guilds');
    expect(dashboardServerSource).toContain('dashboard-load-shell');
    expect(dashboardServerSource).toContain('logWebError');
  });
});
