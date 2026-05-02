import {
  DEFAULT_OAUTH_APP_SCOPES,
  DEFAULT_PUBLIC_API_KEY_SCOPES,
  normalizePublicApiScopeList,
  PUBLIC_API_KEY_PERMISSION_NAMESPACE,
  type PublicApiScope,
} from '@yucp/shared';

export interface BetterAuthPermissionStatements {
  [key: string]: string[];
}

export interface BetterAuthApiKey {
  id: string;
  name?: string | null;
  start?: string | null;
  prefix?: string | null;
  enabled?: boolean;
  permissions?: BetterAuthPermissionStatements | null;
  metadata?: unknown;
  lastRequest?: unknown;
  expiresAt?: unknown;
  createdAt?: unknown;
}

export interface BetterAuthOAuthClient {
  client_id: string;
  client_secret?: string;
  client_name?: string;
  redirect_uris: string[];
  scope?: string;
  client_id_issued_at?: number;
  token_endpoint_auth_method?: 'client_secret_basic' | 'client_secret_post' | 'none';
  grant_types?: Array<'authorization_code' | 'refresh_token' | 'client_credentials'>;
  response_types?: Array<'code'>;
  disabled?: boolean;
}

export interface OAuthAppMappingRecord {
  _id: string;
  _creationTime: number;
  authUserId: string;
  name: string;
  clientId: string;
  redirectUris: string[];
  scopes: string[];
}

export const PUBLIC_API_KEY_METADATA_KIND = 'public-api';

export function toTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim()) {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber)) {
      return asNumber;
    }

    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  if (value instanceof Date) {
    return value.getTime();
  }

  return undefined;
}

export function normalizePublicApiScopes(scopes: unknown): PublicApiScope[] {
  return normalizePublicApiScopeList(
    scopes,
    DEFAULT_PUBLIC_API_KEY_SCOPES,
    'Invalid API key scopes'
  );
}

export function parsePublicApiKeyMetadata(
  value: unknown
): { kind?: string; authUserId?: string } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const metadata = value as Record<string, unknown>;
  return {
    kind: typeof metadata.kind === 'string' ? metadata.kind : undefined,
    authUserId: typeof metadata.authUserId === 'string' ? metadata.authUserId : undefined,
  };
}

export function getPublicApiKeyScopes(
  permissions: BetterAuthPermissionStatements | null | undefined
): string[] {
  if (!permissions || typeof permissions !== 'object') {
    return [];
  }

  const scopes = permissions[PUBLIC_API_KEY_PERMISSION_NAMESPACE];
  return Array.isArray(scopes)
    ? scopes.filter((scope): scope is string => typeof scope === 'string')
    : [];
}

export function getPublicApiKeyExpiresIn(
  expiresAt: number | null | undefined
): number | null | undefined {
  if (expiresAt === null) {
    return null;
  }
  if (expiresAt === undefined) {
    return undefined;
  }

  const expiresIn = Math.floor((expiresAt - Date.now()) / 1000);
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error('expiresAt must be in the future');
  }
  return expiresIn;
}

export function normalizeRedirectUris(redirectUris: unknown): string[] {
  const values = Array.isArray(redirectUris)
    ? redirectUris.map((value) => (typeof value === 'string' ? value.trim() : '')).filter(Boolean)
    : [];

  if (values.length === 0) {
    throw new Error('At least one redirect URI is required');
  }

  const isProduction = (process.env.NODE_ENV ?? 'development') === 'production';

  for (const redirectUri of values) {
    let parsed: URL;
    try {
      parsed = new URL(redirectUri);
    } catch {
      throw new Error(`Invalid redirect URI: ${redirectUri}`);
    }

    if (isProduction) {
      if (parsed.protocol !== 'https:') {
        throw new Error(`Redirect URI must use HTTPS in production: ${redirectUri}`);
      }
    } else {
      const isLocalhost =
        parsed.hostname === 'localhost' ||
        parsed.hostname === '127.0.0.1' ||
        parsed.hostname === '[::1]';
      const isLoopbackHttp = parsed.protocol === 'http:' && isLocalhost;
      if (parsed.protocol !== 'https:' && !isLoopbackHttp) {
        throw new Error(
          `Redirect URI must use HTTPS or target localhost over HTTP: ${redirectUri}`
        );
      }
    }
  }

  return Array.from(new Set(values));
}

export function normalizeOAuthScopes(scopes: unknown): PublicApiScope[] {
  return normalizePublicApiScopeList(scopes, DEFAULT_OAUTH_APP_SCOPES, 'Invalid OAuth scopes');
}

export function getBetterAuthErrorMessage(value: unknown, fallback: string): string {
  if (!value || typeof value !== 'object') {
    return fallback;
  }

  const record = value as Record<string, unknown>;
  if (typeof record.message === 'string' && record.message.trim()) {
    return record.message;
  }

  const error = record.error;
  if (error && typeof error === 'object') {
    const errorRecord = error as Record<string, unknown>;
    if (typeof errorRecord.message === 'string' && errorRecord.message.trim()) {
      return errorRecord.message;
    }
    if (typeof errorRecord.error_description === 'string' && errorRecord.error_description.trim()) {
      return errorRecord.error_description;
    }
  }

  if (typeof record.error_description === 'string' && record.error_description.trim()) {
    return record.error_description;
  }

  return fallback;
}
