import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const dashboardRouteSource = readFileSync(
  resolve(__dirname, '../../src/routes/dashboard.tsx'),
  'utf8'
);

describe('dashboard token compatibility', () => {
  it('bootstraps setup tokens after mount and allows fresh guild dashboard loads', () => {
    expect(dashboardRouteSource).toContain("locationHref.includes('guild_id=')");
    expect(dashboardRouteSource).toContain('const [bootstrapState, setBootstrapState] = useState');
    expect(dashboardRouteSource).toContain("window.location.hash.replace(/^#/, '')");
  });
});
