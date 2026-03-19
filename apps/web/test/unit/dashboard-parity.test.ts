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
    expect(helperSource).toContain('/api/connect/settings');
    expect(helperSource).toContain('/api/connect/guild/channels');
    expect(helperSource).toContain('/api/install/uninstall/');
    expect(serverHelperSource).toContain("/api/connect/user/guilds");
    expect(serverHelperSource).not.toContain('/api/dashboard/guilds');
    expect(serverHelperSource).toContain('id: guild.guildId');
    expect(serverHelperSource).toContain('tenantId: guild.authUserId');
    expect(guildLinksSource).toContain(".query('guild_links')");
    expect(guildLinksSource).toContain(".withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))");
    expect(guildLinksSource).not.toContain(".query('creator_profiles')\n      .withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))\n      .collect()");
    expect(source).toContain('queryFn: listUserGuilds');
    expect(layoutSource).toContain('queryFn: listUserGuilds');
  });

  it('keeps connected platform rendering aligned with provider status cards instead of duplicate account strips', () => {
    const source = readRouteSource('index.tsx');

    expect(source).toContain('const unlinkedPlatformProviders = useMemo(');
    expect(source).toContain(
      "() => platformProviders.filter((provider) => !accountsByProvider.has(provider.key))"
    );
    expect(source).toContain('{unlinkedPlatformProviders.map((provider) => {');
    expect(source).not.toContain('id="user-accounts-list"');
    expect(source).not.toContain("style={{ marginBottom: '24px' }}");
  });

  it('waits for the resolved dashboard viewer before querying user-scoped account data', () => {
    const source = readRouteSource('index.tsx');

    const guardedAccountQueries =
      source.match(
        /queryKey:\s*\['dashboard-user-accounts'[^\]]*\][\s\S]*?queryFn:\s*listUserAccounts,[\s\S]*?enabled:\s*Boolean\(viewer\?\.authUserId\)/g
      ) ?? [];

    expect(guardedAccountQueries).toHaveLength(2);
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
