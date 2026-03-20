import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROUTES_DIR = join(__dirname, '../../src/routes/dashboard');
const LIB_DIR = join(__dirname, '../../src/lib');
const SERVER_LIB_DIR = join(__dirname, '../../src/lib/server');
const CONVEX_DIR = join(__dirname, '../../../../convex');

function readRouteSource(fileName: string) {
  return readFileSync(join(ROUTES_DIR, fileName), 'utf8');
}

function readLibSource(fileName: string) {
  return readFileSync(join(LIB_DIR, fileName), 'utf8');
}

function readServerLibSource(fileName: string) {
  return readFileSync(join(SERVER_LIB_DIR, fileName), 'utf8');
}

function readConvexSource(fileName: string) {
  return readFileSync(join(CONVEX_DIR, fileName), 'utf8');
}

describe('dashboard parity wiring', () => {
  it('wires the main dashboard route to the original personal and server data flows', () => {
    const source = readRouteSource('index.tsx');
    const helperSource = readLibSource('dashboard.ts');
    const serverHelperSource = readServerLibSource('dashboard.ts');
    const guildLinksSource = readConvexSource('guildLinks.ts');
    const layoutSource = readFileSync(join(__dirname, '../../src/routes/dashboard.tsx'), 'utf8');

    expect(source).toContain('id="participating-servers-list"');
    expect(source).toContain('id="dynamic-server-provider-tiles"');
    expect(source).toContain('id="server-disconnect-steps"');
    expect(helperSource).toContain('/api/providers');
    expect(helperSource).toContain('/api/connect/user/guilds');
    expect(helperSource).toContain('/api/connect/user/accounts');
    expect(helperSource).toContain('/api/connect/status');
    expect(helperSource).toContain('/api/connect/settings');
    expect(helperSource).toContain('/api/connect/guild/channels');
    expect(helperSource).toContain('/api/install/uninstall/');
    expect(serverHelperSource).toContain('/api/connect/user/guilds');
    expect(serverHelperSource).not.toContain('/api/dashboard/guilds');
    expect(serverHelperSource).toContain('id: guild.guildId');
    expect(serverHelperSource).toContain('tenantId: guild.authUserId');
    expect(guildLinksSource).toContain(".query('guild_links')");
    expect(guildLinksSource).toContain(
      ".withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))"
    );
    expect(guildLinksSource).not.toContain(
      ".query('creator_profiles')\n      .withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))\n      .collect()"
    );
    expect(source).toContain('queryFn: listUserGuilds');
    expect(layoutSource).toContain('queryFn: listUserGuilds');
  });

  it('derives server provider tiles from tenant connection status instead of the viewer account list', () => {
    const source = readRouteSource('index.tsx');
    const serverConfigPanelSource =
      source.match(
        /function ServerConfigPanel\(\)[\s\S]*?\}, \[providers, statusByProvider\]\);/
      )?.[0] ?? '';

    expect(serverConfigPanelSource).toContain(
      "queryKey: ['dashboard-connection-status', authUserId]"
    );
    expect(serverConfigPanelSource).toContain(
      'queryFn: () => getConnectionStatus(requireAuthUserId(authUserId))'
    );
    expect(serverConfigPanelSource).toContain('statusByProvider[provider.key]');
    expect(serverConfigPanelSource).not.toContain(
      "queryKey: ['dashboard-user-accounts', viewer?.authUserId]"
    );
  });

  it('keeps connected platform rendering aligned with provider status cards instead of duplicate account strips', () => {
    const source = readRouteSource('index.tsx');

    expect(source).toContain('const unlinkedPlatformProviders = useMemo(');
    expect(source).toContain(
      '() => platformProviders.filter((provider) => !accountsByProvider.has(provider.key))'
    );
    expect(source).toContain('{unlinkedPlatformProviders.map((provider) => {');
    expect(source).not.toContain('id="user-accounts-list"');
    expect(source).toContain("style={{ marginBottom: '24px' }}");
    expect(source).toContain("style={{ gap: '12px', marginBottom: '24px' }}");
    expect(source).toContain(
      "style={{ fontFamily: \"'DM Sans', sans-serif\", margin: '0 0 16px' }}"
    );
  });

  it('uses simple section-specific skeleton components instead of generic card placeholders', () => {
    const indexSource = readRouteSource('index.tsx');
    const integrationsSource = readRouteSource('integrations.tsx');
    const collaborationSource = readRouteSource('collaboration.tsx');

    expect(indexSource).toContain('DashboardGridSkeleton');
    expect(indexSource).toContain('DashboardActionRowSkeleton');
    expect(indexSource).toContain('DashboardSettingsSkeleton');
    expect(integrationsSource).toContain('DashboardActionRowSkeleton');
    expect(integrationsSource).toContain('DashboardListSkeleton');
    expect(collaborationSource).toContain('DashboardListSkeleton');
    expect(indexSource).not.toContain('className="skeleton-block skeleton-card"');
    expect(integrationsSource).not.toContain('className="skeleton-block skeleton-card"');
    expect(collaborationSource).not.toContain('className="skeleton-block skeleton-card"');
  });

  it('waits for the resolved dashboard viewer before querying user-scoped account data', () => {
    const source = readRouteSource('index.tsx');

    const guardedAccountQueries =
      source.match(
        /queryKey:\s*\['dashboard-user-accounts'[^\]]*\][\s\S]*?queryFn:\s*listUserAccounts,[\s\S]*?enabled:\s*Boolean\(viewer\?\.authUserId\)/g
      ) ?? [];

    expect(guardedAccountQueries).toHaveLength(1);
  });

  it('wires developer integrations to OAuth app and API key CRUD flows', () => {
    const source = readRouteSource('integrations.tsx');
    const helperSource = readLibSource('dashboard.ts');

    expect(helperSource).toContain('/api/connect/oauth-apps');
    expect(helperSource).toContain('/api/connect/public-api/keys');
    expect(source).toContain('id="api-key-reveal"');
    expect(source).toContain('id="oauth-secret-reveal"');
    expect(source).toContain('className="oauth-app-card"');
    expect(source).toContain('editingAppId === app._id');
    expect(source).not.toContain('id="oauth-apps-loading"');
    expect(source).not.toContain('id="api-keys-loading"');
    expect(source).not.toContain('page-loading-spin');
    expect(source).toContain('className="empty-state-copy"');
    expect(source).not.toContain('className="text-xs mt-2 max-w-xs mx-auto"');
  });

  it('wires collaboration to provider, invite, and connection APIs', () => {
    const source = readRouteSource('collaboration.tsx');
    const helperSource = readLibSource('dashboard.ts');

    expect(source).toContain('refetchInterval: 15000');
    expect(source).toContain('id="collab-invites-list"');
    expect(source).toContain('id="collab-as-collaborator-list"');
    expect(helperSource).toContain('/api/collab/providers');
    expect(helperSource).toContain('/api/collab/invite');
    expect(helperSource).toContain('/api/collab/invites');
    expect(helperSource).toContain('/api/collab/connections');
    expect(helperSource).toContain('/api/collab/connections/as-collaborator');
    expect(source).not.toContain('id="collab-loading"');
    expect(source).not.toContain('id="collab-as-collaborator-loading"');
    expect(source).not.toContain('page-loading-spin');
    expect(source).toContain('className="empty-state-copy"');
    expect(source).not.toContain('className="text-xs mt-2 max-w-xs mx-auto"');
  });

  it('keeps the inline invite-link copy control from the original collaboration panel', () => {
    const source = readRouteSource('collaboration.tsx');

    expect(source).toContain('className="invite-url-row"');
    expect(source).toContain('className="invite-url-copy-btn"');
    expect(source).toContain('aria-label="Copy link"');
  });

  it('uses shared dashboard query defaults instead of raw React Query defaults', () => {
    const indexSource = readRouteSource('index.tsx');
    const layoutSource = readFileSync(join(__dirname, '../../src/routes/dashboard.tsx'), 'utf8');
    const integrationsSource = readRouteSource('integrations.tsx');
    const collaborationSource = readRouteSource('collaboration.tsx');

    expect(indexSource).toContain('dashboardQueryOptions<');
    expect(indexSource).toContain('enabled: hasMounted');
    expect(layoutSource).toContain('enabled: hasMounted');
    expect(integrationsSource).toContain('dashboardQueryOptions<');
    expect(collaborationSource).toContain('dashboardQueryOptions<');
    expect(collaborationSource).toContain('dashboardPollingQueryOptions<');
  });
});
