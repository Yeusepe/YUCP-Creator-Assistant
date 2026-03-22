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
    expect(dashboardRouteSource).toContain("locationHash.includes('s=')");
    expect(dashboardRouteSource).toContain("locationHash.includes('token=')");
    expect(dashboardRouteSource).toContain('const [bootstrapState, setBootstrapState] = useState');
    expect(dashboardRouteSource).toContain("window.location.hash.replace(/^#/, '')");
    expect(dashboardRouteSource).not.toContain(
      "if (typeof window === 'undefined' || bootstrapState.status === 'idle')"
    );
  });

  it('holds the bootstrap state until the refreshed dashboard shell is ready', () => {
    expect(dashboardRouteSource).toContain("status: 'checking'");

    const navigateIndex = dashboardRouteSource.indexOf('await navigate({');
    const idleIndex = dashboardRouteSource.lastIndexOf("setBootstrapState({ status: 'idle' });");

    expect(navigateIndex).toBeGreaterThan(-1);
    expect(idleIndex).toBeGreaterThan(-1);
    expect(navigateIndex).toBeLessThan(idleIndex);
  });

  it('keeps the server selector out of the generic fallback while bootstrap is pending', () => {
    expect(dashboardRouteSource).toContain('const selectedServer = selectedGuild ?? pendingGuild;');
    expect(dashboardRouteSource).toMatch(
      /const selectedName =\s*selectedServer\?\.name \?\? \(hasBootstrapPending \? 'Linking server\.\.\.' : 'Select a Server'\);/
    );
  });
});
