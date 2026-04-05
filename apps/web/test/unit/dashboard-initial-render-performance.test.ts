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

  it('keeps route-owned dashboard and account CSS in lazy route files instead of the initial route references', () => {
    expect(dashboardRouteSource).not.toContain("import '@/styles/dashboard.css';");
    expect(dashboardRouteSource).not.toContain("import '@/styles/dashboard-components.css';");
    expect(accountRouteSource).not.toContain("import '@/styles/dashboard.css';");
    expect(accountRouteSource).not.toContain("import '@/styles/dashboard-components.css';");
    expect(accountRouteSource).not.toContain("import '@/styles/account.css';");
    expect(dashboardLazyRouteSource).toContain("import '@/styles/dashboard.css';");
    expect(dashboardLazyRouteSource).toContain("import '@/styles/dashboard-components.css';");
    expect(accountLazyRouteSource).toContain("import '@/styles/dashboard.css';");
    expect(accountLazyRouteSource).toContain("import '@/styles/dashboard-components.css';");
    expect(accountLazyRouteSource).toContain("import '@/styles/account.css';");
  });

  it('does not block first paint on a remote Google Fonts stylesheet', () => {
    expect(rootRouteSource).not.toContain('fonts.googleapis.com');
    expect(rootRouteSource).not.toContain('fonts.gstatic.com');
  });
});
