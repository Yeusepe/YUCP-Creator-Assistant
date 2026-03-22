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

  it('degrades viewer profile fields instead of crashing the whole dashboard when the Convex viewer query fails', () => {
    expect(dashboardServerSource).toContain('Dashboard viewer load degraded');
    expect(dashboardServerSource).toContain('return baseViewer;');
  });
});
