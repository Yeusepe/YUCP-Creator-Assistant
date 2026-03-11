import { getConfig } from './config.js';
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

function getConnectedProvidersCount() {
  let count = 0;
  if (connectionsMap.has('gumroad')) count += 1;
  if (connectionsMap.has('jinxxy')) count += 1;
  return count;
}

function hasMeaningfulSettings() {
  return settingsTouched || settingsMap.size > 0;
}

function getQuickStartState() {
  const connectedProviders = getConnectedProvidersCount();
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
    storesDone,
    settingsDone,
    finalReady,
    done,
    completedCount,
    title,
    summary,
    progressPercent: Math.round((completedCount / 3) * 100),
    steps: [
      { id: 'stores', sectionId: 'platforms-grid', state: storesDone ? 'complete' : 'active', number: '01', label: storesDone ? 'Complete' : 'Current', title: storesDone ? `${connectedProviders} store${connectedProviders > 1 ? 's' : ''} linked` : 'Connect Gumroad or Jinxxy', body: storesDone ? 'Your storefront credentials are connected. You can add another store or move on.' : 'Use the platform cards below to connect the storefronts you actually sell through.', meta: storesDone ? `Connected: ${Array.from(connectionsMap.keys()).filter((k) => k === 'gumroad' || k === 'jinxxy').join(' + ')}` : 'Start with the platform cards', action: storesDone ? 'Review platforms' : 'Go to platforms' },
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
            <button onclick="navigateGumroad()" style="background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); color: white; border-radius: 12px; padding: 14px; display: flex; align-items: center; justify-content: center; gap: 10px; font-size: 15px; font-family: 'Plus Jakarta Sans', sans-serif; font-weight: 700; cursor: pointer; transition: background 0.2s;" onmouseover="this.style.background='rgba(255,255,255,0.1)'" onmouseout="this.style.background='rgba(255,255,255,0.05)'">
              <img src="https://cdn.brandfetch.io/idMw8qr5lW/w/400/h/400/theme/dark/icon.png?c=1bxid64Mup7aczewSAYMX&t=1667593186460" style="width: 20px; border-radius: 4px;" alt=""> Connect Gumroad
            </button>
            <button onclick="navigateJinxxy()" style="background: rgba(145,70,255,0.1); border: 1px solid rgba(145,70,255,0.3); color: white; border-radius: 12px; padding: 14px; display: flex; align-items: center; justify-content: center; gap: 10px; font-size: 15px; font-family: 'Plus Jakarta Sans', sans-serif; font-weight: 700; cursor: pointer; transition: background 0.2s;" onmouseover="this.style.background='rgba(145,70,255,0.2)'" onmouseout="this.style.background='rgba(145,70,255,0.1)'">
              <img src="https://cdn.brandfetch.io/id5SOeZxOy/w/400/h/400/theme/dark/icon.jpeg?c=1bxid64Mup7aczewSAYMX&t=1770481661483" style="width: 20px; border-radius: 4px;" alt=""> Connect Jinxxy
            </button>
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

export function updatePlatformCards() {
  updateCard('gumroad', connectionsMap.has('gumroad'));
  updateCard('jinxxy', connectionsMap.has('jinxxy'));
  renderQuickStart();
}

function updateCard(platform, isLinked) {
  const card = document.getElementById(`${platform}-card`);
  const status = document.getElementById(`${platform}-status`);
  const btn = document.getElementById(`${platform}-btn`);
  if (!card || !status || !btn) return;

  card.style.display = 'flex';
  if (isLinked) {
    card.classList.remove('disconnected');
    card.classList.add('connected');
    status.className = 'status-pill connected';
    status.innerText = 'Connected';
    btn.className = 'card-action-btn disconnect';
    btn.innerText = 'Disconnect';
    btn.style = '';
    btn.onclick = () => openModal(platform);
  } else {
    card.classList.add('disconnected');
    card.classList.remove('connected');
    status.className = 'status-pill disconnected';
    status.innerText = 'Not Linked';
    btn.className = 'card-action-btn link';
    btn.innerText = 'Link Account';
    btn.style = '';
    btn.onclick = () => (platform === 'gumroad' ? navigateGumroad() : navigateJinxxy());
  }

  const tGumroad = document.getElementById('server-tile-gumroad');
  const tJinxxy = document.getElementById('server-tile-jinxxy');
  const sEmpty = document.getElementById('server-integrations-empty');
  if (tGumroad && tJinxxy && sEmpty) {
    const hasGumroad = connectionsMap.has('gumroad');
    const hasJinxxy = connectionsMap.has('jinxxy');
    tGumroad.style.display = hasGumroad ? 'flex' : 'none';
    tJinxxy.style.display = hasJinxxy ? 'flex' : 'none';
    sEmpty.style.display = hasGumroad || hasJinxxy ? 'none' : 'block';
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
  ['gumroad', 'jinxxy'].forEach((p) => {
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
        updateCard('gumroad', statusData.gumroad);
        updateCard('jinxxy', statusData.jinxxy);
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
  window.navigateGumroad = navigateGumroad;
  window.navigateJinxxy = navigateJinxxy;
  window.dismissQuickStart = dismissQuickStart;
  window.toggleSetting = toggleSetting;
  window.selectSetting = selectSetting;
  window.cancelDisconnect = cancelDisconnect;

  document.querySelectorAll('.setting-select, .svr-cfg-pick').forEach((select) => {
    const key = select.id?.replace('select-', '') || '';
    if (key) select.addEventListener('change', (e) => selectSetting(key, select.value));
  });

  document.getElementById('gumroad-confirm-btn')?.addEventListener('click', () => confirmDisconnect('gumroad'));
  document.getElementById('jinxxy-confirm-btn')?.addEventListener('click', () => confirmDisconnect('jinxxy'));
  document.querySelectorAll('[data-cancel-disconnect]').forEach((el) => {
    const platform = el.getAttribute('data-cancel-disconnect');
    el.addEventListener('click', () => document.getElementById(`${platform}-disconnect-confirm`)?.classList.remove('open'));
  });

  document.getElementById('quick-start-dismiss')?.addEventListener('click', dismissQuickStart);
  initCustomSelects();
}
