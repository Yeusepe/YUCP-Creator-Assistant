/**
 * Dashboard configuration from server-injected placeholders.
 * @returns {{ apiBase: string, tenantId: string, guildId: string, hasSetupSession: boolean }}
 */
export function getConfig() {
  const c = window.__CONFIG__ || {};
  return {
    apiBase: c.apiBase || '',
    tenantId: c.tenantId || '',
    guildId: c.guildId || '',
    hasSetupSession: Boolean(c.hasSetupSession),
  };
}
