import {
  getApiBase,
  getTenantId,
  getGuildId,
  getHasSetupSession,
  apiFetch,
  collabConnections,
  setCollabConnections,
} from './store.js';

// Providers that support collaborator invites (mirrors PROVIDER_REGISTRY supportsCollab entries).
const COLLAB_PROVIDERS = [
  { key: 'jinxxy', label: 'Jinxxy™' },
  { key: 'lemonsqueezy', label: 'Lemon Squeezy' },
];

let currentInviteUrl = '';

function populateProviderSelect() {
  const select = document.getElementById('invite-provider-select');
  if (!select) return;
  select.replaceChildren();
  for (const p of COLLAB_PROVIDERS) {
    const opt = document.createElement('option');
    opt.value = p.key;
    opt.textContent = p.label;
    select.appendChild(opt);
  }
}

function renderCollabSection() {
  document.getElementById('collab-loading')?.classList.add('hidden');
  const list = document.getElementById('collab-list');
  const empty = document.getElementById('collab-empty');
  const active = collabConnections.filter((c) => c.status === 'active');

  if (list) list.replaceChildren();
  if (empty) empty.classList.add('hidden');

  if (active.length === 0) {
    if (empty) empty.classList.remove('hidden');
    return;
  }

  if (empty) empty.classList.add('hidden');

  for (const conn of active) {
    const initials = (conn.collaboratorDisplayName || '?').slice(0, 2).toUpperCase();
    const name = conn.collaboratorDisplayName || conn.collaboratorDiscordUserId || 'Unknown';

    const row = document.createElement('div');
    row.className = 'collab-row';

    const avatar = document.createElement('div');
    avatar.className = 'collab-avatar';
    avatar.textContent = initials;

    const info = document.createElement('div');
    const nameSpan = document.createElement('span');
    nameSpan.className = 'collab-name';
    nameSpan.textContent = name;

    const meta = document.createElement('div');
    meta.className = 'collab-meta';
    const typeBadge = document.createElement('span');
    typeBadge.className = conn.linkType === 'account' ? 'badge-account' : 'badge-api';
    typeBadge.textContent = conn.linkType === 'account' ? 'Account' : 'API Key';
    meta.appendChild(typeBadge);
    if (conn.linkType === 'account') {
      const webhookStatus = document.createElement('span');
      webhookStatus.className = conn.webhookConfigured ? 'webhook-dot ok' : 'webhook-dot warn';
      webhookStatus.title = conn.webhookConfigured ? 'Webhook active' : 'Webhook not configured';
      meta.appendChild(webhookStatus);
    }

    info.appendChild(nameSpan);
    info.appendChild(meta);

    const removeButton = document.createElement('button');
    removeButton.className = 'collab-remove-btn';
    removeButton.type = 'button';
    removeButton.textContent = 'Remove';
    removeButton.addEventListener('click', () => removeCollabConnection(conn.id));

    const confirmRow = document.createElement('div');
    confirmRow.className = 'inline-confirm';
    confirmRow.id = `collab-confirm-${conn.id}`;
    const confirmOuter = document.createElement('div');
    const confirmBody = document.createElement('div');
    confirmBody.className = 'inline-confirm-body';
    const confirmLabel = document.createElement('span');
    confirmLabel.className = 'inline-confirm-label';
    confirmLabel.textContent = 'Remove this collaborator?';
    const confirmBtns = document.createElement('div');
    confirmBtns.className = 'inline-confirm-btns';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'inline-cancel-btn';
    cancelBtn.type = 'button';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => {
      confirmRow.classList.remove('open');
    });
    const dangerBtn = document.createElement('button');
    dangerBtn.className = 'inline-danger-btn';
    dangerBtn.type = 'button';
    dangerBtn.textContent = 'Remove';
    dangerBtn.addEventListener('click', () => {
      window.removeCollabConnection(conn.id);
    });
    confirmBtns.appendChild(cancelBtn);
    confirmBtns.appendChild(dangerBtn);
    confirmBody.appendChild(confirmLabel);
    confirmBody.appendChild(confirmBtns);
    confirmOuter.appendChild(confirmBody);
    confirmRow.appendChild(confirmOuter);

    row.appendChild(avatar);
    row.appendChild(info);
    row.appendChild(removeButton);
    row.appendChild(confirmRow);
    list?.appendChild(row);
  }
}

export async function fetchCollabConnections() {
  try {
    const authUserId = getTenantId();
    const url = authUserId
      ? `${getApiBase()}/api/collab/connections?authUserId=${encodeURIComponent(authUserId)}`
      : `${getApiBase()}/api/collab/connections`;
    const res = await apiFetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    setCollabConnections(data.connections ?? []);
  } catch (e) {
    console.error('Failed to fetch collab connections:', e);
    setCollabConnections([]);
  }
  renderCollabSection();
}

export function generateCollabInvite() {
  populateProviderSelect();
  const stepSelect = document.getElementById('invite-step-select');
  const stepUrl = document.getElementById('invite-step-url');
  if (stepSelect) stepSelect.style.display = '';
  if (stepUrl) stepUrl.style.display = 'none';
  document.getElementById('invite-panel')?.classList.add('open');
}

export async function submitGenerateInvite() {
  const select = document.getElementById('invite-provider-select');
  const providerKey = select?.value;
  if (!providerKey) return;

  const btn = document.getElementById('btn-generate-invite');
  const originalText = btn?.textContent;
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Generating...';
  }
  try {
    const res = await apiFetch(`${getApiBase()}/api/collab/invite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        guildId: getGuildId() || '',
        authUserId: getTenantId() || undefined,
        providerKey,
      }),
    });
    if (!res.ok) throw new Error('Could not generate an invite right now.');
    const data = await res.json();
    showInviteResult(data.inviteUrl, data.expiresAt);
  } catch (e) {
    console.error('Failed to generate collab invite:', e);
    alert('Failed to generate invite link. Please try again.');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = originalText || 'Generate Invite Link';
    }
  }
}

function showInviteResult(url, expiresAt) {
  currentInviteUrl = url;
  const display = document.getElementById('invite-url-display');
  if (display) display.textContent = url;

  const msgTemplate = document.getElementById('invite-message-template');
  if (msgTemplate) {
    msgTemplate.value = `Hey! Join as a creator to link your storefront and grant automatic roles to your customers on the server. Here is your unique invite:\n${url}`;
  }

  const expiry = document.getElementById('invite-expiry');
  if (expiry) {
    expiry.textContent = expiresAt
      ? `Expires ${new Date(expiresAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`
      : 'Expires in 7 days';
  }

  const stepSelect = document.getElementById('invite-step-select');
  const stepUrl = document.getElementById('invite-step-url');
  if (stepSelect) stepSelect.style.display = 'none';
  if (stepUrl) stepUrl.style.display = '';
}

export function closeInvitePanel() {
  document.getElementById('invite-panel')?.classList.remove('open');
}

export async function copyInviteMessage(btnEle) {
  const templateText = document.getElementById('invite-message-template')?.value;
  if (!templateText) return;
  try {
    await navigator.clipboard.writeText(templateText);
    if (btnEle) {
      const origHtml = btnEle.innerHTML;
      btnEle.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg> Copied!`;
      setTimeout(() => {
        btnEle.innerHTML = origHtml;
      }, 2000);
    }
  } catch {}
}

export async function copyInviteUrl() {
  if (!currentInviteUrl) return;
  try {
    await navigator.clipboard.writeText(currentInviteUrl);
    const btn = document.getElementById('copy-invite-btn');
    if (btn) {
      const orig = btn.innerHTML;
      btn.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#10b981" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
      setTimeout(() => {
        btn.innerHTML = orig;
      }, 2200);
    }
  } catch {}
}

export async function removeCollabConnection(connectionId) {
  const confirmEl = document.getElementById(`collab-confirm-${connectionId}`);
  if (!confirmEl) return;
  if (!confirmEl.classList.contains('open')) {
    confirmEl.classList.add('open');
    return;
  }
  const btn = confirmEl.querySelector('.inline-danger-btn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Removing…';
  }
  try {
    const authUserId = getTenantId();
    const urlSuffix = authUserId ? `?authUserId=${encodeURIComponent(authUserId)}` : '';
    const res = await apiFetch(
      `${getApiBase()}/api/collab/connections/${connectionId}${urlSuffix}`,
      { method: 'DELETE' }
    );
    if (res.ok) {
      setCollabConnections(collabConnections.filter((c) => c.id !== connectionId));
      renderCollabSection();
    } else {
      alert('Failed to remove connection. Please try again.');
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Remove';
      }
      confirmEl.classList.remove('open');
    }
  } catch (e) {
    console.error('Failed to remove collab connection:', e);
    alert('Network error. Please try again.');
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Remove';
    }
    confirmEl.classList.remove('open');
  }
}

export function initCollab() {
  window.removeCollabConnection = removeCollabConnection;
  window.generateCollabInvite = generateCollabInvite;
  window.submitGenerateInvite = submitGenerateInvite;
  window.closeInvitePanel = closeInvitePanel;
  window.copyInviteMessage = copyInviteMessage;
  window.copyInviteUrl = copyInviteUrl;
}
