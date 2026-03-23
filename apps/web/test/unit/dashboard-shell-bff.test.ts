import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const dashboardServerSource = readFileSync(
  resolve(__dirname, '../../src/lib/server/dashboard.ts'),
  'utf8'
);

describe('dashboard shell BFF wiring', () => {
  it('loads the shell through the Bun dashboard-shell endpoint', () => {
    expect(dashboardServerSource).toContain('/api/connect/dashboard/shell');
  });

  it('stops stitching the shell from separate viewer and guild bootstrap calls', () => {
    expect(dashboardServerSource).not.toContain(
      'const [viewer, guilds] = await Promise.all([loadDashboardViewer(token), loadGuilds(token)])'
    );
  });
});
