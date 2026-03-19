import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROUTES_DIR = join(__dirname, '../../src/routes/dashboard');
const LIB_DIR = join(__dirname, '../../src/lib');

function readRouteSource(fileName: string) {
  return readFileSync(join(ROUTES_DIR, fileName), 'utf8');
}

function readLibSource(fileName: string) {
  return readFileSync(join(LIB_DIR, fileName), 'utf8');
}

describe('dashboard parity wiring', () => {
  it('wires the main dashboard route to the original personal and server data flows', () => {
    const source = readRouteSource('index.tsx');
    const helperSource = readLibSource('dashboard.ts');

    expect(source).toContain('id="participating-servers-list"');
    expect(source).toContain('id="dynamic-server-provider-tiles"');
    expect(source).toContain('id="server-disconnect-steps"');
    expect(helperSource).toContain('/api/providers');
    expect(helperSource).toContain('/api/connect/user/accounts');
    expect(helperSource).toContain('/api/connect/settings');
    expect(helperSource).toContain('/api/connect/guild/channels');
    expect(helperSource).toContain('/api/install/uninstall/');
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
});
