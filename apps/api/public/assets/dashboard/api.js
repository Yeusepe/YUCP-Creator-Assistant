import { getApiBase, getTenantId, apiFetch, publicApiKeys, setPublicApiKeys } from './store.js';
import { escHtml, copyText, setButtonLoading, clearButtonLoading } from './utils.js';

let currentApiKeyValue = '';

function renderApiKeysSection() {
  const loading = document.getElementById('api-keys-loading');
  const list = document.getElementById('api-keys-list');
  const empty = document.getElementById('api-keys-empty');
  const signinRequired = document.getElementById('api-keys-signin-required');
  const createBtn = document.getElementById('create-api-key-btn');

  loading?.classList.add('hidden');
  if (signinRequired) signinRequired.classList.add('hidden');
  if (createBtn) createBtn.classList.remove('hidden');

  if (list) {
    list.replaceChildren();
    list.classList.remove('hidden');
  }
  if (empty) empty.classList.add('hidden');

  if (publicApiKeys.length === 0) {
    if (empty) empty.classList.remove('hidden');
    if (list) list.classList.add('hidden');
    return;
  }

  for (const key of publicApiKeys) {
    const isActive = key.status === 'active';
    const row = document.createElement('div');
    row.className = 'api-key-row';

    const iconEl = document.createElement('div');
    iconEl.className = 'api-key-icon';
    iconEl.innerHTML = `<svg viewBox="0 0 24 24"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>`;
    if (!isActive) {
      iconEl.style.background = 'rgba(255,255,255,0.06)';
      iconEl.style.borderColor = 'rgba(255,255,255,0.1)';
      const svg = iconEl.querySelector('svg');
      if (svg) svg.style.stroke = 'rgba(255,255,255,0.3)';
    }

    const infoEl = document.createElement('div');
    infoEl.className = 'api-key-info';
    const nameEl = document.createElement('div');
    nameEl.className = 'api-key-name';
    nameEl.textContent = key.name || 'Unnamed';
    if (!isActive) nameEl.style.opacity = '0.5';
    const metaEl = document.createElement('div');
    metaEl.className = 'api-key-meta';
    if (key.prefix) {
      const prefixEl = document.createElement('span');
      prefixEl.className = 'api-key-prefix';
      prefixEl.textContent = key.prefix + '…';
      metaEl.appendChild(prefixEl);
    }
    for (const scope of key.scopes || []) {
      const badge = document.createElement('span');
      badge.className = 'api-key-scope-badge';
      badge.textContent = scope;
      metaEl.appendChild(badge);
    }
    if (key.lastUsedAt) {
      const dateEl = document.createElement('span');
      dateEl.className = 'api-key-date';
      dateEl.textContent = 'Used ' + new Date(key.lastUsedAt).toLocaleDateString();
      metaEl.appendChild(dateEl);
    } else if (key._creationTime) {
      const dateEl = document.createElement('span');
      dateEl.className = 'api-key-date';
      dateEl.textContent = 'Created ' + new Date(key._creationTime).toLocaleDateString();
      metaEl.appendChild(dateEl);
    }
    infoEl.appendChild(nameEl);
    infoEl.appendChild(metaEl);

    const statusSpan = document.createElement('span');
    statusSpan.className = isActive ? 'api-key-status-active' : 'api-key-status-revoked';
    statusSpan.innerHTML = `<span class="status-dot"></span>${isActive ? 'Active' : 'Revoked'}`;

    const actions = document.createElement('div');
    actions.className = 'api-key-actions dropdown-wrapper';
    if (isActive) {
      const menuBtn = document.createElement('button');
      menuBtn.className = 'oauth-app-menu-btn';
      menuBtn.type = 'button';
      menuBtn.setAttribute('aria-label', 'Actions');
      menuBtn.setAttribute('aria-haspopup', 'true');
      menuBtn.setAttribute('aria-expanded', 'false');
      menuBtn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16"><circle cx="12" cy="6" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="18" r="1.5"/></svg>';
      const menu = document.createElement('div');
      menu.className = 'dropdown-menu';
      menu.setAttribute('role', 'menu');
      menu.innerHTML = '<button type="button" role="menuitem">Rotate</button><button type="button" role="menuitem">Revoke</button>';
      menuBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        document.querySelectorAll('.dropdown-menu.open').forEach((m) => {
          m.classList.remove('open');
          m.previousElementSibling?.setAttribute('aria-expanded', 'false');
        });
        menu.classList.toggle('open');
        menuBtn.setAttribute('aria-expanded', menu.classList.contains('open'));
      });
      const menuBtns = menu.querySelectorAll('button');
      menuBtns[0].addEventListener('click', () => {
        menu.classList.remove('open');
        rotatePublicApiKey(key._id, menuBtn);
      });
      menuBtns[1].addEventListener('click', () => {
        menu.classList.remove('open');
        revokePublicApiKey(key._id, menuBtn);
      });
      actions.appendChild(menuBtn);
      actions.appendChild(menu);
    }

    row.appendChild(iconEl);
    row.appendChild(infoEl);
    row.appendChild(statusSpan);
    row.appendChild(actions);
    list?.appendChild(row);
  }
}

export async function fetchPublicApiKeys() {
  const tid = getTenantId();
  if (!tid) {
    document.getElementById('api-keys-loading')?.classList.add('hidden');
    document.getElementById('api-keys-list')?.classList.add('hidden');
    document.getElementById('api-keys-empty')?.classList.remove('hidden');
    return;
  }
  try {
    const res = await apiFetch(`${getApiBase()}/api/connect/public-api/keys?tenantId=${encodeURIComponent(tid)}`);
    if (res.status === 401 || res.status === 403) {
      document.getElementById('api-keys-loading')?.classList.add('hidden');
      document.getElementById('api-keys-list')?.classList.add('hidden');
      document.getElementById('api-keys-empty')?.classList.add('hidden');
      document.getElementById('api-keys-signin-required')?.classList.remove('hidden');
      document.getElementById('create-api-key-btn')?.classList.add('hidden');
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    setPublicApiKeys(data.keys ?? []);
  } catch (e) {
    console.error('Failed to fetch API keys:', e);
    setPublicApiKeys([]);
  }
  renderApiKeysSection();
}

function openCreateApiKeyPanel() {
  const nameEl = document.getElementById('api-key-name');
  const vrEl = document.getElementById('scope-verification-read');
  const srEl = document.getElementById('scope-subjects-read');
  if (nameEl) nameEl.value = '';
  if (vrEl) vrEl.checked = true;
  if (srEl) srEl.checked = true;
  document.getElementById('create-api-key-panel')?.classList.add('open');
  setTimeout(() => document.getElementById('api-key-name')?.focus(), 420);
}

function closeCreateApiKeyPanel() {
  document.getElementById('create-api-key-panel')?.classList.remove('open');
}

async function submitCreateApiKey() {
  const name = document.getElementById('api-key-name')?.value?.trim();
  if (!name) {
    alert('Please enter a name for the key.');
    return;
  }
  const scopes = [];
  if (document.getElementById('scope-verification-read')?.checked) scopes.push('verification:read');
  if (document.getElementById('scope-subjects-read')?.checked) scopes.push('subjects:read');
  if (scopes.length === 0) {
    alert('Please select at least one scope.');
    return;
  }
  const tid = getTenantId();
  if (!tid) {
    alert('Tenant context is required.');
    return;
  }
  const btn = document.getElementById('create-api-key-submit');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Creating…';
  }
  try {
    const res = await apiFetch(`${getApiBase()}/api/connect/public-api/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenantId: tid, name, scopes }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Failed to create API key');
    }
    const data = await res.json();
    closeCreateApiKeyPanel();
    currentApiKeyValue = data.apiKey || '';
    document.getElementById('api-keys-loading')?.classList.remove('hidden');
    document.getElementById('api-keys-list')?.classList.add('hidden');
    await fetchPublicApiKeys();
    showApiKeyReveal(currentApiKeyValue, name);
  } catch (e) {
    alert(e.message || 'Failed to create API key. Please try again.');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Create key';
    }
  }
}

function showApiKeyReveal(apiKey, keyName) {
  const list = document.getElementById('api-keys-list');
  const existing = document.getElementById('api-key-reveal-panel');
  if (existing) existing.remove();

  const panel = document.createElement('div');
  panel.className = 'inline-panel open';
  panel.id = 'api-key-reveal-panel';
  panel.innerHTML = `
    <div class="inline-panel-inner">
      <div class="inline-panel-body" style="text-align:center;">
        <div style="margin-bottom:20px;">
          <div class="intg-icon" style="margin:0 auto 16px;">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>
            </svg>
          </div>
          <h3 style="font-size:20px; font-weight:800; font-family:'Plus Jakarta Sans',sans-serif; margin:0 0 8px; color:white;">Key created, ${escHtml(keyName || 'New key')}</h3>
          <p style="font-size:14px; color:rgba(255,255,255,0.7); margin:0;">Copy it now, this is the only time you'll see it</p>
        </div>
        <div style="background:rgba(239,68,68,0.1); border:1px solid rgba(239,68,68,0.2); border-radius:12px; padding:12px; margin-bottom:20px; text-align:left; display:flex; gap:12px;">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
          </svg>
          <p style="font-size:13px; color:#fca5a5; margin:0;">This key <strong>cannot be recovered</strong> after closing. Store it in a secure location.</p>
        </div>
        <div style="background:rgba(0,0,0,0.3); border:1px solid rgba(255,255,255,0.1); border-radius:12px; padding:16px; margin-bottom:24px; text-align:left;">
          <div style="font-size:12px; color:rgba(255,255,255,0.5); font-weight:700; text-transform:uppercase; letter-spacing:0.05em; margin-bottom:8px;">API Key</div>
          <div style="display:flex; align-items:center; gap:8px;">
            <span id="api-key-reveal-value" style="font-family:'DM Mono',monospace; font-size:14px; color:#fff; word-break:break-all; flex:1;">${escHtml(apiKey)}</span>
            <button id="api-key-reveal-copy" style="background:rgba(255,255,255,0.1); border:none; width:36px; height:36px; border-radius:8px; color:#fff; cursor:pointer; display:flex; align-items:center; justify-content:center; transition:background 0.2s;" title="Copy key">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            </button>
          </div>
        </div>
        <div style="display:flex; align-items:center; gap:12px; margin-bottom:24px; text-align:left; background:rgba(255,255,255,0.03); border-radius:12px; padding:12px 16px;">
          <input type="checkbox" id="api-key-copied-check" style="width:18px; height:18px; accent-color:#0ea5e9; cursor:pointer;" aria-label="Confirm copy">
          <label for="api-key-copied-check" style="font-size:14px; color:#e2e8f0; cursor:pointer; user-select:none; font-family:'DM Sans',sans-serif; margin:0;">I have securely copied this secret key</label>
        </div>
        <button id="api-key-reveal-done" style="width:100%; justify-content:center; background:#0ea5e9; color:#fff; border:none; padding:12px 24px; font-size:15px; font-weight:700; border-radius:12px; cursor:pointer; font-family:'Plus Jakarta Sans',sans-serif; transition:all 0.2s; opacity:0.5; pointer-events:none; display:flex; align-items:center;">Done, Close window</button>
      </div>
    </div>
  `;
  document.body.appendChild(panel);
  if (list) list.classList.remove('hidden');
  document.getElementById('api-keys-empty')?.classList.add('hidden');

  const checkbox = document.getElementById('api-key-copied-check');
  const doneBtn = document.getElementById('api-key-reveal-done');
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
  document.getElementById('api-key-reveal-copy')?.addEventListener('click', async () => {
    await copyText(apiKey, document.getElementById('api-key-reveal-copy'), 'Copied!');
  });
  doneBtn?.addEventListener('click', () => {
    panel.classList.remove('open');
    setTimeout(() => {
      panel.remove();
      currentApiKeyValue = '';
    }, 320);
  });
}

async function revokePublicApiKey(keyId, btn) {
  if (!confirm('Revoke this API key? It will stop working immediately.')) return;
  const tid = getTenantId();
  if (!tid) return;
  setButtonLoading(btn, 'Revoking…');
  try {
    const res = await apiFetch(`${getApiBase()}/api/connect/public-api/keys/${encodeURIComponent(keyId)}/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenantId: tid }),
    });
    if (res.ok) {
      document.getElementById('api-keys-loading')?.classList.remove('hidden');
      document.getElementById('api-keys-list')?.classList.add('hidden');
      await fetchPublicApiKeys();
    } else {
      const err = await res.json().catch(() => ({}));
      alert(err.error || 'Failed to revoke key.');
    }
  } catch (e) {
    console.error('Revoke API key failed:', e);
    alert('Network error. Please try again.');
  } finally {
    clearButtonLoading(btn);
  }
}

async function rotatePublicApiKey(keyId, btn) {
  if (!confirm('Rotate this key? A new key will be created and this one will be revoked. Copy the new key when it appears.')) return;
  const tid = getTenantId();
  if (!tid) return;
  setButtonLoading(btn, 'Rotating…');
  try {
    const res = await apiFetch(`${getApiBase()}/api/connect/public-api/keys/${encodeURIComponent(keyId)}/rotate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenantId: tid }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Failed to rotate key');
    }
    const data = await res.json();
    currentApiKeyValue = data.apiKey || '';
    document.getElementById('api-keys-loading')?.classList.remove('hidden');
    document.getElementById('api-keys-list')?.classList.add('hidden');
    await fetchPublicApiKeys();
    showApiKeyReveal(currentApiKeyValue, 'Rotated key');
  } catch (e) {
    alert(e.message || 'Failed to rotate key. Please try again.');
  } finally {
    clearButtonLoading(btn);
  }
}

export function initApiKeys() {
  window.openCreateApiKeyPanel = openCreateApiKeyPanel;
  window.closeCreateApiKeyPanel = closeCreateApiKeyPanel;
  window.submitCreateApiKey = submitCreateApiKey;
}
