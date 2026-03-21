import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const dashboardRouteSource = readFileSync(
  resolve(__dirname, '../../src/routes/dashboard.tsx'),
  'utf8'
);
const dashboardIndexRouteSource = readFileSync(
  resolve(__dirname, '../../src/routes/dashboard/index.tsx'),
  'utf8'
);

const dashboardComponentsCss = readFileSync(
  resolve(__dirname, '../../src/styles/dashboard-components.css'),
  'utf8'
);

const dashboardCss = readFileSync(resolve(__dirname, '../../src/styles/dashboard.css'), 'utf8');
const cloudBackgroundSource = readFileSync(
  resolve(__dirname, '../../src/components/three/CloudBackground.tsx'),
  'utf8'
);

describe('dashboard UI contracts', () => {
  it('removes the redundant select-server prompt card from the dashboard body', () => {
    expect(dashboardIndexRouteSource).not.toContain('<SelectServerPrompt />');
    expect(dashboardIndexRouteSource).not.toContain('function SelectServerPrompt()');
  });

  it('uses shared dashboard query options for the guild picker and resolves empty server state text', () => {
    expect(dashboardRouteSource).toContain('dashboardShellQueryOptions');
    expect(dashboardRouteSource).toContain('useDashboardShell');
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

  it('defines explicit dashboard card padding instead of relying on utility spacing classes', () => {
    expect(dashboardCss).toContain('.section-card,');
    expect(dashboardCss).toContain('.intg-card {');
    expect(dashboardCss).toContain('padding: 16px;');
    expect(dashboardCss).toContain('padding: 20px;');
    expect(dashboardCss).toContain('padding: 28px;');
  });

  it('keeps the server switcher full width and above the backdrop', () => {
    expect(dashboardCss).toContain('.sidebar-server-selector');
    expect(dashboardCss).toContain('width: 100%;');
    expect(dashboardCss).toContain('z-index: 100003;');
    expect(dashboardCss).toContain('justify-content: space-between;');
    expect(dashboardRouteSource).toContain('<DashboardBodyPortal>');
    expect(dashboardRouteSource).toContain('server-selector-portal');
  });

  it('uses an aligned content shell instead of overlap offsets in the main dashboard layout', () => {
    expect(dashboardRouteSource).toContain('content-area-inner');
    expect(dashboardCss).toContain('.content-area-inner {');
    expect(dashboardCss).not.toContain('margin-left: -12px;');
    expect(dashboardCss).not.toContain('margin-right: 16px;');
  });

  it('uses the home icon for the personal dashboard selector trigger and no longer renders blob backgrounds', () => {
    expect(dashboardRouteSource).toContain(
      '<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />'
    );
    expect(dashboardRouteSource).not.toContain('<BlobBackground />');
    expect(dashboardRouteSource).not.toContain('function BlobBackground()');
  });

  it('uses solid light and dark dashboard fallback backgrounds instead of the old blob gradient', () => {
    expect(dashboardCss).toContain('background: #afcde5;');
    expect(dashboardCss).toContain('.dark .dashboard-page');
    expect(dashboardCss).toContain('background: #24405c;');
    expect(dashboardCss).not.toContain(
      'background: linear-gradient(180deg, #4a9dd9 0%, #3a8bc6 100%);'
    );
  });

  it('keeps dashboard provider connect buttons on frontend setup routes instead of hardcoded raw API begin links', () => {
    const connectedPlatformsPanelSource = readFileSync(
      resolve(__dirname, '../../src/components/dashboard/panels/ConnectedPlatformsPanel.tsx'),
      'utf8'
    );
    expect(connectedPlatformsPanelSource).toContain('buildProviderConnectUrl(provider,');
    expect(connectedPlatformsPanelSource).not.toContain('/api/connect/vrchat/begin');
    expect(dashboardIndexRouteSource).not.toContain('/api/connect/vrchat/begin');
  });

  it('defines simple dashboard skeleton primitives instead of the old generic faux-card treatment', () => {
    expect(dashboardCss).toContain('.skeleton-line');
    expect(dashboardCss).toContain('.skeleton-circle');
    expect(dashboardCss).toContain('.skeleton-pill');
    expect(dashboardCss).toContain('.skeleton-row-card');
    expect(dashboardCss).toContain('.skeleton-switch');
    expect(dashboardCss).not.toContain('.skeleton-card');
  });

  it('keeps invite-link copy affordances and dark-mode integrations overrides in the shared css', () => {
    expect(dashboardComponentsCss).toContain('.invite-url-row');
    expect(dashboardComponentsCss).toContain('.invite-url-copy-btn');
    expect(dashboardComponentsCss).toContain('.dark .intg-card');
    expect(dashboardComponentsCss).toContain('.dark .intg-card .oauth-app-card');
    expect(dashboardComponentsCss).toContain('.dark .intg-card .api-key-row');
  });

  it('defines centered empty-state copy styles without relying on utility classes', () => {
    expect(dashboardComponentsCss).toContain('.empty-state-copy');
    expect(dashboardComponentsCss).toContain('max-width: 280px;');
    expect(dashboardComponentsCss).toContain('margin: 8px auto 0;');
    expect(dashboardComponentsCss).toContain('text-align: center;');
  });

  it('fades cloud layers in after they become ready', () => {
    const globalsCss = readFileSync(resolve(__dirname, '../../src/styles/globals.css'), 'utf8');
    expect(cloudBackgroundSource).toContain('requestAnimationFrame');
    expect(cloudBackgroundSource).toContain('cloud-layer-fade');
    // cloud-layer-fade must live in globals.css so it applies on every page,
    // not just dashboard (sign-in, legal, collab-invite all use CloudBackground)
    expect(globalsCss).toContain('.cloud-layer-fade');
    expect(globalsCss).toContain('transition: opacity 0.6s ease;');
    // dashboard.css must NOT redefine it (globals.css is the single source of truth)
    expect(dashboardCss).not.toContain('.cloud-layer-fade');
  });
});
