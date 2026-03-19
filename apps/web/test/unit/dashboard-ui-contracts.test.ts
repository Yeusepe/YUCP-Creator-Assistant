import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const dashboardRouteSource = readFileSync(
  resolve(__dirname, '../../src/routes/dashboard.tsx'),
  'utf8'
);

const dashboardComponentsCss = readFileSync(
  resolve(__dirname, '../../src/styles/dashboard-components.css'),
  'utf8'
);

const dashboardCss = readFileSync(resolve(__dirname, '../../src/styles/dashboard.css'), 'utf8');

describe('dashboard UI contracts', () => {
  it('uses shared dashboard query options for the guild picker and resolves empty server state text', () => {
    expect(dashboardRouteSource).toContain('dashboardQueryOptions<Guild[]>');
    expect(dashboardRouteSource).toContain('No servers configured yet');
  });

  it('loads dashboard styles as side-effect imports instead of route head assets', () => {
    expect(dashboardRouteSource).toContain("import '@/styles/dashboard.css';");
    expect(dashboardRouteSource).toContain("import '@/styles/dashboard-components.css';");
    expect(dashboardRouteSource).not.toContain('routeStylesheetLinks(');
    expect(dashboardRouteSource).not.toContain('routeStyleHrefs.dashboard');
    expect(dashboardRouteSource).not.toContain('routeStyleHrefs.dashboardComponents');
  });

  it('keeps server dropdown CSS selectors aligned with the route class names', () => {
    expect(dashboardComponentsCss).toContain('.server-dropdown-backdrop.is-visible');
    expect(dashboardComponentsCss).toContain('.server-dropdown-item.is-selected');
  });

  it('disables the colored dashboard card border treatments', () => {
    expect(dashboardComponentsCss).toMatch(
      /\.dashboard-tab-panel \.section-card::before\s*\{\s*display: none;/
    );
    expect(dashboardComponentsCss).toMatch(
      /\.platform-card\.connected::after\s*\{\s*display: none;/
    );
  });

  it('keeps the server switcher full width and above the backdrop', () => {
    expect(dashboardCss).toContain('.sidebar-server-selector');
    expect(dashboardCss).toContain('width: 100%;');
    expect(dashboardCss).toContain('z-index: 100003;');
    expect(dashboardCss).toContain('justify-content: space-between;');
    expect(dashboardRouteSource).toContain('createPortal(');
    expect(dashboardRouteSource).toContain('server-selector-portal');
  });

  it('keeps invite-link copy affordances and dark-mode integrations overrides in the shared css', () => {
    expect(dashboardComponentsCss).toContain('.invite-url-row');
    expect(dashboardComponentsCss).toContain('.invite-url-copy-btn');
    expect(dashboardComponentsCss).toContain('.dark .intg-card');
    expect(dashboardComponentsCss).toContain('.dark .intg-card .oauth-app-card');
    expect(dashboardComponentsCss).toContain('.dark .intg-card .api-key-row');
  });
});
