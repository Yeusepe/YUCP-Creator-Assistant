import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const dashboardRouteSource = readFileSync(
  resolve(__dirname, '../../src/routes/_authenticated/dashboard.tsx'),
  'utf8'
);
const dashboardLazyRouteSource = readFileSync(
  resolve(__dirname, '../../src/routes/_authenticated/dashboard.lazy.tsx'),
  'utf8'
);

describe('dashboard token compatibility', () => {
  it('allows fresh guild dashboard loads when the link carries a hash token', () => {
    expect(dashboardRouteSource).toContain("locationHref.includes('guild_id=')");
    expect(dashboardRouteSource).toContain("locationHash.includes('s=')");
    expect(dashboardRouteSource).toContain("locationHash.includes('token=')");
    expect(dashboardRouteSource).toContain('loaderDeps: ({ search }) => ({');
    expect(dashboardRouteSource).toContain('guildId: search.guild_id ?? null');
    expect(dashboardRouteSource).toContain('tenantId: search.tenant_id ?? null');
  });

  it('bootstraps setup and connect tokens from the URL hash after mount', () => {
    expect(dashboardLazyRouteSource).toContain(
      "const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ''));"
    );
    expect(dashboardLazyRouteSource).toContain(
      "const setupToken = search.setup_token ?? hashParams.get('s') ?? undefined;"
    );
    expect(dashboardLazyRouteSource).toContain(
      "const connectToken = search.connect_token ?? hashParams.get('token') ?? undefined;"
    );
  });

  it('keeps the server selector out of the generic fallback while bootstrap is pending', () => {
    expect(dashboardLazyRouteSource).toContain(
      'const selectedServer = selectedGuild ?? pendingGuild;'
    );
    expect(dashboardLazyRouteSource).toMatch(
      /const selectedName =\s*selectedServer\?\.name \?\? \(hasBootstrapPending \? 'Linking server\.\.\.' : 'Select a Server'\);/
    );
  });

  it('clears the route-level dashboard shell cache before navigating after bootstrap', () => {
    expect(dashboardRouteSource).toContain('export function clearDashboardLoaderCache()');

    const clearIndex = dashboardLazyRouteSource.indexOf('clearDashboardLoaderCache();');
    const navigateIndex = dashboardLazyRouteSource.indexOf('await navigate({');

    expect(clearIndex).toBeGreaterThan(-1);
    expect(navigateIndex).toBeGreaterThan(-1);
    expect(clearIndex).toBeLessThan(navigateIndex);
  });
});
