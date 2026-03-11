import {
  getApiBase,
  getTenantId,
  apiFetch,
  oauthApps,
  setOAuthApps,
} from './store.js';
import { escHtml } from './utils.js';
import { copyText } from './utils.js';

function renderOAuthAppsSection() {
  const loading = document.getElementById('oauth-apps-loading');
  const list = document.getElementById('oauth-apps-list');
  const empty = document.getElementById('oauth-apps-empty');
  const signinRequired = document.getElementById('oauth-apps-signin-required');
  const createBtn = document.getElementById('create-oauth-app-btn');

  loading?.classList.add('hidden');
  if (signinRequired) signinRequired.classList.add('hidden');
  if (createBtn) createBtn.classList.remove('hidden');

  if (list) {
    list.replaceChildren();
    list.classList.remove('hidden');
  }
  if (empty) empty.classList.add('hidden');

  if (oauthApps.length === 0) {
    if (empty) empty.classList.remove('hidden');
    if (list) list.classList.add('hidden');
    return;
  }

  for (const app of oauthApps) {
    const id = app._id;
    const scopePills = (app.scopes || []).map((s) => `<span class="oauth-scope-pill">${escHtml(s)}</span>`).join('');
    const uriPills = (app.redirectUris || []).map((u) => `<span class="oauth-app-uri" title="${escHtml(u)}">${escHtml(u)}</span>`).join('');
    const dateStr = app._creationTime ? 'Created ' + new Date(app._creationTime).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '';
    const editScopeVr = (app.scopes || []).includes('verification:read') ? 'checked' : '';
    const editScopeSr = (app.scopes || []).includes('subjects:read') ? 'checked' : '';
    const editUris = escHtml((app.redirectUris || []).join('\n'));

    const card = document.createElement('div');
    card.className = 'oauth-app-card';
    card.id = `oauth-app-card-${id}`;
    card.innerHTML = `
      <div class="oauth-app-card-top">
        <div class="oauth-app-icon"><svg viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></div>
        <div class="oauth-app-body">
          <div class="oauth-app-name">${escHtml(app.name || 'Unnamed App')}</div>
          <div class="oauth-app-meta"><span class="oauth-app-client-id" title="Click to copy Client ID" id="oauth-cid-${id}">${escHtml(app.clientId)}</span>${dateStr ? `<span class="oauth-app-date">${dateStr}</span>` : ''}</div>
          ${scopePills ? `<div class="oauth-app-scopes">${scopePills}</div>` : ''}
          ${uriPills ? `<div class="oauth-app-uris">${uriPills}</div>` : ''}
        </div>
        <div class="oauth-app-actions dropdown-wrapper" id="oauth-menu-wrapper-${id}">
          <button class="oauth-app-menu-btn" type="button" id="oauth-menu-btn-${id}" aria-label="Actions" aria-haspopup="true" aria-expanded="false">
            <svg viewBox="0 0 24 24" width="16" height="16"><circle cx="12" cy="6" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="18" r="1.5"/></svg>
          </button>
          <div class="dropdown-menu" id="oauth-menu-${id}" role="menu">
            <button type="button" role="menuitem" id="oauth-menu-copy-${id}">Copy Client ID</button>
            <button type="button" role="menuitem" id="oauth-menu-regen-${id}">Regenerate Secret</button>
            <button type="button" role="menuitem" id="oauth-menu-edit-${id}">Edit</button>
            <button type="button" role="menuitem" class="dropdown-menu-item-danger" id="oauth-menu-del-${id}">Delete</button>
          </div>
        </div>
      </div>
      <div class="inline-panel" id="oauth-edit-panel-${id}">
        <div class="inline-panel-inner">
          <div class="oauth-edit-body">
            <div class="modal-field">
              <label class="modal-label" for="oauth-edit-name-${id}">App name</label>
              <input type="text" id="oauth-edit-name-${id}" class="modal-input" value="${escHtml(app.name || '')}" maxlength="64" autocomplete="off">
            </div>
            <div class="modal-field">
              <label class="modal-label" for="oauth-edit-uris-${id}">Redirect URIs (one per line)</label>
              <textarea id="oauth-edit-uris-${id}" rows="3" class="modal-textarea">${editUris}</textarea>
            </div>
            <div class="modal-field" style="margin-bottom:0;">
              <label class="modal-label">Scopes</label>
              <div class="scope-toggles">
                <label class="scope-toggle"><input type="checkbox" id="oauth-edit-scope-vr-${id}" ${editScopeVr}><div class="scope-toggle-card"><div class="scope-toggle-check"><svg viewBox="0 0 12 12"><polyline points="2 6 5 9 10 3"/></svg></div><div class="scope-toggle-text"><div class="scope-toggle-name">verification:read</div><div class="scope-toggle-desc">Check if a user is verified on your server</div></div></div></label>
                <label class="scope-toggle"><input type="checkbox" id="oauth-edit-scope-sr-${id}" ${editScopeSr}><div class="scope-toggle-card"><div class="scope-toggle-check"><svg viewBox="0 0 12 12"><polyline points="2 6 5 9 10 3"/></svg></div><div class="scope-toggle-text"><div class="scope-toggle-name">subjects:read</div><div class="scope-toggle-desc">Read verified users and purchase records</div></div></div></label>
              </div>
            </div>
            <div class="inline-btn-row">
              <button class="btn-primary" id="oauth-edit-save-${id}">Save changes</button>
              <button class="btn-ghost" id="oauth-edit-cancel-${id}">Cancel</button>
            </div>
          </div>
        </div>
      </div>
      <div class="inline-confirm" id="oauth-regen-confirm-${id}">
        <div><div class="oauth-regen-body">
          <span class="inline-confirm-label" style="flex:1;">Regenerate secret for <strong>${escHtml(app.name || 'this app')}</strong>? The old secret will stop working immediately.</span>
          <div class="inline-confirm-btns">
            <button class="inline-cancel-btn" id="oauth-regen-cancel-${id}">Cancel</button>
            <button class="inline-confirm-btn" id="oauth-regen-ok-${id}">Regenerate</button>
          </div>
        </div></div>
      </div>
      <div class="inline-confirm" id="oauth-delete-confirm-${id}">
        <div><div class="oauth-delete-body">
          <span class="inline-confirm-label" style="flex:1;">Delete <strong>${escHtml(app.name || 'this app')}</strong>? Active OAuth sessions will stop working immediately.</span>
          <div class="inline-confirm-btns">
            <button class="inline-cancel-btn" id="oauth-del-cancel-${id}">Cancel</button>
            <button class="inline-danger-btn" id="oauth-del-ok-${id}">Delete</button>
          </div>
        </div></div>
      </div>
    `;

    list?.appendChild(card);

    document.getElementById(`oauth-cid-${id}`)?.addEventListener('click', () => copyText(app.clientId, document.getElementById(`oauth-cid-${id}`), 'Copied!'));
    const menuBtn = document.getElementById(`oauth-menu-btn-${id}`);
    const menu = document.getElementById(`oauth-menu-${id}`);
    menuBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      document.querySelectorAll('.dropdown-menu.open').forEach((m) => {
        m.classList.remove('open');
        m.previousElementSibling?.setAttribute('aria-expanded', 'false');
      });
      menu?.classList.toggle('open');
      menuBtn.setAttribute('aria-expanded', menu?.classList.contains('open') || false);
    });
    document.getElementById(`oauth-menu-copy-${id}`)?.addEventListener('click', () => {
      copyText(app.clientId, menuBtn, 'Copied!');
      menu?.classList.remove('open');
    });
    document.getElementById(`oauth-menu-edit-${id}`)?.addEventListener('click', () => toggleOAuthPanel(id, 'edit'));
    document.getElementById(`oauth-menu-regen-${id}`)?.addEventListener('click', () => toggleOAuthPanel(id, 'regen'));
    document.getElementById(`oauth-menu-del-${id}`)?.addEventListener('click', () => toggleOAuthPanel(id, 'delete'));
    document.getElementById(`oauth-edit-save-${id}`)?.addEventListener('click', () => submitEditOAuthApp(id));
    document.getElementById(`oauth-edit-cancel-${id}`)?.addEventListener('click', () => toggleOAuthPanel(id, 'edit', false));
    document.getElementById(`oauth-regen-cancel-${id}`)?.addEventListener('click', () => toggleOAuthPanel(id, 'regen', false));
    document.getElementById(`oauth-regen-ok-${id}`)?.addEventListener('click', () => confirmRegenOAuthSecret(id));
    document.getElementById(`oauth-del-cancel-${id}`)?.addEventListener('click', () => toggleOAuthPanel(id, 'delete', false));
    document.getElementById(`oauth-del-ok-${id}`)?.addEventListener('click', () => confirmDeleteOAuthApp(id));
  }
}

function toggleOAuthPanel(appId, type, forceState) {
  const panels = {
    edit: document.getElementById(`oauth-edit-panel-${appId}`),
    regen: document.getElementById(`oauth-regen-confirm-${appId}`),
    delete: document.getElementById(`oauth-delete-confirm-${appId}`),
  };
  const target = panels[type];
  if (!target) return;
  const willOpen = forceState !== undefined ? forceState : !target.classList.contains('open');
  Object.values(panels).forEach((p) => p?.classList.remove('open'));
  if (willOpen) {
    target.classList.add('open');
    if (type === 'edit') setTimeout(() => document.getElementById(`oauth-edit-name-${appId}`)?.focus(), 380);
  }
}

function openCreateOAuthAppPanel() {
  const nameEl = document.getElementById('oauth-app-name');
  const urisEl = document.getElementById('oauth-app-redirect-uris');
  const vrEl = document.getElementById('create-oauth-scope-vr');
  const srEl = document.getElementById('create-oauth-scope-sr');
  if (nameEl) nameEl.value = '';
  if (urisEl) urisEl.value = '';
  if (vrEl) vrEl.checked = true;
  if (srEl) srEl.checked = false;
  document.getElementById('create-oauth-app-panel')?.classList.add('open');
  setTimeout(() => document.getElementById('oauth-app-name')?.focus(), 420);
}

function closeCreateOAuthAppPanel() {
  document.getElementById('create-oauth-app-panel')?.classList.remove('open');
}

async function submitCreateOAuthApp() {
  const name = document.getElementById('oauth-app-name')?.value?.trim();
  if (!name) {
    alert('Please enter an app name.');
    return;
  }
  const rawUris = document.getElementById('oauth-app-redirect-uris')?.value || '';
  const redirectUris = rawUris.split('\n').map((u) => u.trim()).filter(Boolean);
  if (redirectUris.length === 0) {
    alert('Please enter at least one redirect URI.');
    return;
  }
  for (const uri of redirectUris) {
    try {
      new URL(uri);
    } catch {
      alert(`Invalid redirect URI: ${uri}`);
      return;
    }
  }
  const scopes = [];
  if (document.getElementById('create-oauth-scope-vr')?.checked) scopes.push('verification:read');
  if (document.getElementById('create-oauth-scope-sr')?.checked) scopes.push('subjects:read');
  if (scopes.length === 0) {
    alert('Please select at least one scope.');
    return;
  }
  const tid = getTenantId();
  if (!tid) {
    alert('Tenant context is required.');
    return;
  }
  const btn = document.getElementById('create-oauth-app-submit');
  const origHTML = btn?.innerHTML;
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Registering…';
  }
  try {
    const res = await apiFetch(`${getApiBase()}/api/connect/oauth-apps`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenantId: tid, name, redirectUris, scopes }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Failed to create OAuth app');
    }
    const data = await res.json();
    closeCreateOAuthAppPanel();
    await fetchOAuthApps();
    showOAuthCredentialsReveal(data.clientId, data.clientSecret, name);
  } catch (e) {
    alert(e.message || 'Failed to register app. Please try again.');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = origHTML || '';
    }
  }
}

async function submitEditOAuthApp(appId) {
  const name = document.getElementById(`oauth-edit-name-${appId}`)?.value?.trim();
  if (!name) {
    alert('Please enter an app name.');
    return;
  }
  const rawUris = document.getElementById(`oauth-edit-uris-${appId}`)?.value || '';
  const redirectUris = rawUris.split('\n').map((u) => u.trim()).filter(Boolean);
  if (redirectUris.length === 0) {
    alert('Please enter at least one redirect URI.');
    return;
  }
  for (const uri of redirectUris) {
    try {
      new URL(uri);
    } catch {
      alert(`Invalid redirect URI: ${uri}`);
      return;
    }
  }
  const scopes = [];
  if (document.getElementById(`oauth-edit-scope-vr-${appId}`)?.checked) scopes.push('verification:read');
  if (document.getElementById(`oauth-edit-scope-sr-${appId}`)?.checked) scopes.push('subjects:read');
  if (scopes.length === 0) {
    alert('Please select at least one scope.');
    return;
  }
  const tid = getTenantId();
  if (!tid) return;
  const btn = document.getElementById(`oauth-edit-save-${appId}`);
  const origText = btn?.textContent;
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Saving…';
  }
  try {
    const res = await apiFetch(`${getApiBase()}/api/connect/oauth-apps/${encodeURIComponent(appId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenantId: tid, name, redirectUris, scopes }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Failed to update app');
    }
    toggleOAuthPanel(appId, 'edit', false);
    await fetchOAuthApps();
  } catch (e) {
    alert(e.message || 'Failed to save changes. Please try again.');
    if (btn) {
      btn.disabled = false;
      btn.textContent = origText || '';
    }
  }
}

async function confirmRegenOAuthSecret(appId) {
  const tid = getTenantId();
  if (!tid) return;
  const btn = document.getElementById(`oauth-regen-ok-${appId}`);
  const origText = btn?.textContent;
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Regenerating…';
  }
  try {
    const res = await apiFetch(`${getApiBase()}/api/connect/oauth-apps/${encodeURIComponent(appId)}/regenerate-secret`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenantId: tid }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Failed to regenerate secret');
    }
    const data = await res.json();
    toggleOAuthPanel(appId, 'regen', false);
    const app = oauthApps.find((a) => a._id === appId);
    showOAuthCredentialsReveal(app?.clientId || '', data.clientSecret, app?.name || 'App');
  } catch (e) {
    alert(e.message || 'Failed to regenerate secret. Please try again.');
    if (btn) {
      btn.disabled = false;
      btn.textContent = origText || '';
    }
  }
}

async function confirmDeleteOAuthApp(appId) {
  const tid = getTenantId();
  if (!tid) return;
  const btn = document.getElementById(`oauth-del-ok-${appId}`);
  const origText = btn?.textContent;
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Deleting…';
  }
  try {
    const res = await apiFetch(`${getApiBase()}/api/connect/oauth-apps/${encodeURIComponent(appId)}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenantId: tid }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Failed to delete app');
    }
    const card = document.getElementById(`oauth-app-card-${appId}`);
    if (card) {
      card.style.transition = 'opacity 0.28s, transform 0.28s';
      card.style.opacity = '0';
      card.style.transform = 'scale(0.98) translateY(-4px)';
      setTimeout(() => {
        card.remove();
        const filtered = oauthApps.filter((a) => a._id !== appId);
        setOAuthApps(filtered);
        if (filtered.length === 0) {
          document.getElementById('oauth-apps-list')?.classList.add('hidden');
          document.getElementById('oauth-apps-empty')?.classList.remove('hidden');
        }
      }, 290);
    }
  } catch (e) {
    alert(e.message || 'Failed to delete. Please try again.');
    if (btn) {
      btn.disabled = false;
      btn.textContent = origText || '';
    }
  }
}

function showOAuthCredentialsReveal(clientId, clientSecret, appName) {
  const list = document.getElementById('oauth-apps-list');
  const existing = document.getElementById('oauth-creds-reveal-panel');
  if (existing) existing.remove();

  const panel = document.createElement('div');
  panel.className = 'inline-panel open';
  panel.id = 'oauth-creds-reveal-panel';
  panel.innerHTML = `
    <div class="inline-panel-inner">
      <div class="inline-panel-body" style="text-align:center;">
        <div style="margin-bottom:20px;">
          <h3 style="font-size:20px; font-weight:800; font-family:'Plus Jakarta Sans',sans-serif; margin:0 0 8px; color:white;">${escHtml(appName || 'App')} credentials</h3>
          <p style="font-size:14px; color:rgba(255,255,255,0.7); margin:0;">Copy your credentials — the secret won't appear again</p>
        </div>
        <div style="background:rgba(0,0,0,0.3); border:1px solid rgba(255,255,255,0.1); border-radius:12px; padding:16px; margin-bottom:12px; text-align:left;">
          <div style="font-size:12px; color:rgba(255,255,255,0.5); font-weight:700; text-transform:uppercase; letter-spacing:0.05em; margin-bottom:8px;">Client ID</div>
          <div style="display:flex; align-items:center; gap:8px;">
            <span style="font-family:'DM Mono',monospace; font-size:14px; color:#fff; word-break:break-all; flex:1;">${escHtml(clientId)}</span>
            <button id="oauth-reveal-copy-id" style="background:rgba(255,255,255,0.1); border:none; width:36px; height:36px; border-radius:8px; color:#fff; cursor:pointer;" title="Copy ID">Copy</button>
          </div>
        </div>
        <div style="background:rgba(0,0,0,0.3); border:1px solid rgba(255,255,255,0.1); border-radius:12px; padding:16px; margin-bottom:24px; text-align:left;">
          <div style="font-size:12px; color:rgba(255,255,255,0.5); font-weight:700; text-transform:uppercase; letter-spacing:0.05em; margin-bottom:8px;">Client Secret</div>
          <div style="display:flex; align-items:center; gap:8px;">
            <span style="font-family:'DM Mono',monospace; font-size:14px; color:#fff; word-break:break-all; flex:1;">${escHtml(clientSecret)}</span>
            <button id="oauth-reveal-copy-secret" style="background:rgba(255,255,255,0.1); border:none; width:36px; height:36px; border-radius:8px; color:#fff; cursor:pointer;" title="Copy Secret">Copy</button>
          </div>
        </div>
        <div style="display:flex; align-items:center; gap:12px; margin-bottom:24px; text-align:left; background:rgba(255,255,255,0.03); border-radius:12px; padding:12px 16px;">
          <input type="checkbox" id="oauth-copied-check" style="width:18px; height:18px; accent-color:#0ea5e9; cursor:pointer;" aria-label="Confirm copy">
          <label for="oauth-copied-check" style="font-size:14px; color:#e2e8f0; cursor:pointer; user-select:none; font-family:'DM Sans',sans-serif; margin:0;">I have securely copied this secret</label>
        </div>
        <button id="oauth-reveal-done" style="width:100%; justify-content:center; background:#0ea5e9; color:#fff; border:none; padding:12px 24px; font-size:15px; font-weight:700; border-radius:12px; cursor:pointer; font-family:'Plus Jakarta Sans',sans-serif; transition:all 0.2s; opacity:0.5; pointer-events:none; display:flex; align-items:center;">Done — Close window</button>
      </div>
    </div>
  `;
  document.body.appendChild(panel);
  if (list) list.classList.remove('hidden');
  document.getElementById('oauth-apps-empty')?.classList.add('hidden');

  const checkbox = document.getElementById('oauth-copied-check');
  const doneBtn = document.getElementById('oauth-reveal-done');
  if (checkbox && doneBtn) {
    checkbox.addEventListener('change', (e) => {
      if (e.target.checked) {
        doneBtn.style.opacity = '1';
        doneBtn.style.pointerEvents = 'auto';
      } else {
        doneBtn.style.opacity = '0.5';
        doneBtn.style.pointerEvents = 'none';
      }
    });
  }
  document.getElementById('oauth-reveal-copy-id')?.addEventListener('click', () => copyText(clientId, document.getElementById('oauth-reveal-copy-id')));
  document.getElementById('oauth-reveal-copy-secret')?.addEventListener('click', () => copyText(clientSecret, document.getElementById('oauth-reveal-copy-secret')));
  doneBtn?.addEventListener('click', () => {
    panel.classList.remove('open');
    setTimeout(() => panel.remove(), 320);
  });
}

export async function fetchOAuthApps() {
  const tid = getTenantId();
  if (!tid) {
    document.getElementById('oauth-apps-loading')?.classList.add('hidden');
    document.getElementById('oauth-apps-empty')?.classList.remove('hidden');
    return;
  }
  try {
    const res = await apiFetch(`${getApiBase()}/api/connect/oauth-apps?tenantId=${encodeURIComponent(tid)}`);
    if (res.status === 401 || res.status === 403) {
      document.getElementById('oauth-apps-loading')?.classList.add('hidden');
      document.getElementById('oauth-apps-list')?.classList.add('hidden');
      document.getElementById('oauth-apps-empty')?.classList.add('hidden');
      document.getElementById('oauth-apps-signin-required')?.classList.remove('hidden');
      document.getElementById('create-oauth-app-btn')?.classList.add('hidden');
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    setOAuthApps(data.apps ?? []);
  } catch (e) {
    console.error('Failed to fetch OAuth apps:', e);
    setOAuthApps([]);
  }
  renderOAuthAppsSection();
}

export function initOAuth() {
  window.openCreateOAuthAppPanel = openCreateOAuthAppPanel;
  window.closeCreateOAuthAppPanel = closeCreateOAuthAppPanel;
  window.submitCreateOAuthApp = submitCreateOAuthApp;

  document.getElementById('create-oauth-app-submit')?.addEventListener('click', submitCreateOAuthApp);
}
