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
const accountRouteSource = readFileSync(
  resolve(__dirname, '../../src/routes/_authenticated/account.tsx'),
  'utf8'
);
const accountLazyRouteSource = readFileSync(
  resolve(__dirname, '../../src/routes/_authenticated/account.lazy.tsx'),
  'utf8'
);
const rootRouteSource = readFileSync(resolve(__dirname, '../../src/routes/__root.tsx'), 'utf8');

describe('dashboard initial render performance contracts', () => {
  it('renders the dashboard route in data-only SSR mode so the pending shell can stream immediately', () => {
    expect(dashboardRouteSource).toContain("ssr: 'data-only'");
  });

  it('keeps a route-level pending component for the dashboard shell fallback', () => {
    expect(dashboardRouteSource).toContain('pendingComponent: DashboardLayoutPending');
  });

  it('head-links dashboard and account shell css from the base route references', () => {
    expect(dashboardRouteSource).toContain('head: () => ({');
    expect(dashboardRouteSource).toContain('routeStylesheetLinks(');
    expect(dashboardRouteSource).toContain('routeStyleHrefs.dashboard');
    expect(dashboardRouteSource).toContain('routeStyleHrefs.dashboardComponents');
    expect(accountRouteSource).toContain('head: () => ({');
    expect(accountRouteSource).toContain('routeStylesheetLinks(');
    expect(accountRouteSource).toContain('routeStyleHrefs.dashboard');
    expect(accountRouteSource).toContain('routeStyleHrefs.dashboardComponents');
    expect(accountRouteSource).toContain('routeStyleHrefs.account');
    expect(dashboardLazyRouteSource).not.toContain("import '@/styles/dashboard.css';");
    expect(dashboardLazyRouteSource).not.toContain("import '@/styles/dashboard-components.css';");
    expect(accountLazyRouteSource).not.toContain("import '@/styles/dashboard.css';");
    expect(accountLazyRouteSource).not.toContain("import '@/styles/dashboard-components.css';");
    expect(accountLazyRouteSource).not.toContain("import '@/styles/account.css';");
  });

  it('does not block first paint on a remote Google Fonts stylesheet', () => {
    expect(rootRouteSource).not.toContain('fonts.googleapis.com');
    expect(rootRouteSource).not.toContain('fonts.gstatic.com');
  });
});
