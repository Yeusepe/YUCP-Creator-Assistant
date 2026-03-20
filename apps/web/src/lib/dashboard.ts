import { apiClient } from '@/api/client';
import type { Guild } from '@/lib/server/dashboard';

export interface DashboardViewer {
  authUserId: string;
}

export interface DashboardProvider {
  key: string;
  label?: string;
  icon?: string;
  iconBg?: string;
  quickStartBg?: string;
  quickStartBorder?: string;
  serverTileHint?: string;
  connectPath?: string;
  connectParamStyle?: 'camelCase' | 'snakeCase';
}

export interface UserAccountConnection {
  id: string;
  provider: string;
  label: string;
  connectionType: string;
  status: string;
  webhookConfigured: boolean;
  hasApiKey: boolean;
  hasAccessToken: boolean;
  authUserId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface DashboardGuildChannel {
  id: string;
  name: string;
  type: number;
}

interface DashboardGuildResponse {
  authUserId: string;
  guildId: string;
  icon: string | null;
  name: string;
}

export type VerificationScope = 'account' | 'license';
export type DuplicateVerificationBehavior = 'allow' | 'notify' | 'block';
export type SuspiciousAccountBehavior = 'notify' | 'quarantine' | 'revoke';

export interface DashboardPolicy {
  allowMismatchedEmails?: boolean;
  autoVerifyOnJoin?: boolean;
  shareVerificationWithServers?: boolean;
  enableDiscordRoleFromOtherServers?: boolean;
  verificationScope?: VerificationScope;
  duplicateVerificationBehavior?: DuplicateVerificationBehavior;
  suspiciousAccountBehavior?: SuspiciousAccountBehavior;
  logChannelId?: string;
  announcementsChannelId?: string;
}

export function normalizeDashboardIdentifier(value: string | null | undefined) {
  if (!value) {
    return undefined;
  }

  return value.replace(/^"|"$/g, '');
}

export const DASHBOARD_SETTING_KEYS = [
  'allowMismatchedEmails',
  'autoVerifyOnJoin',
  'shareVerificationWithServers',
  'enableDiscordRoleFromOtherServers',
  'verificationScope',
  'duplicateVerificationBehavior',
  'suspiciousAccountBehavior',
  'logChannelId',
  'announcementsChannelId',
] as const;

export type DashboardSettingKey = (typeof DASHBOARD_SETTING_KEYS)[number];

export interface OAuthAppSummary {
  _id: string;
  _creationTime: number;
  authUserId: string;
  name: string;
  clientId: string;
  redirectUris: string[];
  scopes: string[];
  tokenEndpointAuthMethod?: string;
  grantTypes?: string[];
  responseTypes?: string[];
  disabled?: boolean;
}

export interface CreatedOAuthApp {
  appId: string;
  clientId: string;
  clientSecret: string;
  name: string;
  redirectUris: string[];
  scopes: string[];
}

export interface PublicApiKeySummary {
  _id: string;
  _creationTime: number;
  authUserId?: string;
  name: string;
  prefix: string;
  status: 'active' | 'revoked';
  scopes: string[];
  lastUsedAt?: number;
  expiresAt?: number | null;
}

export interface CreatedPublicApiKey {
  keyId: string;
  apiKey: string;
  name: string;
  prefix: string;
  scopes: string[];
  expiresAt: number | null;
  rotatedFromKeyId?: string;
}

export interface CollabProviderSummary {
  key: string;
  label: string;
}

export interface PendingCollabInvite {
  id: string;
  providerKey: string;
  ownerDisplayName: string;
  expiresAt: number;
  createdAt: number;
}

export interface CollabConnectionSummary {
  id: string;
  inviteId?: string;
  provider: string;
  linkType: 'account' | 'api';
  status: string;
  source: string;
  webhookConfigured: boolean;
  collaboratorDiscordUserId?: string;
  collaboratorDisplayName?: string;
  avatarUrl?: string | null;
  createdAt: number;
}

export interface CollabAsCollaboratorSummary {
  id: string;
  provider: string;
  linkType: 'account' | 'api';
  ownerAuthUserId: string;
  ownerDisplayName: string | null;
  createdAt: number;
}

export function buildProviderConnectUrl(
  provider: DashboardProvider,
  options: {
    authUserId?: string;
    guildId?: string;
  }
) {
  if (!provider.connectPath) {
    return null;
  }

  const { authUserId, guildId } = options;
  if (!authUserId || !guildId) {
    return provider.connectPath;
  }

  const params =
    provider.connectParamStyle === 'snakeCase'
      ? new URLSearchParams({
          tenant_id: authUserId,
          guild_id: guildId,
        })
      : new URLSearchParams({
          tenantId: authUserId,
          guildId,
        });

  const connectUrl = new URL(provider.connectPath, 'http://dashboard.local');
  for (const [key, value] of params.entries()) {
    connectUrl.searchParams.set(key, value);
  }

  return `${connectUrl.pathname}${connectUrl.search}`;
}

export function getProviderIconPath(provider: { icon?: string | null }) {
  return provider.icon ? `/Icons/${provider.icon}` : null;
}

export async function listDashboardProviders() {
  return apiClient.get<DashboardProvider[]>('/api/providers');
}

export async function listUserAccounts() {
  const data = await apiClient.get<{ connections?: UserAccountConnection[] }>(
    '/api/connect/user/accounts'
  );
  return data.connections ?? [];
}

export async function listUserGuilds() {
  const data = await apiClient.get<{ guilds?: DashboardGuildResponse[] }>(
    '/api/connect/user/guilds'
  );
  return (data.guilds ?? []).map(
    (guild): Guild => ({
      id: normalizeDashboardIdentifier(guild.guildId) ?? guild.guildId,
      name: guild.name,
      icon: guild.icon ?? null,
      tenantId: normalizeDashboardIdentifier(guild.authUserId) ?? guild.authUserId,
    })
  );
}

export async function disconnectUserAccount(connectionId: string) {
  return apiClient.delete<{ success: boolean }>('/api/connect/user/accounts', {
    params: { id: connectionId },
  });
}

export async function getDashboardSettings(authUserId: string) {
  const data = await apiClient.get<{ policy?: DashboardPolicy }>('/api/connect/settings', {
    params: { authUserId },
  });
  return data.policy ?? {};
}

export async function updateDashboardSetting(
  authUserId: string,
  key: DashboardSettingKey,
  value: DashboardPolicy[DashboardSettingKey]
) {
  return apiClient.post<{ success: boolean }>('/api/connect/settings', {
    authUserId,
    key,
    value,
  });
}

export async function listGuildChannels(guildId: string, authUserId?: string) {
  const params: Record<string, string> = { guildId };
  if (authUserId) {
    params.authUserId = authUserId;
  }

  const data = await apiClient.get<{ channels?: DashboardGuildChannel[] }>(
    '/api/connect/guild/channels',
    {
      params,
    }
  );
  return data.channels ?? [];
}

export async function getConnectionStatus(authUserId: string) {
  return apiClient.get<Record<string, boolean>>('/api/connect/status', {
    params: { authUserId },
  });
}

export async function uninstallGuild(guildId: string) {
  return apiClient.post<{ success: boolean }>(
    `/api/install/uninstall/${encodeURIComponent(guildId)}`
  );
}

export async function listOAuthApps(authUserId: string) {
  const data = await apiClient.get<{ apps?: OAuthAppSummary[] }>('/api/connect/oauth-apps', {
    params: { authUserId },
  });
  return data.apps ?? [];
}

export async function createOAuthApp(
  authUserId: string,
  input: {
    name: string;
    redirectUris: string[];
    scopes: string[];
  }
) {
  return apiClient.post<CreatedOAuthApp>('/api/connect/oauth-apps', {
    authUserId,
    ...input,
  });
}

export async function updateOAuthApp(
  authUserId: string,
  appId: string,
  input: {
    name: string;
    redirectUris: string[];
    scopes: string[];
  }
) {
  return apiClient.put<{ success: boolean }>(
    `/api/connect/oauth-apps/${encodeURIComponent(appId)}`,
    {
      authUserId,
      ...input,
    }
  );
}

export async function regenerateOAuthAppSecret(authUserId: string, appId: string) {
  return apiClient.post<{ clientSecret: string }>(
    `/api/connect/oauth-apps/${encodeURIComponent(appId)}/regenerate-secret`,
    { authUserId }
  );
}

export async function deleteOAuthApp(authUserId: string, appId: string) {
  return apiClient.delete<{ success: boolean }>(
    `/api/connect/oauth-apps/${encodeURIComponent(appId)}`,
    {
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ authUserId }),
    }
  );
}

export async function listPublicApiKeys(authUserId: string) {
  const data = await apiClient.get<{ keys?: PublicApiKeySummary[] }>(
    '/api/connect/public-api/keys',
    {
      params: { authUserId },
    }
  );
  return data.keys ?? [];
}

export async function createPublicApiKey(
  authUserId: string,
  input: {
    name: string;
    scopes: string[];
  }
) {
  return apiClient.post<CreatedPublicApiKey>('/api/connect/public-api/keys', {
    authUserId,
    ...input,
  });
}

export async function revokePublicApiKey(authUserId: string, keyId: string) {
  return apiClient.post<{ success: boolean }>(
    `/api/connect/public-api/keys/${encodeURIComponent(keyId)}/revoke`,
    { authUserId }
  );
}

export async function rotatePublicApiKey(authUserId: string, keyId: string) {
  return apiClient.post<CreatedPublicApiKey>(
    `/api/connect/public-api/keys/${encodeURIComponent(keyId)}/rotate`,
    { authUserId }
  );
}

export async function listCollabProviders() {
  const data = await apiClient.get<{ providers?: CollabProviderSummary[] }>(
    '/api/collab/providers'
  );
  return data.providers ?? [];
}

export async function listCollabInvites(authUserId: string) {
  const data = await apiClient.get<{ invites?: PendingCollabInvite[] }>('/api/collab/invites', {
    params: { authUserId },
  });
  return data.invites ?? [];
}

export async function createCollabInvite(
  authUserId: string,
  input: {
    providerKey: string;
    guildId?: string;
  }
) {
  return apiClient.post<{ inviteUrl: string; expiresAt: number }>('/api/collab/invite', {
    authUserId,
    ...input,
  });
}

export async function revokeCollabInvite(authUserId: string, inviteId: string) {
  return apiClient.delete<{ success: boolean }>(
    `/api/collab/invites/${encodeURIComponent(inviteId)}`,
    {
      params: { authUserId },
    }
  );
}

export async function listCollabConnections(authUserId: string) {
  const data = await apiClient.get<{ connections?: CollabConnectionSummary[] }>(
    '/api/collab/connections',
    {
      params: { authUserId },
    }
  );
  return data.connections ?? [];
}

export async function removeCollabConnection(authUserId: string, connectionId: string) {
  return apiClient.delete<{ success: boolean }>(
    `/api/collab/connections/${encodeURIComponent(connectionId)}`,
    {
      params: { authUserId },
    }
  );
}

export async function listCollabConnectionsAsCollaborator(authUserId: string) {
  const data = await apiClient.get<{ connections?: CollabAsCollaboratorSummary[] }>(
    '/api/collab/connections/as-collaborator',
    {
      params: { authUserId },
    }
  );
  return data.connections ?? [];
}
