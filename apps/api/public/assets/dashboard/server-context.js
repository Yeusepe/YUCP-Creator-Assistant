import {
  getApiBase,
  getTenantId,
  getGuildId,
  setGuildId,
  setTenantId,
  getHasSetupSession,
  setHasSetupSession,
  apiFetch,
  connectionsMap,
} from './store.js';
import { escHtml } from './utils.js';

let userServers = null;
let filteredServers = null;
let _setDropdownOpen = null;
let _refreshData = null;

export function getServerIconUrl(server) {
  if (server.iconUrl) return server.iconUrl;
  if (server.icon) {
    const sId = server.id || server.guildId;
    const ext = server.icon.startsWith('a_') ? 'gif' : 'png';
    return `https://cdn.discordapp.com/icons/${sId}/${server.icon}.${ext}`;
  }
  return null;
}

function applyContextState() {
  const guildId = getGuildId();
  if (guildId && guildId !== '') {
    document.body.classList.add('state-server-selected');
  } else {
    document.body.classList.remove('state-server-selected');
  }
}

export async function switchDashboardContext(newGuildId, deps) {
  if (newGuildId === getGuildId()) return;
  if (window.switchToTab) window.switchToTab('setup');

  const urlParams = new URLSearchParams(window.location.search);
  if (newGuildId) {
    urlParams.set('guild_id', newGuildId);
  } else {
    urlParams.delete('guild_id');
  }
  // Always clear tenant_id when switching guilds; it will be re-resolved for the new guild.
  urlParams.delete('tenant_id');
  const newUrl = window.location.pathname + (urlParams.toString() ? '?' + urlParams.toString() : '');
  window.history.pushState({ guildId: newGuildId }, '', newUrl);

  setGuildId(newGuildId);
  setTenantId('');
  applyContextState();

  if (newGuildId && userServers) {
    const currentServer = userServers.find((s) => (s.id || s.guildId) === newGuildId);
    if (currentServer) {
      const sIconUrl = getServerIconUrl(currentServer);
      const nameEl = document.getElementById('sidebar-selected-name');
      const iconEl = document.getElementById('sidebar-selected-icon');
      if (nameEl) nameEl.textContent = currentServer.name || 'Unnamed';
      if (iconEl) {
        if (sIconUrl) {
          const img = document.createElement('img');
          img.setAttribute('src', sIconUrl);
          img.setAttribute('alt', '');
          img.style.cssText = 'width:100%;height:100%;border-radius:50%;object-fit:cover;';
          iconEl.innerHTML = '';
          iconEl.appendChild(img);
        } else {
          const initials = (currentServer.name || '?').split(' ').map((w) => w[0]).join('').substring(0, 2).toUpperCase() || '?';
          const div = document.createElement('div');
          div.className = 'fallback-icon';
          div.textContent = initials;
          iconEl.innerHTML = '';
          iconEl.appendChild(div);
        }
      }
    }
  } else {
    const nameEl = document.getElementById('sidebar-selected-name');
    const iconEl = document.getElementById('sidebar-selected-icon');
    if (nameEl) nameEl.textContent = 'Personal Dashboard';
    if (iconEl) iconEl.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>`;
  }

  if (deps?.renderServerList && filteredServers) deps.renderServerList(filteredServers);
  const refresh = deps?.refreshData ?? _refreshData;
  if (refresh) {
    await refresh();
  } else if (deps?.updatePlatformCards) {
    deps.updatePlatformCards();
  }
}

function renderServerList(servers) {
  const listEl = document.getElementById('server-dropdown-list');
  if (!listEl) return;
  listEl.replaceChildren();

  if (!servers || servers.length === 0) {
    listEl.innerHTML = '<div class="server-dropdown-empty">No servers found.</div>';
    return;
  }

  const frag = document.createDocumentFragment();
  servers.forEach((server) => {
    const sId = server.id || server.guildId;
    const item = document.createElement('div');
    item.className = 'server-dropdown-item' + (sId === getGuildId() ? ' active' : '');

    let iconHtml = '';
    const sIconUrl = getServerIconUrl(server);
    if (sIconUrl) {
      iconHtml = `<img src="${sIconUrl}" alt="" loading="lazy">`;
    } else {
      const initials = (server.name || '?').split(' ').map((w) => w[0]).join('').substring(0, 2).toUpperCase() || '?';
      iconHtml = `<div class="fallback-icon">${initials}</div>`;
    }

    item.innerHTML = `${iconHtml}<span>${escHtml(server.name || 'Unnamed')}</span>`;

    item.addEventListener('click', (e) => {
      e.stopPropagation();
      _setDropdownOpen?.(false);
      switchDashboardContext(sId, { renderServerList, updatePlatformCards: window.__updatePlatformCards, refreshData: _refreshData });
    });

    frag.appendChild(item);
  });

  listEl.appendChild(frag);
}

function renderParticipatingServers(servers) {
  const section = document.getElementById('collab-servers-section');
  if (!section) return;

  let container = document.getElementById('participating-servers-list');
  if (!container) {
    container = document.createElement('div');
    container.id = 'participating-servers-list';
    container.className = 'grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4';
    section.appendChild(container);
  }

  container.innerHTML = '';

  if (!servers || servers.length === 0) {
    container.innerHTML = `
      <div class="bento-col-12 empty-state platform-card flex items-center justify-center text-center" style="margin: 0;">
        <div class="intg-icon" style="margin: 0 auto 16px; width: 40px; height: 40px; background: rgba(14,165,233,0.1); color: #0ea5e9;">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M5 12h14M12 5l7 7-7 7" />
          </svg>
        </div>
        <p class="participating-server-name font-bold mb-2" style="font-family:'Plus Jakarta Sans',sans-serif; font-size: 16px;">No participating servers</p>
        <p class="participating-server-hint max-w-sm mx-auto mb-6" style="font-family:'DM Sans',sans-serif; font-size: 13px; line-height:1.5;">You aren't managing any servers yet. Install the Assistant to your server to connect your storefront data.</p>
        <button class="btn-primary" data-action="invite-bot" style="margin: 0 auto; background: #0ea5e9; color: #fff; border: none; padding: 10px 20px; font-weight: 700; border-radius: 8px;">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 6px;">
            <path d="M12 5v14M5 12h14"/>
          </svg>
          Add Assistant to Server
        </button>
      </div>
    `;
    const inviteBtn = container.querySelector('[data-action="invite-bot"]');
    if (inviteBtn) {
      inviteBtn.addEventListener('click', () => {
        window.open('https://discord.com/api/oauth2/authorize?client_id=1460374394663735582&permissions=327222946816&scope=bot%20applications.commands', '_blank');
      });
    }
    return;
  }

  servers.forEach((server) => {
    const sId = server.id || server.guildId;
    const sIconUrl = getServerIconUrl(server);
    const card = document.createElement('div');
    card.className = 'platform-card connected flex items-center gap-3 cursor-pointer hover:bg-white/5 transition-colors';
    card.style.padding = '12px 16px';

    let iconHtml = '';
    if (sIconUrl) {
      iconHtml = `<img src="${sIconUrl}" class="w-10 h-10 rounded-full object-cover" alt="" loading="lazy">`;
    } else {
      const initials = (server.name || '?').split(' ').map((w) => w[0]).join('').substring(0, 2).toUpperCase() || '?';
      iconHtml = `<div class="w-10 h-10 rounded-full bg-white/10 flex items-center justify-center font-bold text-white/70">${initials}</div>`;
    }

    card.innerHTML = `
      ${iconHtml}
      <div style="flex:1;min-width:0;">
        <div class="participating-server-name font-bold text-base truncate">${escHtml(server.name || 'Unnamed')}</div>
        <div class="participating-server-hint text-xs">Manage Settings →</div>
      </div>
    `;

    card.addEventListener('click', () => switchDashboardContext(sId, { renderServerList, updatePlatformCards: window.__updatePlatformCards, refreshData: _refreshData }));

    container.appendChild(card);
  });
}

async function loadUserServers(updatePlatformCards, options = {}) {
  const listEl = document.getElementById('server-dropdown-list');
  if (!listEl) return;
  listEl.innerHTML = '<div class="server-dropdown-loading">Loading servers...</div>';

  const tenantId = getTenantId();
  const cacheKey = `ca_servers_${tenantId || 'global'}_V1`;
  const force = options.force === true;
  const cached = force ? null : sessionStorage.getItem(cacheKey);

  try {
    if (cached) {
      userServers = JSON.parse(cached);
    } else {
      const res = await apiFetch(`${getApiBase()}/api/connect/user/guilds`);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const data = await res.json();
      userServers = data.guilds || data.servers || [];
      sessionStorage.setItem(cacheKey, JSON.stringify(userServers));
    }

    filteredServers = [...userServers];
    renderServerList(filteredServers);
    renderParticipatingServers(filteredServers);

    const guildId = getGuildId();
    if (guildId && userServers.length > 0) {
      const currentServer = userServers.find((s) => (s.id || s.guildId) === guildId);
      if (currentServer) {
        const nameEl = document.getElementById('sidebar-selected-name');
        const iconEl = document.getElementById('sidebar-selected-icon');
        if (nameEl) nameEl.textContent = currentServer.name || 'Unnamed';
        const sIconUrl = getServerIconUrl(currentServer);
        if (iconEl) {
          if (sIconUrl) {
            const img = document.createElement('img');
            img.setAttribute('src', sIconUrl);
            img.setAttribute('alt', '');
            img.style.cssText = 'width:100%;height:100%;border-radius:50%;object-fit:cover;';
            iconEl.innerHTML = '';
            iconEl.appendChild(img);
          } else {
            const initials = (currentServer.name || '?').split(' ').map((w) => w[0]).join('').substring(0, 2).toUpperCase() || '?';
            const div = document.createElement('div');
            div.className = 'fallback-icon';
            div.textContent = initials;
            iconEl.innerHTML = '';
            iconEl.appendChild(div);
          }
        }
      }
    }
  } catch (err) {
    console.warn('Server fetch failed', err);
    userServers = [];
    listEl.innerHTML = '<div class="server-dropdown-empty">Failed to load servers.</div>';
  }
}

export async function refreshUserServers(updatePlatformCards) {
  const tenantId = getTenantId();
  const cacheKey = `ca_servers_${tenantId || 'global'}_V1`;

  try {
    sessionStorage.removeItem(cacheKey);
  } catch (_) {
    // Ignore storage failures and fall back to an in-memory refresh.
  }

  userServers = null;
  filteredServers = null;
  await loadUserServers(updatePlatformCards, { force: true });
}

export function initServerContext(deps) {
  window.__updatePlatformCards = deps?.updatePlatformCards;
  _refreshData = deps?.refreshData ?? null;

  applyContextState();

  window.addEventListener('popstate', () => {
    const urlParams = new URLSearchParams(window.location.search);
    const stateGuildId = urlParams.get('guild_id') || '';
    if (stateGuildId !== getGuildId()) {
      switchDashboardContext(stateGuildId, deps);
    }
  });

  const selector = document.getElementById('sidebar-server-selector');
  const menu = document.getElementById('server-dropdown-menu');
  const backdrop = document.getElementById('server-dropdown-backdrop');
  const searchInput = document.getElementById('server-search-input');
  const personalBtn = document.getElementById('btn-personal-dashboard');

  if (!selector || !menu) return;

  const logoArea = selector.parentElement;

  _setDropdownOpen = function setDropdownOpen(open) {
    if (open) {
      const rect = selector.getBoundingClientRect();
      document.body.appendChild(selector);
      selector.classList.add('server-selector-portal');
      selector.style.setProperty('--selector-top', `${rect.top}px`);
      selector.style.setProperty('--selector-left', `${rect.left}px`);
      selector.style.setProperty('--selector-width', `${rect.width}px`);
      menu.classList.add('open', 'server-dropdown-menu-portal');
      menu.style.setProperty('--dropdown-top', `${rect.bottom + 8}px`);
      menu.style.setProperty('--dropdown-left', `${rect.left}px`);
      menu.style.setProperty('--dropdown-width', `${rect.width}px`);
      backdrop?.classList.add('open');
      document.body.classList.add('server-dropdown-open');
    } else {
      selector.classList.remove('server-selector-portal');
      selector.style.removeProperty('--selector-top');
      selector.style.removeProperty('--selector-left');
      selector.style.removeProperty('--selector-width');
      logoArea?.appendChild(selector);
      menu.classList.remove('open', 'server-dropdown-menu-portal');
      menu.style.removeProperty('--dropdown-top');
      menu.style.removeProperty('--dropdown-left');
      menu.style.removeProperty('--dropdown-width');
      backdrop?.classList.remove('open');
      document.body.classList.remove('server-dropdown-open');
    }
  };

  selector.addEventListener('click', async (e) => {
    if (menu.contains(e.target) && !e.target.closest('.server-dropdown-item') && e.target !== personalBtn) return;
    const isOpen = menu.classList.contains('open');
    if (isOpen) {
      _setDropdownOpen(false);
    } else {
      document.querySelectorAll('.dropdown-menu.open, .custom-select-wrapper.open').forEach((w) => w.classList.remove('open'));
      _setDropdownOpen(true);
      searchInput?.focus();
      if (!userServers) await loadUserServers(deps?.updatePlatformCards);
    }
  });

  backdrop?.addEventListener('click', () => _setDropdownOpen(false));

  document.addEventListener('click', (e) => {
    if (!selector.contains(e.target) && !backdrop?.contains(e.target) && !menu.contains(e.target)) _setDropdownOpen(false);
  });

  searchInput?.addEventListener('input', (e) => {
    const term = e.target.value.toLowerCase();
    if (!userServers) return;
    filteredServers = userServers.filter((s) => s.name.toLowerCase().includes(term));
    renderServerList(filteredServers);
  });

  personalBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    _setDropdownOpen(false);
    switchDashboardContext('', deps);
  });

  const signOutBtn = document.getElementById('btn-sign-out');
  signOutBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    _setDropdownOpen(false);

    try {
      for (let index = sessionStorage.length - 1; index >= 0; index -= 1) {
        const key = sessionStorage.key(index);
        if (key?.startsWith('ca_servers_')) {
          sessionStorage.removeItem(key);
        }
      }
    } catch (_) {
      // Ignore storage cleanup failures and continue with sign-out.
    }

    const form = document.createElement('form');
    form.method = 'POST';
    form.action = `${getApiBase()}/sign-out?redirectTo=${encodeURIComponent('/sign-in')}`;
    form.style.display = 'none';
    document.body.appendChild(form);
    form.submit();
  });

  if (!getGuildId()) {
    const nameEl = document.getElementById('sidebar-selected-name');
    const iconPath = document.querySelector('#sidebar-selected-icon path');
    if (nameEl) nameEl.textContent = 'Personal Dashboard';
    if (iconPath) iconPath.setAttribute('d', 'M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z');
  }

  loadUserServers(deps?.updatePlatformCards);

  // Server config "Disconnect" button (Danger Zone)
  const disconnectBtn = document.getElementById('server-disconnect-btn');
  const stepsContainer = document.getElementById('server-disconnect-steps');
  if (disconnectBtn && stepsContainer) {
    let currentStep = 0;

    function getServerName() {
      const nameEl = document.getElementById('sidebar-selected-name');
      return nameEl?.textContent || 'this server';
    }

    function renderStep(step) {
      currentStep = step;
      if (step === 0) {
        stepsContainer.style.display = 'none';
        stepsContainer.innerHTML = '';
        return;
      }
      stepsContainer.style.display = 'block';

      const steps = [
        {
          emoji: '⚠️', title: 'Warning: Disconnect Server', color: '#ffa500',
          borderColor: 'rgba(255,165,0,0.2)', bgColor: 'rgba(255,165,0,0.15)', borderBtn: 'rgba(255,165,0,0.3)',
          text: () => `You are about to disconnect <strong style="color:#fff;">${escHtml(getServerName())}</strong> from your Creator Assistant account. This will completely stop role verification.`,
          btn: 'I understand, continue',
        },
        {
          emoji: '🚨', title: 'Danger: Data Deletion', color: '#ff4500',
          borderColor: 'rgba(255,69,0,0.2)', bgColor: 'rgba(255,69,0,0.15)', borderBtn: 'rgba(255,69,0,0.3)',
          text: () => `Disconnecting will <strong style="color: #ff4500;">PERMANENTLY DELETE</strong> all verification rules, download routes, and verification history for this server. Users will not lose their roles, but they will not be updated anymore.`,
          btn: 'Yes, I am sure',
        },
        {
          emoji: '🛑', title: 'FINAL CONFIRMATION', color: '#ef4444',
          borderColor: 'rgba(255,0,0,0.2)', bgColor: 'rgba(239,68,68,0.15)', borderBtn: 'rgba(239,68,68,0.3)',
          text: () => `This action <strong style="color: #ef4444;">CANNOT</strong> be undone. Are you absolutely sure you want to completely disconnect and destroy all data for <strong style="color:#fff;">${escHtml(getServerName())}</strong>?`,
          btn: 'Confirm Disconnect',
        },
      ];

      const s = steps[step - 1];
      stepsContainer.innerHTML = `
        <div style="margin-top: 12px; padding: 16px; border-radius: 12px; border: 1px solid ${s.borderColor}; background: rgba(0,0,0,0.2);">
          <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 10px;">
            <span style="font-size: 18px;">${s.emoji}</span>
            <span style="font-size: 14px; font-weight: 700; color: ${s.color}; font-family: 'Plus Jakarta Sans', sans-serif;">${s.title}</span>
          </div>
          <p style="font-size: 13px; color: rgba(255,255,255,0.7); margin: 0 0 14px; font-family: 'DM Sans', sans-serif; line-height: 1.5;">
            ${s.text()}
          </p>
          <div style="display: flex; gap: 8px; justify-content: flex-end;">
            <button id="dc-step-cancel" style="
              background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1); color: rgba(255,255,255,0.7);
              padding: 8px 16px; border-radius: 8px; font-size: 13px; font-weight: 600; cursor: pointer;
              font-family: 'Plus Jakarta Sans', sans-serif; transition: all 0.2s;
            ">Cancel</button>
            <button id="dc-step-next" style="
              background: ${s.bgColor}; border: 1px solid ${s.borderBtn}; color: ${s.color};
              padding: 8px 16px; border-radius: 8px; font-size: 13px; font-weight: 600; cursor: pointer;
              font-family: 'Plus Jakarta Sans', sans-serif; transition: all 0.2s;
            ">${s.btn}</button>
          </div>
        </div>
      `;

      stepsContainer.querySelector('#dc-step-cancel').addEventListener('click', () => renderStep(0));

      const nextBtn = stepsContainer.querySelector('#dc-step-next');
      if (step < 3) {
        nextBtn.addEventListener('click', () => renderStep(step + 1));
      } else {
        // Final step → call API
        nextBtn.addEventListener('click', async () => {
          nextBtn.disabled = true;
          nextBtn.textContent = 'Disconnecting…';
          const gid = getGuildId();
          try {
            const res = await apiFetch(`${getApiBase()}/api/install/uninstall/${encodeURIComponent(gid)}`, { method: 'POST' });
            if (res.ok) {
              userServers = userServers ? userServers.filter((s) => (s.id || s.guildId) !== gid) : null;
              filteredServers = filteredServers ? filteredServers.filter((s) => (s.id || s.guildId) !== gid) : null;
              const tenantId = getTenantId();
              const cacheKey = `ca_servers_${tenantId || 'global'}_V1`;
              sessionStorage.removeItem(cacheKey);
              renderStep(0);
              switchDashboardContext('', { renderServerList, updatePlatformCards: window.__updatePlatformCards });
              if (filteredServers) {
                renderServerList(filteredServers);
                renderParticipatingServers(filteredServers);
              }
            } else {
              const data = await res.json().catch(() => ({}));
              alert(data.error || 'Failed to disconnect server. Please try again.');
              nextBtn.disabled = false;
              nextBtn.textContent = 'Confirm Disconnect';
            }
          } catch (err) {
            console.error('Server disconnect error:', err);
            alert('Network error while disconnecting server.');
            nextBtn.disabled = false;
            nextBtn.textContent = 'Confirm Disconnect';
          }
        });
      }
    }

    disconnectBtn.addEventListener('click', () => {
      renderStep(currentStep === 0 ? 1 : 0);
    });
  }
}
