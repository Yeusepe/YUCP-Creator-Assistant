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
const dashboardIndexRouteSource = readFileSync(
  resolve(__dirname, '../../src/routes/_authenticated/dashboard/index.lazy.tsx'),
  'utf8'
);

const dashboardComponentsCss = readFileSync(
  resolve(__dirname, '../../src/styles/dashboard-components.css'),
  'utf8'
);
const onboardingProgressPanelSource = readFileSync(
  resolve(__dirname, '../../src/components/dashboard/panels/OnboardingProgressPanel.tsx'),
  'utf8'
);

const dashboardCss = readFileSync(resolve(__dirname, '../../src/styles/dashboard.css'), 'utf8');
const cloudBackgroundSource = readFileSync(
  resolve(__dirname, '../../src/components/three/CloudBackground.tsx'),
  'utf8'
);
const backgroundAppSource = readFileSync(
  resolve(__dirname, '../../src/components/three/BackgroundApp.tsx'),
  'utf8'
);
const brandingAssetsSource = readFileSync(
  resolve(__dirname, '../../src/lib/brandingAssets.ts'),
  'utf8'
);

describe('dashboard UI contracts', () => {
  it('removes the redundant select-server prompt card from the dashboard body', () => {
    expect(dashboardIndexRouteSource).not.toContain('<SelectServerPrompt />');
    expect(dashboardIndexRouteSource).not.toContain('function SelectServerPrompt()');
  });

  it('uses shared dashboard query options for the guild picker and resolves empty server state text', () => {
    expect(dashboardRouteSource).toContain('dashboardShellQueryOptions');
    expect(dashboardLazyRouteSource).toContain('useDashboardShell');
    expect(dashboardLazyRouteSource).toContain('No servers configured yet');
  });

  it('declares dashboard shell styles from the base route head so SSR markup is styled on first paint', () => {
    expect(dashboardRouteSource).toContain('routeStylesheetLinks(');
    expect(dashboardRouteSource).toContain('routeStyleHrefs.dashboard');
    expect(dashboardRouteSource).toContain('routeStyleHrefs.dashboardComponents');
    expect(dashboardLazyRouteSource).not.toContain("import '@/styles/dashboard.css';");
    expect(dashboardLazyRouteSource).not.toContain("import '@/styles/dashboard-components.css';");
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
    expect(dashboardCss).toContain('z-index: var(--z-portal);');
    expect(dashboardCss).toContain('justify-content: space-between;');
    expect(dashboardLazyRouteSource).toContain('<DashboardBodyPortal>');
    expect(dashboardLazyRouteSource).toContain('server-selector-portal');
  });

  it('uses an aligned content shell instead of overlap offsets in the main dashboard layout', () => {
    expect(dashboardLazyRouteSource).toContain('content-area-inner');
    expect(dashboardCss).toContain('.content-area-inner {');
    expect(dashboardCss).not.toContain('margin-left: -12px;');
    expect(dashboardCss).not.toContain('margin-right: 16px;');
  });

  it('keeps the dashboard chrome in the lazy route layout instead of baking it into each child route', () => {
    expect(dashboardLazyRouteSource).toContain('DashboardSessionProvider');
    expect(dashboardLazyRouteSource).toContain('<Sidebar');
    expect(dashboardLazyRouteSource).toContain('<Outlet />');
  });

  it('uses the home icon for the personal dashboard selector trigger and no longer renders blob backgrounds', () => {
    expect(dashboardLazyRouteSource).toContain(
      '<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />'
    );
    expect(dashboardLazyRouteSource).not.toContain('<BlobBackground />');
    expect(dashboardLazyRouteSource).not.toContain('function BlobBackground()');
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

  it('reveals the cloud background from a real first frame instead of fading it in later', () => {
    expect(cloudBackgroundSource).not.toContain('requestIdleCallback');
    expect(cloudBackgroundSource).not.toContain('cloud-layer-fade');
    expect(backgroundAppSource).toContain('FirstFrameReadySignal');
    expect(backgroundAppSource).toContain('useTexture.preload(cloudTextureUrl)');
    expect(backgroundAppSource).toContain('<Preload all />');
    expect(dashboardCss).not.toContain('.cloud-layer-fade');
  });

  it('scopes onboarding storage to the current viewer and retries notification ack on failure', () => {
    expect(dashboardIndexRouteSource).toContain('buildOnboardingStorageKeys');
    expect(dashboardIndexRouteSource).toContain('viewer?.authUserId');
    expect(dashboardIndexRouteSource).toContain('ANONYMOUS_ONBOARDING_STORAGE_SUFFIX');
    expect(dashboardIndexRouteSource).toContain('seenNotificationIds.current.delete(id)');
  });

  it('renders onboarding progress directly from the parent step state without a mount gate', () => {
    expect(onboardingProgressPanelSource).not.toContain(
      'const [isMounted, setIsMounted] = useState(false);'
    );
    expect(onboardingProgressPanelSource).not.toContain('isMounted && step.completed');
    expect(onboardingProgressPanelSource).toContain('steps.filter((s) => s.completed).length');
  });

  it('centralizes subscription-aware brand asset selection', () => {
    expect(brandingAssetsSource).toContain('getBrandedIconPath');
    expect(brandingAssetsSource).toContain('isPlusBrandingActive');
    expect(brandingAssetsSource).toContain("'/Icons/MainLogoPlus.png'");
    expect(brandingAssetsSource).toContain("'/Icons/BagPlus.png'");
    expect(brandingAssetsSource).toContain("'/Icons/AssistantPlus.png'");
  });
});
