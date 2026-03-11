import { getConfig } from './config.js';
import {
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
} from './store.js';

const SETTINGS_TOUCHED_PREFIX = 'yucp_dashboard_settings_touched:';
const QUICK_START_DISMISS_PREFIX = 'yucp_dashboard_quick_start_dismissed:';
const SETUP_COMPLETE_PREFIX = 'yucp_dashboard_setup_completed:';
const platformProviders = getActiveSetupProviders();

function getTenantStorageKey(prefix) {
  return `${prefix}${getTenantId() || getGuildId() || 'unknown'}`;
}

export function loadProgressFlags() {
  try {
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
  return provider.iconUrl.replace('__API_BASE__', getApiBase());
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
    .filter((provider) => provider.setupState === 'ready')
    .map((provider) => provider.label)
    .join(', ');
}

function buildQuickStartButtons() {
  return platformProviders
    .map((provider) => {
      const disabled = provider.setupState !== 'ready';
      const action = disabled ? '' : `onclick="navigateProvider('${provider.key}')"`;
      const opacity = disabled ? 'opacity:0.55;cursor:not-allowed;' : '';
      const statusPill = disabled
        ? `<span style="font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.45);">Preview</span>`
        : '';
      return `
        <button ${action} ${disabled ? 'disabled' : ''} style="background: ${provider.quickStartButtonBg}; border: 1px solid ${provider.quickStartButtonBorder}; color: white; border-radius: 12px; padding: 14px; display: flex; align-items: center; justify-content: center; gap: 10px; font-size: 15px; font-family: 'Plus Jakarta Sans', sans-serif; font-weight: 700; transition: background 0.2s; ${opacity}">
          <img src="${resolveIconUrl(provider)}" style="width: 20px; border-radius: 4px;" alt="">
          <span>${provider.quickStartDescription}</span>
          ${statusPill}
        </button>
      `;
    })
    .join('');
}

function providerButtonLabel(provider, isLinked) {
  if (isLinked) return getHasSetupSession() ? 'Disconnect' : 'Connected';
  if (provider.setupState === 'preview') return 'Setup Soon';
  return 'Link Account';
}

function providerStatusLabel(provider, isLinked) {
  if (isLinked) return 'Connected';
  return provider.setupState === 'preview' ? 'Preview' : 'Not Linked';
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
                <img class="${provider.iconClassName}" src="${resolveIconUrl(provider)}" alt="${provider.label}">
              </div>
              <span id="${provider.key}-status" class="status-pill disconnected">${providerStatusLabel(provider, false)}</span>
            </div>
            <div>
              <h3 class="font-bold text-base mb-0.5">${provider.label}</h3>
              <p class="text-xs text-white/60" style="font-family:'DM Sans',sans-serif;">${provider.description}</p>
            </div>
            <button id="${provider.key}-btn" class="card-action-btn link" type="button">${providerButtonLabel(provider, false)}</button>
            <div class="inline-confirm" id="${provider.key}-disconnect-confirm">
              <div>
                <div class="inline-confirm-body">
                  <span class="inline-confirm-label">Disconnect <strong>${provider.label}</strong>? This removes all syncing.</span>
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
                <img src="${resolveIconUrl(provider)}" alt="${provider.label}" style="border-radius:4px;">
              </div>
              <div class="svr-cfg-tile-text">
                <span class="svr-cfg-tile-label">${provider.serverTileLabel}</span>
                <span class="svr-cfg-tile-hint">${provider.serverTileHint}</span>
              </div>
            </div>
            <div class="svr-cfg-tile-ctrl">
              <div id="toggle-serverEnable${provider.key[0].toUpperCase()}${provider.key.slice(1)}" class="svr-cfg-switch active" role="switch" aria-label="${provider.serverTileLabel}"></div>
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
          <button onclick="dismissQuickStart()" style="background: transparent; color: rgba(255,255,255,0.4); border: none; font-size: 13px; font-family: 'DM Sans', sans-serif; cursor: pointer; text-decoration: underline; text-underline-offset: 4px;">I'll set this up later</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
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

export async function navigateGumroad() {
  if (getSetupToken()) {
    const restored = await ensureSetupSessionCookie();
    if (!restored) {
      redirectToExpiredLinkError();
      return;
    }
  }
  const tid = getTenantId();
  const gid = getGuildId();
  if (tid && gid) {
    window.location.href = `${getApiBase()}/api/connect/gumroad/begin?tenantId=${encodeURIComponent(tid)}&guildId=${encodeURIComponent(gid)}`;
  } else if (getHasSetupSession()) {
    window.location.href = `${getApiBase()}/api/connect/gumroad/begin`;
  } else {
    alert('Please wait for the page to finish loading.');
  }
}

export async function navigateJinxxy() {
  if (getSetupToken()) {
    const restored = await ensureSetupSessionCookie();
    if (!restored) {
      redirectToExpiredLinkError();
      return;
    }
  }
  const tid = getTenantId();
  const gid = getGuildId();
  if (tid && gid) {
    window.location.href = `${getApiBase()}/jinxxy-setup?tenant_id=${encodeURIComponent(tid)}&guild_id=${encodeURIComponent(gid)}`;
  } else if (getHasSetupSession()) {
    window.location.href = `${getApiBase()}/jinxxy-setup`;
  } else {
    alert('Please wait for the page to finish loading.');
  }
}

export async function navigateLemonSqueezy() {
  if (getSetupToken()) {
    const restored = await ensureSetupSessionCookie();
    if (!restored) {
      redirectToExpiredLinkError();
      return;
    }
  }
  if (!getHasSetupSession() || !getTenantId()) {
    alert('Please open Lemon Squeezy setup from a secure Discord setup link.');
    return;
  }

  const apiToken = window.prompt('Paste your Lemon Squeezy API token');
  if (!apiToken) return;

  const createRes = await apiFetch(`${getApiBase()}/v1/tenants/${encodeURIComponent(getTenantId())}/provider-connections`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ providerKey: 'lemonsqueezy', authMode: 'api_token', label: 'Lemon Squeezy' }),
  });
  const createData = await createRes.json().catch(() => ({}));
  if (!createRes.ok || !createData.connectionId) {
    alert(createData?.error || 'Failed to create Lemon Squeezy connection.');
    return;
  }

  let payload = { apiToken };
  let credentialsRes = await apiFetch(`${getApiBase()}/v1/provider-connections/${encodeURIComponent(createData.connectionId)}/credentials`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (credentialsRes.status === 409) {
    const conflictData = await credentialsRes.json().catch(() => ({}));
    const options = (conflictData.availableStores || [])
      .map((store) => `${store.id}: ${store.name}`)
      .join('\n');
    const selectedStoreId = window.prompt(`Multiple Lemon Squeezy stores were found.\nChoose a store ID:\n${options}`);
    if (!selectedStoreId) return;
    payload = { apiToken, storeId: selectedStoreId.trim() };
    credentialsRes = await apiFetch(`${getApiBase()}/v1/provider-connections/${encodeURIComponent(createData.connectionId)}/credentials`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }

  const credentialsData = await credentialsRes.json().catch(() => ({}));
  if (!credentialsRes.ok) {
    alert(credentialsData?.error || 'Failed to validate Lemon Squeezy credentials.');
    return;
  }

  connectionsMap.set('lemonsqueezy', {
    id: createData.connectionId,
    provider: 'lemonsqueezy',
    providerKey: 'lemonsqueezy',
    status: 'active',
  });
  updatePlatformCards();
  alert(`Lemon Squeezy connected${credentialsData?.store?.name ? `: ${credentialsData.store.name}` : '.'}`);
}

export async function navigateProvider(providerKey) {
  if (providerKey === 'gumroad') {
    return navigateGumroad();
  }
  if (providerKey === 'jinxxy') {
    return navigateJinxxy();
  }
  if (providerKey === 'lemonsqueezy') {
    return navigateLemonSqueezy();
  }
  return undefined;
}

export function updatePlatformCards() {
  platformProviders.forEach((provider) => {
    updateCard(provider.key, connectionsMap.has(provider.key));
  });
  renderQuickStart();
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
    btn.className = getHasSetupSession() ? 'card-action-btn disconnect' : 'card-action-btn link';
    btn.innerText = providerButtonLabel(provider, true);
    btn.style = '';
    btn.onclick = getHasSetupSession() ? () => openModal(platform) : null;
    btn.disabled = !getHasSetupSession();
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
  ['verificationScope', 'duplicateVerificationBehavior', 'suspiciousAccountBehavior'].forEach((key) => {
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
  if (!getHasSetupSession()) {
    alert('Settings can only be changed using a secure setup link from Discord.');
    return;
  }
  const el = document.getElementById(`toggle-${key}`);
  const newValue = !settingsMap.get(key);
  el.classList.toggle('active');
  settingsMap.set(key, newValue);
  try {
    const res = await apiFetch(`${getApiBase()}/api/connect/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, value: newValue }) });
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
  }
}

async function selectSetting(key, value) {
  if (!getHasSetupSession()) {
    alert('Settings can only be changed using a secure setup link from Discord.');
    return;
  }
  const oldValue = settingsMap.get(key);
  settingsMap.set(key, value);
  try {
    const res = await apiFetch(`${getApiBase()}/api/connect/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, value }) });
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
  if (!getHasSetupSession()) return;
  const conn = connectionsMap.get(platform);
  if (!conn) return;
  const btn = document.getElementById(`${platform}-confirm-btn`);
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Disconnecting…';
  }
  try {
    const res = await apiFetch(`${getApiBase()}/api/connections?id=${conn.id}`, { method: 'DELETE' });
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

export async function fetchAllData() {
  try {
    if (getHasSetupSession()) {
      const statusRes = await apiFetch(`${getApiBase()}/api/connections`);
      if (statusRes.ok) {
        const statusData = await statusRes.json();
        connectionsMap.clear();
        if (statusData.connections) {
          statusData.connections.forEach((c) => {
            if (c.status === 'active') connectionsMap.set(c.provider, c);
          });
        }
        updatePlatformCards();
      }
      const settingsRes = await apiFetch(`${getApiBase()}/api/connect/settings`);
      if (settingsRes.ok) {
        const settingsData = await settingsRes.json();
        if (settingsData.policy) {
          const policy = settingsData.policy;
          ['allowMismatchedEmails', 'autoVerifyOnJoin', 'shareVerificationWithServers', 'enableDiscordRoleFromOtherServers', 'verificationScope', 'duplicateVerificationBehavior', 'suspiciousAccountBehavior'].forEach((k) => {
            if (policy[k] !== undefined) settingsMap.set(k, policy[k]);
          });
          updateSettingsUI();
        }
      }
    } else if (getTenantId()) {
      const statusRes = await apiFetch(`${getApiBase()}/api/connect/status?tenantId=${encodeURIComponent(getTenantId())}`);
      if (statusRes.ok) {
        const statusData = await statusRes.json();
        connectionsMap.clear();
        if (Array.isArray(statusData.connections)) {
          statusData.connections.forEach((connection) => {
            const providerKey = connection.providerKey || connection.provider;
            if (providerKey) connectionsMap.set(providerKey, connection);
          });
        } else {
          if (statusData.gumroad) connectionsMap.set('gumroad', { provider: 'gumroad', status: 'active' });
          if (statusData.jinxxy) connectionsMap.set('jinxxy', { provider: 'jinxxy', status: 'active' });
        }
        updatePlatformCards();
      }
    }
  } catch (err) {
    console.error('Failed to fetch data', err);
  }
}

function initCustomSelects() {
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

export function initPlatforms() {
  renderPlatformScaffolding();
  window.navigateGumroad = navigateGumroad;
  window.navigateJinxxy = navigateJinxxy;
  window.navigateLemonSqueezy = navigateLemonSqueezy;
  window.navigateProvider = navigateProvider;
  window.dismissQuickStart = dismissQuickStart;
  window.toggleSetting = toggleSetting;
  window.selectSetting = selectSetting;
  window.cancelDisconnect = cancelDisconnect;

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
