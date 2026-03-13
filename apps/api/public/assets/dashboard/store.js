/**
 * Shared mutable state for dashboard modules.
 * Imported by server-context, platform, collab, api, oauth.
 */
import { getConfig } from './config.js';

let apiBase = '';
let tenantId = '';
let guildId = '';
let hasSetupSession = false;
let setupToken = '';

export const connectionsMap = new Map();
export let userAccountsList = []; // All user-scoped + legacy connections (multi-account)
export function setUserAccountsList(v) {
  userAccountsList = v;
  // Also rebuild connectionsMap for backward-compat (first active connection per provider)
  connectionsMap.clear();
  for (const conn of v) {
    if (conn.status !== 'disconnected' && !connectionsMap.has(conn.provider)) {
      connectionsMap.set(conn.provider, conn);
    }
  }
}
export const settingsMap = new Map();
export let collabConnections = [];
export let publicApiKeys = [];
export let oauthApps = [];
export let pendingDisconnectPlatform = null;
export function setPendingDisconnectPlatform(v) {
  pendingDisconnectPlatform = v;
}
export const completedMilestones = new Set();
export let settingsTouched = false;
export let setupCompleted = false;
export let previousQuickStartCompletion = { stores: false, settings: false, finish: false };

export function initStore() {
  const c = getConfig();
  apiBase = c.apiBase;
  tenantId = c.tenantId;
  guildId = c.guildId;
  hasSetupSession = c.hasSetupSession;
}

export function getApiBase() {
  return apiBase;
}
export function getTenantId() {
  return tenantId;
}
export function setTenantId(v) {
  tenantId = v;
}
export function getGuildId() {
  return guildId;
}
export function setGuildId(v) {
  guildId = v;
}
export function getHasSetupSession() {
  return hasSetupSession;
}
export function setHasSetupSession(v) {
  hasSetupSession = v;
}
export function getSetupToken() {
  return setupToken;
}
export function setSetupToken(v) {
  setupToken = v;
}
export function setCollabConnections(v) {
  collabConnections = v;
}
export function setPublicApiKeys(v) {
  publicApiKeys = v;
}
export function setOAuthApps(v) {
  oauthApps = v;
}
export function setSettingsTouched(v) {
  settingsTouched = v;
}
export function setSetupCompleted(v) {
  setupCompleted = v;
}
export function setPreviousQuickStartCompletion(v) {
  previousQuickStartCompletion = v;
}

export function apiFetch(url, options = {}) {
  const headers = new Headers(options.headers || {});
  if (setupToken && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${setupToken}`);
  }
  return fetch(url, { credentials: 'include', ...options, headers });
}
