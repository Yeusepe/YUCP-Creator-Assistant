import { createFileRoute } from '@tanstack/react-router';
import { useEffect } from 'react';

interface ConnectSearch {
  guild_id?: string;
  guildId?: string;
  tenant_id?: string;
  tenantId?: string;
  setup_token?: string;
  connect_token?: string;
}

export const Route = createFileRoute('/connect')({
  validateSearch: (search: Record<string, unknown>): ConnectSearch => ({
    guild_id: typeof search.guild_id === 'string' ? search.guild_id : undefined,
    guildId: typeof search.guildId === 'string' ? search.guildId : undefined,
    tenant_id: typeof search.tenant_id === 'string' ? search.tenant_id : undefined,
    tenantId: typeof search.tenantId === 'string' ? search.tenantId : undefined,
    setup_token: typeof search.setup_token === 'string' ? search.setup_token : undefined,
    connect_token: typeof search.connect_token === 'string' ? search.connect_token : undefined,
  }),
  head: () => ({
    meta: [{ title: 'Creator Assistant' }],
  }),
  component: ConnectCompatibilityRedirect,
});

function ConnectCompatibilityRedirect() {
  const search = Route.useSearch();

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const dashboardUrl = new URL('/dashboard', window.location.origin);
    const guildId = search.guild_id || search.guildId;
    const tenantId = search.tenant_id || search.tenantId;
    if (guildId) {
      dashboardUrl.searchParams.set('guild_id', guildId);
    }
    if (tenantId) {
      dashboardUrl.searchParams.set('tenant_id', tenantId);
    }

    const tokenHash = new URLSearchParams({
      ...(search.setup_token ? { s: search.setup_token } : {}),
      ...(search.connect_token ? { token: search.connect_token } : {}),
    }).toString();
    const existingHash = window.location.hash.replace(/^#/, '');
    const nextHash = tokenHash || existingHash;
    if (nextHash) {
      dashboardUrl.hash = nextHash;
    }

    window.location.replace(dashboardUrl.toString());
  }, [
    search.connect_token,
    search.guild_id,
    search.guildId,
    search.setup_token,
    search.tenant_id,
    search.tenantId,
  ]);

  return null;
}
