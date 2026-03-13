import { getConfig } from './config.js';
import { initStore } from './store.js';
import { initTheme } from './theme.js';
import { initTabs } from './tabs.js';
import { initSidebar } from './sidebar.js';
import { initDropdowns } from './dropdown.js';
import { initServerContext, refreshUserServers } from './server-context.js';
import {
  initPlatforms,
  updatePlatformCards,
  fetchAllData,
  loadProgressFlags,
  exchangeBootstrapTokens,
  ensureBoundSetupSession,
  renderQuickStart,
} from './platform.js';
import { initCollab, fetchCollabConnections } from './collab.js';
import { initApiKeys, fetchPublicApiKeys } from './api.js';
import { initOAuth, fetchOAuthApps } from './oauth.js';
import { getTenantId, setTenantId, getGuildId, getHasSetupSession, getApiBase, apiFetch } from './store.js';

async function refreshContextData() {
  try {
    if (!getHasSetupSession() && !getTenantId() && getGuildId()) {
      const res = await apiFetch(
        `${getApiBase()}/api/connect/ensure-tenant?guildId=${encodeURIComponent(getGuildId())}`,
      );
      const data = await res.json();
      const resolvedId = data.authUserId ?? data.tenantId;
      if (resolvedId) {
        setTenantId(resolvedId);
        const urlParams = new URLSearchParams(window.location.search);
        urlParams.set('tenant_id', resolvedId);
        window.history.replaceState({}, '', `${window.location.pathname}?${urlParams.toString()}`);
      }
    }
    await fetchAllData();
    await fetchCollabConnections();
    await fetchPublicApiKeys();
    await fetchOAuthApps();
    loadProgressFlags();
    renderQuickStart();
  } catch (err) {
    console.error('Context refresh error:', err);
  }
}

async function init() {
  try {
    if (await exchangeBootstrapTokens()) return;

    if (await ensureBoundSetupSession()) return;
    loadProgressFlags();
    initServerContext({ updatePlatformCards, refreshData: refreshContextData });

    if (!getHasSetupSession() && !getTenantId() && getGuildId()) {
      const res = await apiFetch(`${getApiBase()}/api/connect/ensure-tenant?guildId=${encodeURIComponent(getGuildId())}`);
      const data = await res.json();
      const resolvedId = data.authUserId ?? data.tenantId;
      if (resolvedId) {
        setTenantId(resolvedId);
        await refreshUserServers(updatePlatformCards);
      }
    }

    await fetchAllData();
    await fetchCollabConnections();
    await fetchPublicApiKeys();
    await fetchOAuthApps();
    renderQuickStart();
  } catch (err) {
    console.error('Initialization error:', err);
  } finally {
    const overlay = document.getElementById('page-loading-overlay');
    if (overlay) overlay.style.display = 'none';
  }
}

function runInits() {
  initStore();
  initTheme();
  initTabs();
  initSidebar();
  initDropdowns();
  initPlatforms();
  initCollab();
  initApiKeys();
  initOAuth();

  const params = new URLSearchParams(window.location.search);
  if (params.get('gumroad') === 'connected' || params.get('jinxxy') === 'connected') {
    const cleanParams = new URLSearchParams();
    if (getGuildId()) cleanParams.set('guild_id', getGuildId());
    if (getTenantId()) cleanParams.set('tenant_id', getTenantId());
    const cleanUrl = cleanParams.toString() ? `${window.location.pathname}?${cleanParams.toString()}` : window.location.pathname;
    window.history.replaceState({}, '', cleanUrl);
    setTimeout(init, 500);
  } else {
    init();
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', runInits);
} else {
  runInits();
}
