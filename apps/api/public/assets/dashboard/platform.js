import { getConfig } from './config.js';
import { escHtml, setButtonLoading, clearButtonLoading } from './utils.js';
import {
  loadProviders,
  getActiveSetupProviders,
  getDashboardProvider,
} from './providers.js';
import {
  getApiBase,
  getTenantId,
  getGuildId,
  setTenantId,
  getHasSetupSession,
  setHasSetupSession,
  getSetupToken,
  apiFetch,
  connectionsMap,
  settingsMap,
  setPendingDisconnectPlatform,
  setSettingsTouched,
  setSetupCompleted,
  setPreviousQuickStartCompletion,
  settingsTouched,
  setupCompleted,
  previousQuickStartCompletion,
  completedMilestones,
  userAccountsList,
  setUserAccountsList,
} from './store.js';

const SETTINGS_TOUCHED_PREFIX = 'yucp_dashboard_settings_touched:';
const QUICK_START_DISMISS_PREFIX = 'yucp_dashboard_quick_start_dismissed:';
const SETUP_COMPLETE_PREFIX = 'yucp_dashboard_setup_completed:';
let platformProviders = [];

function getTenantStorageKey(prefix) {
  return `${prefix}${getTenantId() || getGuildId() || 'unknown'}`;
}

/** Show a non-blocking toast nudging the user to select a server first. */
function showSelectServerNotice() {
  const TOAST_ID = 'yucp-select-server-toast';
  if (document.getElementById(TOAST_ID)) return; // already visible

  const toast = document.createElement('div');
  toast.id = TOAST_ID;
  toast.setAttribute('role', 'status');
  toast.setAttribute('aria-live', 'polite');
  toast.style.cssText = [
    'position:fixed', 'bottom:24px', 'left:50%', 'transform:translateX(-50%)',
    'z-index:9999', 'display:flex', 'align-items:center', 'gap:10px',
    'padding:12px 20px', 'border-radius:12px',
    'background:rgba(30,31,34,0.97)', 'border:1px solid rgba(255,255,255,0.12)',
    'box-shadow:0 8px 32px rgba(0,0,0,0.5)', 'backdrop-filter:blur(12px)',
    'font-family:"Plus Jakarta Sans",sans-serif', 'font-size:13px',
    'font-weight:600', 'color:rgba(255,255,255,0.88)', 'pointer-events:none',
    'opacity:0', 'transition:opacity 0.25s ease',
  ].join(';');
  toast.innerHTML =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#5865F2" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>' +
    '<span>Select a server from the dropdown above first.</span>';
  document.body.appendChild(toast);
  requestAnimationFrame(() => { toast.style.opacity = '1'; });
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.addEventListener('transitionend', () => toast.remove(), { once: true });
  }, 3500);
}

export function loadProgressFlags() {
  try {
    // UI state only — never store auth tokens or sensitive data in localStorage
    setSettingsTouched(localStorage.getItem(getTenantStorageKey(SETTINGS_TOUCHED_PREFIX)) === '1');
    setSetupCompleted(localStorage.getItem(getTenantStorageKey(SETUP_COMPLETE_PREFIX)) === '1');
  } catch {
    setSettingsTouched(false);
    setSetupCompleted(false);
  }
}

function persistSettingsTouched() {
  setSettingsTouched(true);
  try {
    localStorage.setItem(getTenantStorageKey(SETTINGS_TOUCHED_PREFIX), '1');
  } catch {}
}

function persistSetupCompleted() {
  setSetupCompleted(true);
  try {
    localStorage.setItem(getTenantStorageKey(SETUP_COMPLETE_PREFIX), '1');
  } catch {}
}

function resolveIconUrl(provider) {
  return `${getApiBase()}/Icons/${provider.icon}`;
}

function getConnectedProviderKeys() {
  return platformProviders
    .filter((provider) => connectionsMap.has(provider.key))
    .map((provider) => provider.key);
}

function getConnectedProvidersCount() {
  return getConnectedProviderKeys().length;
}

function hasMeaningfulSettings() {
  return settingsTouched || settingsMap.size > 0;
}

function getQuickStartProviderNames() {
  return platformProviders
    .map((provider) => provider.label)
    .join(', ');
}

function buildQuickStartButtons() {
  return platformProviders
    .map((provider) => {
      const action = `data-provider-key="${provider.key}"`;
      return `
        <button ${action} style="background: ${provider.quickStartBg}; border: 1px solid ${provider.quickStartBorder}; color: white; border-radius: 12px; padding: 14px; display: flex; align-items: center; justify-content: center; gap: 10px; font-size: 15px; font-family: 'Plus Jakarta Sans', sans-serif; font-weight: 700; transition: background 0.2s;">
          <img src="${resolveIconUrl(provider)}" style="width: 20px; border-radius: 4px;" alt="">
          <span>Connect ${escHtml(provider.label)}</span>
        </button>
      `;
    })
    .join('');
}

function providerButtonLabel(provider, isLinked) {
  if (isLinked) return 'Disconnect';
  return 'Link Account';
}

function providerStatusLabel(provider, isLinked) {
  if (isLinked) return 'Connected';
  return 'Not Linked';
}

function renderPlatformScaffolding() {
  const cardsContainer = document.getElementById('dynamic-platform-cards');
  const tilesContainer = document.getElementById('dynamic-server-provider-tiles');
  if (cardsContainer) {
    cardsContainer.innerHTML = platformProviders
      .map(
        (provider) => `
          <div id="${provider.key}-card" class="platform-card disconnected">
            <div class="flex items-start justify-between">
              <div class="w-10 h-10 rounded-xl overflow-hidden flex items-center justify-center" style="background:${provider.iconBg};">
                <img class="w-6 h-6 object-contain" src="${resolveIconUrl(provider)}" alt="${escHtml(provider.label)}">
              </div>
              <span id="${provider.key}-status" class="status-pill disconnected">${providerStatusLabel(provider, false)}</span>
            </div>
            <div>
              <h3 class="font-bold text-base mb-0.5">${escHtml(provider.label)}</h3>
            </div>
            <button id="${provider.key}-btn" class="card-action-btn link" type="button">${providerButtonLabel(provider, false)}</button>
            <div class="inline-confirm" id="${provider.key}-disconnect-confirm">
              <div>
                <div class="inline-confirm-body">
                  <span class="inline-confirm-label">Disconnect <strong>${escHtml(provider.label)}</strong>? This removes all syncing.</span>
                  <div class="inline-confirm-btns">
                    <button class="inline-cancel-btn" type="button" data-cancel-disconnect="${provider.key}">Cancel</button>
                    <button class="inline-danger-btn" id="${provider.key}-confirm-btn" type="button">Disconnect</button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        `
      )
      .join('');
  }

  if (tilesContainer) {
    tilesContainer.innerHTML = platformProviders
      .map(
        (provider) => `
          <article class="svr-cfg-tile" id="server-tile-${provider.key}" style="display: none;">
            <div class="svr-cfg-tile-head">
              <div class="svr-cfg-tile-icon">
                <img src="${resolveIconUrl(provider)}" alt="${escHtml(provider.label)}" style="border-radius:4px;">
              </div>
              <div class="svr-cfg-tile-text">
                <span class="svr-cfg-tile-label">Enable ${escHtml(provider.label)} for this Server</span>
                <span class="svr-cfg-tile-hint">${escHtml(provider.serverTileHint)}</span>
              </div>
            </div>
            <div class="svr-cfg-tile-ctrl">
              <div id="toggle-serverEnable${provider.key[0].toUpperCase()}${provider.key.slice(1)}" class="svr-cfg-switch active" role="switch" aria-label="Enable ${escHtml(provider.label)} for this Server"></div>
            </div>
          </article>
        `
      )
      .join('');
  }
}

function getQuickStartState() {
  const connectedProviders = getConnectedProvidersCount();
  const connectedProviderKeys = getConnectedProviderKeys();
  const storesDone = connectedProviders > 0;
  const settingsDone = hasMeaningfulSettings();
  const finalReady = storesDone && settingsDone;
  const done = setupCompleted;
  const completedCount = [storesDone, settingsDone, done].filter(Boolean).length;

  let title = 'Finish setup from this page';
  let summary = 'Link a store, tune your verification rules, and finish in Discord when the dashboard looks right.';
  if (done) {
    title = 'Setup complete';
    summary = 'Your storefront connection and server preferences are in place. You can close this window or jump back into Discord for role automation.';
  } else if (finalReady) {
    title = 'Ready to finish';
    summary = 'You have connected at least one store and saved your preferences. Click Done Setup whenever you are ready to wrap this up.';
  } else if (storesDone) {
    title = 'Strong start';
    summary = 'Your store connection is in place. Review the server rules next so verification behaves the way you want.';
  }

  return {
    connectedProviders,
    connectedProviderKeys,
    storesDone,
    settingsDone,
    finalReady,
    done,
    completedCount,
    title,
    summary,
    progressPercent: Math.round((completedCount / 3) * 100),
    steps: [
      { id: 'stores', sectionId: 'platforms-grid', state: storesDone ? 'complete' : 'active', number: '01', label: storesDone ? 'Complete' : 'Current', title: storesDone ? `${connectedProviders} store${connectedProviders > 1 ? 's' : ''} linked` : 'Connect a supported store', body: storesDone ? 'Your storefront credentials are connected. You can add another store or move on.' : 'Use the provider cards below to connect the storefronts you actually sell through.', meta: storesDone ? `Connected: ${connectedProviderKeys.join(' + ')}` : `Available now: ${getQuickStartProviderNames()}`, action: storesDone ? 'Review platforms' : 'Go to platforms' },
      { id: 'settings', sectionId: 'server-settings-card', state: settingsDone ? 'complete' : storesDone ? 'active' : 'locked', number: '02', label: settingsDone ? 'Complete' : storesDone ? 'Next' : 'Locked', title: settingsDone ? 'Settings dialed in' : 'Review server settings', body: settingsDone ? 'You already saved verification preferences for this tenant.' : 'Decide how verification, duplicate checks, and cross-server behavior should work.', meta: settingsDone ? 'Saved on this tenant' : 'Toggle or select a setting to mark this done', action: settingsDone ? 'Adjust settings' : 'Open settings' },
      { id: 'finish', sectionId: 'server-settings-card', state: done ? 'complete' : finalReady ? 'active' : 'locked', number: '03', label: done ? 'Complete' : finalReady ? 'Ready' : 'Waiting', title: done ? 'Back to Discord' : 'Finish in Discord', body: done ? 'Setup was completed from this dashboard already.' : finalReady ? 'Everything is ready. Confirm the setup and close this page when you are done.' : 'Finish becomes available after you connect a store and save your preferences.', meta: done ? 'All set' : finalReady ? 'Done Setup is ready' : 'Waiting on earlier steps', action: done ? 'Review finish' : finalReady ? 'Jump to finish' : 'See requirements' },
    ],
  };
}

function celebrateMilestone(milestoneId) {
  if (completedMilestones.has(milestoneId)) return;
  completedMilestones.add(milestoneId);
}

function getNewlyCompletedMilestones(state) {
  const newlyCompleted = [];
  if (state.storesDone && !previousQuickStartCompletion.stores) newlyCompleted.push('stores');
  if (state.settingsDone && !previousQuickStartCompletion.settings) newlyCompleted.push('settings');
  if (state.done && !previousQuickStartCompletion.finish) newlyCompleted.push('finish');
  setPreviousQuickStartCompletion({ stores: state.storesDone, settings: state.settingsDone, finish: state.done });
  return newlyCompleted;
}

export function dismissQuickStart() {
  try {
    localStorage.setItem(getTenantStorageKey(QUICK_START_DISMISS_PREFIX), 'dismissed');
  } catch {}
  const modal = document.getElementById('onboarding-wizard-modal');
  if (modal) {
    modal.classList.remove('open');
    setTimeout(() => modal.remove(), 300);
  }
}

export function renderQuickStart() {
  const state = getQuickStartState();
  getNewlyCompletedMilestones(state).forEach((id) => celebrateMilestone(id));

  let dismissedSignature = '';
  try {
    dismissedSignature = localStorage.getItem(getTenantStorageKey(QUICK_START_DISMISS_PREFIX)) || '';
  } catch {}

  if (state.done || dismissedSignature === 'dismissed' || state.storesDone) {
    const existing = document.getElementById('onboarding-wizard-modal');
    if (existing) existing.remove();
    return;
  }

  if (!document.getElementById('onboarding-wizard-modal')) {
    const modal = document.createElement('div');
    modal.className = 'inline-panel open';
    modal.id = 'onboarding-wizard-modal';
    modal.innerHTML = `
      <div class="inline-panel-inner" style="max-width: 480px; text-align: center;">
        <div class="inline-panel-body" style="padding: 32px 24px;">
          <div style="margin: 0 auto 20px; width: 56px; height: 56px; border-radius: 16px; background: rgba(14,165,233,0.1); color: #0ea5e9; display: flex; align-items: center; justify-content: center; box-shadow: 0 0 20px rgba(14,165,233,0.2);">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M12 5l7 7-7 7" /></svg>
          </div>
          <h2 style="font-size: 24px; font-weight: 800; font-family: 'Plus Jakarta Sans', sans-serif; margin: 0 0 12px; color: white;">Welcome to Creator Assistant</h2>
          <p style="font-size: 15px; color: rgba(255,255,255,0.7); font-family: 'DM Sans', sans-serif; line-height: 1.6; margin-bottom: 32px; padding: 0 10px;">Let's get your dashboard set up. First, connect the storefront you sell through so we can automatically verify your buyers and assign them roles in Discord.</p>
          <div style="display: flex; flex-direction: column; gap: 12px; margin-bottom: 24px;">
            ${buildQuickStartButtons()}
          </div>
          <button data-action="dismiss-quickstart" style="background: transparent; color: rgba(255,255,255,0.4); border: none; font-size: 13px; font-family: 'DM Sans', sans-serif; cursor: pointer; text-decoration: underline; text-underline-offset: 4px;">I'll set this up later</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    modal.querySelectorAll('[data-provider-key]').forEach(btn => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.providerKey;
        if (key) navigateProvider(key);
      });
    });
    const dismissBtn = modal.querySelector('[data-action="dismiss-quickstart"]');
    if (dismissBtn) {
      dismissBtn.addEventListener('click', dismissQuickStart);
    }
  }
}

function redirectToExpiredLinkError() {
  const errorUrl = new URL(`${getApiBase()}/verify-error`, window.location.origin);
  errorUrl.searchParams.set('error', 'link_expired');
  window.location.replace(errorUrl.toString());
}

export async function exchangeBootstrapTokens() {
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const setupTokenFromHash = hash.get('s');
  const connectToken = hash.get('token');
  if (!setupTokenFromHash && !connectToken) return false;

  const res = await apiFetch(`${getApiBase()}/api/connect/bootstrap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ setupToken: setupTokenFromHash || undefined, connectToken: connectToken || undefined }),
  });

  if (!res.ok) {
    redirectToExpiredLinkError();
    return true;
  }
  window.history.replaceState({}, '', window.location.pathname + window.location.search);
  window.location.reload();
  return true;
}

export async function ensureBoundSetupSession() {
  const c = getConfig();
  const serverHasSetupSession = c.hasSetupSession; // from server __HAS_SETUP_SESSION__
  if (!serverHasSetupSession) {
    setHasSetupSession(false);
    return false;
  }

  const res = await apiFetch(`${getApiBase()}/api/connect/session-status`);
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  if (res.status === 401 && data?.signInUrl) {
    window.location.replace(data.signInUrl);
    return true;
  }
  if (res.status === 403) throw new Error(data?.error || 'This setup link belongs to a different Discord account.');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  setHasSetupSession(Boolean(data?.hasSetupSession && data?.authenticated));
  if (data?.tenantId) setTenantId(data.tenantId);
  return false;
}

async function ensureSetupSessionCookie() {
  if (!getSetupToken()) return false;
  const res = await apiFetch(`${getApiBase()}/api/connect/bootstrap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ setupToken: getSetupToken() }),
  });
  return res.ok;
}

export async function navigateProvider(providerKey) {
  const btn = document.getElementById(`${providerKey}-btn`);
  setButtonLoading(btn, 'Connecting…');
  try {
    if (getSetupToken()) {
      const restored = await ensureSetupSessionCookie();
      if (!restored) {
        redirectToExpiredLinkError();
        return;
      }
    }
    const provider = getActiveSetupProviders().find((p) => p.key === providerKey);
    if (!provider) return;
    const tid = getTenantId();
    const gid = getGuildId();
    let connectUrl = `${getApiBase()}${provider.connectPath}`;
    if (tid && gid) {
      if (provider.connectParamStyle === 'camelCase') {
        connectUrl += `?tenantId=${encodeURIComponent(tid)}&guildId=${encodeURIComponent(gid)}`;
      } else {
        connectUrl += `?tenant_id=${encodeURIComponent(tid)}&guild_id=${encodeURIComponent(gid)}`;
      }
    }
    window.location.href = connectUrl;
  } catch (e) {
    clearButtonLoading(btn);
    throw e;
  }
}

export function updatePlatformCards() {
  renderAccountsSection();
  platformProviders.forEach((provider) => {
    updateCard(provider.key, connectionsMap.has(provider.key));
  });
  renderQuickStart();
}

function getProviderMeta() {
  return Object.fromEntries(
    getActiveSetupProviders().map((p) => [
      p.key,
      {
        name: p.label,
        icon: resolveIconUrl(p),
        iconBg: p.iconBg,
        navigate: () => navigateProvider(p.key),
      },
    ])
  );
}

function renderAddButtons() {
  const container = document.getElementById('add-account-buttons');
  if (!container) return;

  container.innerHTML = platformProviders
    .map(
      (p) => `<button class="card-action-btn link" data-provider="${p.key}"
          style="flex:1;min-width:160px;display:flex;align-items:center;justify-content:center;gap:8px;">
          <img src="${resolveIconUrl(p)}" style="width:16px;border-radius:3px;" alt="">
          Add ${p.label} Account
        </button>`
    )
    .join('');

  container.querySelectorAll('[data-provider]').forEach((btn) => {
    const key = btn.getAttribute('data-provider');
    btn.addEventListener('click', () => navigateProvider(key));
  });
}

function renderAccountsSection() {
  const container = document.getElementById('user-accounts-list');
  if (!container) return;

  const accounts = userAccountsList;
  if (accounts.length === 0) {
    container.innerHTML = `
      <div style="color:rgba(255,255,255,0.5); font-size:14px; font-family:'DM Sans',sans-serif; padding: 16px 0;">
        No store accounts linked yet. Use the buttons below to connect.
      </div>`;
    return;
  }

  container.innerHTML = accounts.map((conn) => {
    const meta = getProviderMeta()[conn.provider] || { name: conn.provider, icon: '', iconBg: '#333', navigate: () => {} };
    const label = conn.label || meta.name;
    return `
      <div class="platform-card connected" style="position:relative;">
        <div class="flex items-start justify-between">
          <div class="w-10 h-10 rounded-xl flex items-center justify-center overflow-hidden" style="background:${meta.iconBg}; flex-shrink:0;">
            <img src="${meta.icon}" class="w-6 h-6 object-contain" alt="${meta.name}">
          </div>
          <span class="status-pill connected">Connected</span>
        </div>
        <div>
          <h3 class="font-bold text-base mb-0.5">${meta.name}</h3>
          <p class="text-xs text-white/60" style="font-family:'DM Sans',sans-serif;">${escHtml(label)}</p>
        </div>
        <button
          class="card-action-btn disconnect"
          data-conn-id="${escHtml(conn.id)}"
          data-provider="${escHtml(conn.provider)}"
        >Disconnect</button>
      </div>`;
  }).join('');
  container.querySelectorAll('.card-action-btn.disconnect').forEach((btn) => {
    btn.addEventListener('click', () => {
      confirmDisconnectUserAccount(btn.dataset.connId, btn.dataset.provider, btn);
    });
  });
}

function updateCard(platform, isLinked) {
  const provider = getDashboardProvider(platform);
  const card = document.getElementById(`${platform}-card`);
  const status = document.getElementById(`${platform}-status`);
  const btn = document.getElementById(`${platform}-btn`);
  if (!provider || !card || !status || !btn) return;

  card.style.display = 'flex';
  btn.disabled = false;
  if (isLinked) {
    card.classList.remove('disconnected');
    card.classList.add('connected');
    status.className = 'status-pill connected';
    status.innerText = providerStatusLabel(provider, true);
    btn.className = 'card-action-btn disconnect';
    btn.innerText = providerButtonLabel(provider, true);
    btn.style = '';
    btn.onclick = () => openModal(platform);
    btn.disabled = false;
  } else {
    card.classList.add('disconnected');
    card.classList.remove('connected');
    status.className = 'status-pill disconnected';
    status.innerText = providerStatusLabel(provider, false);
    btn.className = 'card-action-btn link';
    btn.innerText = providerButtonLabel(provider, false);
    btn.style = '';
    btn.onclick = provider.setupState === 'ready' ? () => navigateProvider(platform) : null;
    btn.disabled = provider.setupState !== 'ready';
  }

  const sEmpty = document.getElementById('server-integrations-empty');
  if (sEmpty) {
    const hasLinkedProvider = platformProviders.some((entry) => connectionsMap.has(entry.key));
    platformProviders.forEach((entry) => {
      const tile = document.getElementById(`server-tile-${entry.key}`);
      if (tile) tile.style.display = connectionsMap.has(entry.key) ? 'flex' : 'none';
    });
    sEmpty.style.display = hasLinkedProvider ? 'none' : 'block';
  }
}

function updateSettingsUI() {
  ['allowMismatchedEmails', 'autoVerifyOnJoin', 'shareVerificationWithServers', 'enableDiscordRoleFromOtherServers'].forEach((key) => {
    const el = document.getElementById(`toggle-${key}`);
    if (el) el.classList.toggle('active', !!settingsMap.get(key));
  });
  ['verificationScope', 'duplicateVerificationBehavior', 'suspiciousAccountBehavior', 'logChannelId', 'announcementsChannelId'].forEach((key) => {
    const el = document.getElementById(`select-${key}`);
    if (el && settingsMap.has(key)) {
      el.value = settingsMap.get(key);
      el.dispatchEvent(new CustomEvent('value-updated'));
    }
  });
  renderQuickStart();
}

function showSaved(key) {
  const indicator = document.querySelector(`.tile-save-indicator[data-for="${key}"]`);
  const errIndicator = document.querySelector(`.tile-save-error[data-for="${key}"]`);
  if (errIndicator) {
    errIndicator.hidden = true;
    errIndicator.classList.remove('visible');
    clearTimeout(errIndicator._timeout);
  }
  if (indicator) {
    indicator.classList.add('visible');
    clearTimeout(indicator._timeout);
    indicator._timeout = setTimeout(() => indicator.classList.remove('visible'), 2200);
  }
}

function showSaveError(key) {
  const indicator = document.querySelector(`.tile-save-indicator[data-for="${key}"]`);
  const errIndicator = document.querySelector(`.tile-save-error[data-for="${key}"]`);
  if (indicator) {
    indicator.classList.remove('visible');
    clearTimeout(indicator._timeout);
  }
  if (errIndicator) {
    clearTimeout(errIndicator._timeout);
    clearTimeout(errIndicator._hideTimeout);
    errIndicator.hidden = false;
    errIndicator.classList.add('visible');
    errIndicator._timeout = setTimeout(() => {
      errIndicator.classList.remove('visible');
      errIndicator._hideTimeout = setTimeout(() => { errIndicator.hidden = true; }, 380);
    }, 3000);
  }
}

async function toggleSetting(key) {
  const el = document.getElementById(`toggle-${key}`);
  const newValue = !settingsMap.get(key);
  el.classList.toggle('active');
  settingsMap.set(key, newValue);
  el.classList.add('saving');
  try {
    const res = await apiFetch(`${getApiBase()}/api/connect/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, value: newValue, authUserId: getTenantId() }) });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data?.error || 'Failed to save setting.');
    }
    showSaved(key);
    persistSettingsTouched();
    renderQuickStart();
  } catch (e) {
    console.error('Error updating setting:', e);
    showSaveError(key);
    el.classList.toggle('active');
    settingsMap.set(key, !newValue);
    renderQuickStart();
  } finally {
    el.classList.remove('saving');
  }
}

async function selectSetting(key, value) {
  const oldValue = settingsMap.get(key);
  settingsMap.set(key, value);
  try {
    const res = await apiFetch(`${getApiBase()}/api/connect/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, value, authUserId: getTenantId() }) });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data?.error || 'Failed to save setting.');
    }
    showSaved(key);
    persistSettingsTouched();
    renderQuickStart();
  } catch (e) {
    console.error('Error updating setting:', e);
    showSaveError(key);
    settingsMap.set(key, oldValue);
    const el = document.getElementById(`select-${key}`);
    if (el) el.value = oldValue ?? '';
    renderQuickStart();
  }
}

function cancelDisconnect(platform) {
  const el = document.getElementById(`${platform}-disconnect-confirm`);
  if (el) el.classList.remove('open');
  setPendingDisconnectPlatform(null);
}

function openModal(platform) {
  setPendingDisconnectPlatform(platform);
  platformProviders.forEach(({ key: p }) => {
    if (p !== platform) {
      const el = document.getElementById(`${p}-disconnect-confirm`);
      if (el) el.classList.remove('open');
    }
  });
  const el = document.getElementById(`${platform}-disconnect-confirm`);
  if (el) el.classList.add('open');
}

async function confirmDisconnect(platform) {
  const conn = connectionsMap.get(platform);
  if (!conn) return;
  const btn = document.getElementById(`${platform}-confirm-btn`);
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Disconnecting…';
  }
  try {
    const authUserId = getTenantId();
    const urlSuffix = authUserId ? `&authUserId=${encodeURIComponent(authUserId)}` : '';
    const res = await apiFetch(`${getApiBase()}/api/connections?id=${conn.id}${urlSuffix}`, { method: 'DELETE' });
    if (res.ok) {
      connectionsMap.delete(platform);
      const el = document.getElementById(`${platform}-disconnect-confirm`);
      if (el) el.classList.remove('open');
      updatePlatformCards();
    } else {
      alert('Failed to disconnect. Please try again.');
    }
  } catch (e) {
    console.error('Disconnect error:', e);
    alert('Network error while disconnecting.');
  }
  if (btn) {
    btn.disabled = false;
    btn.textContent = 'Disconnect';
  }
}

export async function confirmDisconnectUserAccount(connId, provider, btn) {
  if (!connId || typeof connId !== 'string' || connId.length > 256) return;
  if (!provider || typeof provider !== 'string' || provider.length > 64) return;
  if (!confirm(`Disconnect this ${provider} account? This removes syncing for all servers.`)) return;
  setButtonLoading(btn, 'Disconnecting…');
  try {
    const res = await apiFetch(`${getApiBase()}/api/connect/user/accounts?id=${encodeURIComponent(connId)}`, { method: 'DELETE' });
    if (res.ok) {
      setUserAccountsList(userAccountsList.filter((c) => c.id !== connId));
      updatePlatformCards();
    } else {
      alert('Failed to disconnect. Please try again.');
    }
  } catch (e) {
    console.error('Disconnect error:', e);
    alert('Network error while disconnecting.');
  } finally {
    clearButtonLoading(btn);
  }
}

async function loadGuildChannels() {
  try {
    const guildId = getGuildId();
    const tenantId = getTenantId();
    let url = `${getApiBase()}/api/connect/guild/channels`;
    // Web-session users have no setup-session cookie; pass guildId for server-side ownership check.
    if (!getHasSetupSession() && guildId) {
      url += `?guildId=${encodeURIComponent(guildId)}`;
      if (tenantId) url += `&authUserId=${encodeURIComponent(tenantId)}`;
    }
    const res = await apiFetch(url);
    if (!res.ok) return;
    const data = await res.json();
    const channels = data.channels || [];
    refreshChannelSelect('select-logChannelId', channels, settingsMap.get('logChannelId'));
    refreshChannelSelect('select-announcementsChannelId', channels, settingsMap.get('announcementsChannelId'));
  } catch (err) {
    console.error('Failed to load guild channels', err);
  }
}

function refreshChannelSelect(selectId, channels, savedValue) {
  const select = document.getElementById(selectId);
  if (!select) return;

  // initCustomSelects inserts the wrapper as a SIBLING after the select (not a parent),
  // so use nextElementSibling — not closest() — to find and remove it.
  const sibling = select.nextElementSibling;
  if (sibling?.classList.contains('custom-select-wrapper')) sibling.remove();
  delete select.dataset.customized;

  // Repopulate options
  select.innerHTML = '<option value="">— None —</option>';
  channels.forEach((ch) => {
    const opt = document.createElement('option');
    opt.value = ch.id;
    opt.textContent = `#${ch.name}`;
    select.appendChild(opt);
  });

  if (savedValue) {
    select.value = savedValue;
  }

  // Re-apply the custom select widget
  initCustomSelects();

  if (savedValue) {
    select.dispatchEvent(new CustomEvent('value-updated'));
  }
}

export async function fetchAllData() {
  try {
    // Always fetch user-scoped accounts (works regardless of server selection)
    const userAccountsRes = await apiFetch(`${getApiBase()}/api/connect/user/accounts`);
    if (userAccountsRes.ok) {
      const userAccountsData = await userAccountsRes.json();
      setUserAccountsList(userAccountsData.connections || []);
    }

    if (getHasSetupSession()) {
      // Also fetch setup-session-scoped connections (legacy flow)
      const statusRes = await apiFetch(`${getApiBase()}/api/connections`);
      if (statusRes.ok) {
        const statusData = await statusRes.json();
        // Merge setup-session connections with user accounts (deduplicate by id)
        const existing = new Set(userAccountsList.map((c) => c.id));
        const merged = [...userAccountsList];
        if (statusData.connections) {
          statusData.connections.forEach((c) => {
            if (c.status === 'active') {
              const providerKey = c.providerKey || c.provider;
              if (!providerKey) return;
              const normalized = { ...c, provider: c.provider || providerKey };
              connectionsMap.set(providerKey, normalized);
              if (!existing.has(normalized.id)) merged.push(normalized);
            }
          });
        }
        setUserAccountsList(merged);
      }
      const settingsRes = await apiFetch(`${getApiBase()}/api/connect/settings`);
      if (settingsRes.ok) {
        const settingsData = await settingsRes.json();
        if (settingsData.policy) {
          const policy = settingsData.policy;
          ['allowMismatchedEmails', 'autoVerifyOnJoin', 'shareVerificationWithServers', 'enableDiscordRoleFromOtherServers', 'verificationScope', 'duplicateVerificationBehavior', 'suspiciousAccountBehavior', 'logChannelId', 'announcementsChannelId'].forEach((k) => {
            if (policy[k] !== undefined) settingsMap.set(k, policy[k]);
          });
          updateSettingsUI();
        }
        await loadGuildChannels();
      }
    } else if (getTenantId()) {
      const settingsRes = await apiFetch(`${getApiBase()}/api/connect/settings?authUserId=${encodeURIComponent(getTenantId())}`);
      if (settingsRes.ok) {
        const settingsData = await settingsRes.json();
        if (settingsData.policy) {
          const policy = settingsData.policy;
          ['allowMismatchedEmails', 'autoVerifyOnJoin', 'shareVerificationWithServers', 'enableDiscordRoleFromOtherServers', 'verificationScope', 'duplicateVerificationBehavior', 'suspiciousAccountBehavior', 'logChannelId', 'announcementsChannelId'].forEach((k) => {
            if (policy[k] !== undefined) settingsMap.set(k, policy[k]);
          });
          updateSettingsUI();
        }
      }
      if (getGuildId()) await loadGuildChannels();
    }
    updatePlatformCards();
  } catch (err) {
    console.error('Failed to fetch data', err);
  }
}

export function initCustomSelects() {
  document.querySelectorAll('.setting-select, .svr-cfg-pick').forEach((select) => {
    if (select.dataset.customized) return;
    select.dataset.customized = 'true';
    const wrapper = document.createElement('div');
    wrapper.className = 'custom-select-wrapper';
    wrapper.tabIndex = 0;
    const trigger = document.createElement('div');
    trigger.className = 'custom-select-trigger';
    const valueDisplay = document.createElement('span');
    valueDisplay.className = 'custom-select-value';
    const arrow = document.createElement('svg');
    arrow.className = 'custom-select-arrow';
    arrow.innerHTML = '<path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>';
    arrow.setAttribute('viewBox', '0 0 24 24');
    trigger.appendChild(valueDisplay);
    trigger.appendChild(arrow);
    const optionsContainer = document.createElement('div');
    optionsContainer.className = 'custom-select-options';

    function updateValue() {
      const selectedOption = select.options[select.selectedIndex];
      valueDisplay.textContent = selectedOption ? selectedOption.text : '';
      wrapper.querySelectorAll('.custom-select-option').forEach((opt) => opt.classList.remove('selected'));
      const activeOpt = wrapper.querySelector(`.custom-select-option[data-value="${select.value}"]`);
      if (activeOpt) activeOpt.classList.add('selected');
    }

    Array.from(select.options).forEach((option) => {
      const optEl = document.createElement('div');
      optEl.className = 'custom-select-option';
      optEl.dataset.value = option.value;
      optEl.textContent = option.text;
      optEl.addEventListener('click', (e) => {
        e.stopPropagation();
        select.value = option.value;
        updateValue();
        select.dispatchEvent(new Event('change'));
        wrapper.classList.remove('open');
      });
      optionsContainer.appendChild(optEl);
    });

    wrapper.appendChild(trigger);
    wrapper.appendChild(optionsContainer);
    select.parentNode.insertBefore(wrapper, select.nextSibling);
    updateValue();
    select.addEventListener('value-updated', updateValue);
    trigger.addEventListener('click', () => {
      document.querySelectorAll('.custom-select-wrapper.open').forEach((w) => {
        if (w !== wrapper) w.classList.remove('open');
      });
      wrapper.classList.toggle('open');
    });
    document.addEventListener('click', (e) => {
      if (!wrapper.contains(e.target)) wrapper.classList.remove('open');
    });
  });
}

export async function initPlatforms() {
  await loadProviders(getApiBase());
  platformProviders = getActiveSetupProviders();

  renderPlatformScaffolding();
  window.navigateProvider = navigateProvider;
  window.dismissQuickStart = dismissQuickStart;
  window.toggleSetting = toggleSetting;
  window.selectSetting = selectSetting;
  window.cancelDisconnect = cancelDisconnect;
  window.confirmDisconnectUserAccount = confirmDisconnectUserAccount;

  renderAddButtons();

  document.querySelectorAll('.setting-select, .svr-cfg-pick').forEach((select) => {
    const key = select.id?.replace('select-', '') || '';
    if (key) select.addEventListener('change', (e) => selectSetting(key, select.value));
  });

  platformProviders.forEach((provider) => {
    document.getElementById(`${provider.key}-confirm-btn`)?.addEventListener('click', () => confirmDisconnect(provider.key));
  });
  document.querySelectorAll('[data-cancel-disconnect]').forEach((el) => {
    const platform = el.getAttribute('data-cancel-disconnect');
    el.addEventListener('click', () => cancelDisconnect(platform));
  });

  document.getElementById('quick-start-dismiss')?.addEventListener('click', dismissQuickStart);
  updatePlatformCards();
  initCustomSelects();
}
