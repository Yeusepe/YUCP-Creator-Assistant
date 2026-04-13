import {
  getApiBase,
  getTenantId,
  getGuildId,
  getHasSetupSession,
  apiFetch,
  collabConnections,
  setCollabConnections,
} from './store.js';
import { escHtml, setButtonLoading, clearButtonLoading } from './utils.js';

let cachedProviders = null;

/**
 * Generates a deterministic gradient avatar element from a seed string.
 * Uses the same djb2 hash as facehash's stringHash utility.
 * No external requests, purely local SVG/CSS.
 * @param {string} seed, Discord user ID or display name
 * @returns {HTMLElement}
 */
function generateFallbackAvatarEl(seed) {
  // djb2 hash (same algorithm as facehash's stringHash)
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = ((h << 5) - h + seed.charCodeAt(i)) | 0;
  }
  h = Math.abs(h);

  const palettes = [
    ['#6366f1', '#8b5cf6'],
    ['#0ea5e9', '#06b6d4'],
    ['#10b981', '#059669'],
    ['#f59e0b', '#d97706'],
    ['#ec4899', '#db2777'],
    ['#8b5cf6', '#6d28d9'],
    ['#14b8a6', '#0891b2'],
  ];
  const [c1, c2] = palettes[h % palettes.length];
  const initials = seed.trim().slice(0, 2).toUpperCase() || '??';

  const div = document.createElement('div');
  div.className = 'collab-avatar';
  div.style.background = `linear-gradient(135deg, ${c1}, ${c2})`;
  div.textContent = initials;
  return div;
}

/**
 * Creates an avatar element: an <img> when avatarUrl is present (server-side
 * constructed, validated Discord CDN URL), falling back to generateFallbackAvatarEl
 * when the URL is absent or the image fails to load.
 * @param {{ avatarUrl?: string|null, collaboratorDiscordUserId?: string, collaboratorDisplayName?: string, ownerDisplayName?: string }} conn
 * @param {string} fallbackSeed
 * @returns {HTMLElement}
 */
function buildAvatarEl(conn, fallbackSeed) {
  if (conn.avatarUrl) {
    const img = document.createElement('img');
    img.className = 'collab-avatar';
    img.src = conn.avatarUrl;
    img.alt = fallbackSeed;
    img.width = 38;
    img.height = 38;
    img.onerror = () => {
      img.replaceWith(generateFallbackAvatarEl(fallbackSeed));
    };
    return img;
  }
  return generateFallbackAvatarEl(fallbackSeed);
}

async function fetchCollabProviders() {
  if (cachedProviders) return cachedProviders;
  try {
    const res = await fetch(`${getApiBase()}/api/collab/providers`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    cachedProviders = data.providers ?? [];
  } catch (e) {
    console.error('Failed to fetch collab providers:', e);
    cachedProviders = [];
  }
  return cachedProviders;
}

let currentInviteUrl = '';
let collabPollInterval = null;
const COLLAB_POLL_INTERVAL_MS = 5000;
const COLLAB_POLL_MAX = 60; // stop after 5 minutes
let collabPollCount = 0;

function startCollabPolling() {
  stopCollabPolling();
  collabPollCount = 0;
  collabPollInterval = setInterval(async () => {
    collabPollCount++;
    if (collabPollCount > COLLAB_POLL_MAX) {
      stopCollabPolling();
      return;
    }
    await fetchCollabConnections();
  }, COLLAB_POLL_INTERVAL_MS);
}

function stopCollabPolling() {
  if (collabPollInterval !== null) {
    clearInterval(collabPollInterval);
    collabPollInterval = null;
  }
}

async function populateProviderSelect() {
  const select = document.getElementById('invite-provider-select');
  if (!select) return;
  const providers = await fetchCollabProviders();
  select.replaceChildren();
  for (const p of providers) {
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
  const connectionsHeader = document.getElementById('collab-connections-header');
  const active = collabConnections.filter((c) => c.status === 'active');

  if (list) list.replaceChildren();
  if (empty) empty.classList.add('hidden');

  if (active.length === 0) {
    if (connectionsHeader) connectionsHeader.classList.add('hidden');
    if (empty) empty.classList.remove('hidden');
    return;
  }

  if (connectionsHeader) connectionsHeader.classList.remove('hidden');

  for (const conn of active) {
    const name = conn.collaboratorDisplayName || conn.collaboratorDiscordUserId || 'Unknown';
    const avatarSeed = conn.collaboratorDiscordUserId || conn.collaboratorDisplayName || 'unknown';

    const row = document.createElement('div');
    row.className = 'collab-row';

    const avatar = buildAvatarEl(conn, avatarSeed);

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
  await Promise.all([fetchPendingInvites(), fetchAsCollaboratorConnections()]);
}

async function fetchPendingInvites() {
  try {
    const authUserId = getTenantId();
    const urlSuffix = authUserId ? `?authUserId=${encodeURIComponent(authUserId)}` : '';
    const res = await apiFetch(`${getApiBase()}/api/collab/invites${urlSuffix}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    renderInvitesSection(data.invites ?? []);
  } catch (e) {
    console.error('Failed to fetch pending invites:', e);
    renderInvitesSection([]);
  }
}

function renderInvitesSection(invites) {
  const section = document.getElementById('collab-invites-section');
  const list = document.getElementById('collab-invites-list');
  if (!section || !list) return;

  list.replaceChildren();

  if (invites.length === 0) {
    section.classList.add('hidden');
    return;
  }

  section.classList.remove('hidden');

  for (const invite of invites) {
    const row = document.createElement('div');
    row.className = 'collab-invite-row';
    row.id = `invite-row-${invite.id}`;

    const info = document.createElement('div');
    info.className = 'collab-invite-info';

    const providerBadge = document.createElement('span');
    providerBadge.className = 'badge-api';
    providerBadge.textContent = invite.providerKey;
    info.appendChild(providerBadge);

    const expiry = document.createElement('span');
    expiry.className = 'collab-invite-expiry';
    expiry.textContent = invite.expiresAt
      ? `Expires ${new Date(invite.expiresAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
      : 'Pending';
    info.appendChild(expiry);

    const revokeBtn = document.createElement('button');
    revokeBtn.className = 'collab-remove-btn';
    revokeBtn.type = 'button';
    revokeBtn.textContent = 'Revoke';
    revokeBtn.addEventListener('click', () => revokeInvite(invite.id, revokeBtn));

    row.appendChild(info);
    row.appendChild(revokeBtn);
    list.appendChild(row);
  }

  // Show "Active Connections" header only when there are active connections too
  const connectionsHeader = document.getElementById('collab-connections-header');
  if (connectionsHeader) {
    const active = collabConnections.filter((c) => c.status === 'active');
    if (active.length > 0) {
      connectionsHeader.classList.remove('hidden');
    } else {
      connectionsHeader.classList.add('hidden');
    }
  }
}

export async function revokeInvite(inviteId, btn) {
  setButtonLoading(btn, 'Revoking…');
  try {
    const authUserId = getTenantId();
    const urlSuffix = authUserId ? `?authUserId=${encodeURIComponent(authUserId)}` : '';
    const res = await apiFetch(
      `${getApiBase()}/api/collab/invites/${inviteId}${urlSuffix}`,
      { method: 'DELETE' }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await fetchPendingInvites();
  } catch (e) {
    console.error('Failed to revoke invite:', e);
    alert('Failed to revoke invite. Please try again.');
  } finally {
    clearButtonLoading(btn);
  }
}

async function fetchAsCollaboratorConnections() {
  try {
    const authUserId = getTenantId();
    const urlSuffix = authUserId ? `?authUserId=${encodeURIComponent(authUserId)}` : '';
    const res = await apiFetch(
      `${getApiBase()}/api/collab/connections/as-collaborator${urlSuffix}`
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    renderAsCollaboratorSection(data.connections ?? []);
  } catch (e) {
    console.error('Failed to fetch as-collaborator connections:', e);
    renderAsCollaboratorSection([]);
  }
}

function renderAsCollaboratorSection(connections) {
  const list = document.getElementById('collab-as-collaborator-list');
  const empty = document.getElementById('collab-as-collaborator-empty');
  const loading = document.getElementById('collab-as-collaborator-loading');

  if (loading) loading.classList.add('hidden');
  if (!list) return;

  list.replaceChildren();

  if (connections.length === 0) {
    if (empty) empty.classList.remove('hidden');
    return;
  }

  if (empty) empty.classList.add('hidden');

  const providers = cachedProviders ?? [];

  for (const conn of connections) {
    const ownerName = conn.ownerDisplayName ?? 'Unknown Creator';
    const avatarSeed = conn.ownerAuthUserId || ownerName;

    const providerLabel =
      providers.find((p) => p.key === conn.provider)?.label ?? conn.provider;

    const row = document.createElement('div');
    row.className = 'collab-row';

    const avatar = generateFallbackAvatarEl(avatarSeed);

    const info = document.createElement('div');
    info.style.flex = '1';
    info.style.minWidth = '0';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'collab-name';
    nameSpan.textContent = ownerName;

    const meta = document.createElement('div');
    meta.className = 'collab-meta';

    const providerBadge = document.createElement('span');
    providerBadge.className = 'badge-api';
    providerBadge.textContent = providerLabel;
    meta.appendChild(providerBadge);

    const typeBadge = document.createElement('span');
    typeBadge.className = conn.linkType === 'account' ? 'badge-account' : 'badge-api';
    typeBadge.textContent = conn.linkType === 'account' ? 'Account' : 'API Key';
    meta.appendChild(typeBadge);

    info.appendChild(nameSpan);
    info.appendChild(meta);

    row.appendChild(avatar);
    row.appendChild(info);
    list.appendChild(row);
  }
}

export async function generateCollabInvite() {
  await populateProviderSelect();
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
    // Immediately refresh the pending invites list so the new invite appears
    // without requiring a page reload.
    await fetchPendingInvites();
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
  // Start polling so the collab list refreshes when the collaborator accepts
  startCollabPolling();
}

export function closeInvitePanel() {
  stopCollabPolling();
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
  window.revokeInvite = revokeInvite;
  window.generateCollabInvite = generateCollabInvite;
  window.submitGenerateInvite = submitGenerateInvite;
  window.closeInvitePanel = closeInvitePanel;
  window.copyInviteMessage = copyInviteMessage;
  window.copyInviteUrl = copyInviteUrl;
}
