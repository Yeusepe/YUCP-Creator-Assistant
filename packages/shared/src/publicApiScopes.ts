export const PUBLIC_API_AUDIENCE = 'https://api.creators.yucp.club';
export const PUBLIC_API_KEY_PERMISSION_NAMESPACE = 'publicApi';
export const PUBLIC_API_KEY_PREFIX = 'ypsk_';

export type PublicApiScope =
  | 'profile:read'
  | 'verification:read'
  | 'subjects:read'
  | 'entitlements:read'
  | 'transactions:read'
  | 'products:read'
  | 'products:write'
  | 'downloads:read'
  | 'collaborators:read'
  | 'webhooks:manage'
  | 'events:read'
  | 'audit-log:read'
  | 'guilds:read'
  | 'connections:read'
  | 'settings:read'
  | 'settings:write'
  | 'licenses:manage'
  | 'cert:issue';

export interface PublicApiScopeDefinition {
  scope: PublicApiScope;
  label: string;
  description: string;
  badge: string;
  sensitive: boolean;
  defaultForApiKeys: boolean;
  defaultForOAuthApps: boolean;
}

export const PUBLIC_API_SCOPE_DEFINITIONS = [
  {
    scope: 'verification:read',
    label: 'Read verification status',
    description: 'Check whether a user is verified for your server or package.',
    badge: 'Read',
    sensitive: false,
    defaultForApiKeys: true,
    defaultForOAuthApps: true,
  },
  {
    scope: 'subjects:read',
    label: 'Read subject data',
    description: 'Read verified user records and linked subject identifiers.',
    badge: 'Read',
    sensitive: false,
    defaultForApiKeys: true,
    defaultForOAuthApps: false,
  },
  {
    scope: 'profile:read',
    label: 'Read basic profile',
    description: 'Read the signed-in YUCP account profile.',
    badge: 'Profile',
    sensitive: false,
    defaultForApiKeys: false,
    defaultForOAuthApps: false,
  },
  {
    scope: 'products:read',
    label: 'Read product catalog',
    description: 'Read product records needed to verify package access and imports.',
    badge: 'Catalog',
    sensitive: false,
    defaultForApiKeys: false,
    defaultForOAuthApps: false,
  },
  {
    scope: 'products:write',
    label: 'Publish product releases',
    description: 'Create and update product package releases and delivery metadata.',
    badge: 'Write',
    sensitive: true,
    defaultForApiKeys: false,
    defaultForOAuthApps: false,
  },
  {
    scope: 'entitlements:read',
    label: 'Read entitlements',
    description: 'Read purchase entitlement records.',
    badge: 'Read',
    sensitive: true,
    defaultForApiKeys: false,
    defaultForOAuthApps: false,
  },
  {
    scope: 'transactions:read',
    label: 'Read transactions',
    description: 'Read transaction and membership history.',
    badge: 'Sensitive',
    sensitive: true,
    defaultForApiKeys: false,
    defaultForOAuthApps: false,
  },
  {
    scope: 'downloads:read',
    label: 'Read downloads',
    description: 'Read downloadable package artifacts and delivery metadata.',
    badge: 'Sensitive',
    sensitive: true,
    defaultForApiKeys: false,
    defaultForOAuthApps: false,
  },
  {
    scope: 'collaborators:read',
    label: 'Read collaborators',
    description: 'Read collaborator access records.',
    badge: 'Read',
    sensitive: true,
    defaultForApiKeys: false,
    defaultForOAuthApps: false,
  },
  {
    scope: 'webhooks:manage',
    label: 'Manage webhooks',
    description: 'Create, update, test, and disable public API webhooks.',
    badge: 'Manage',
    sensitive: true,
    defaultForApiKeys: false,
    defaultForOAuthApps: false,
  },
  {
    scope: 'events:read',
    label: 'Read events',
    description: 'Read public API event records.',
    badge: 'Read',
    sensitive: true,
    defaultForApiKeys: false,
    defaultForOAuthApps: false,
  },
  {
    scope: 'audit-log:read',
    label: 'Read audit log',
    description: 'Read audit log entries for account and integration activity.',
    badge: 'Sensitive',
    sensitive: true,
    defaultForApiKeys: false,
    defaultForOAuthApps: false,
  },
  {
    scope: 'guilds:read',
    label: 'Read guild data',
    description: 'Read Discord guild and role-rule configuration.',
    badge: 'Read',
    sensitive: true,
    defaultForApiKeys: false,
    defaultForOAuthApps: false,
  },
  {
    scope: 'connections:read',
    label: 'Read connections',
    description: 'Read connected provider account status.',
    badge: 'Read',
    sensitive: true,
    defaultForApiKeys: false,
    defaultForOAuthApps: false,
  },
  {
    scope: 'settings:read',
    label: 'Read settings',
    description: 'Read creator public API settings.',
    badge: 'Read',
    sensitive: true,
    defaultForApiKeys: false,
    defaultForOAuthApps: false,
  },
  {
    scope: 'settings:write',
    label: 'Update settings',
    description: 'Update creator public API settings.',
    badge: 'Write',
    sensitive: true,
    defaultForApiKeys: false,
    defaultForOAuthApps: false,
  },
  {
    scope: 'licenses:manage',
    label: 'Manage manual licenses',
    description: 'Create, update, revoke, and inspect manual license records.',
    badge: 'Manage',
    sensitive: true,
    defaultForApiKeys: false,
    defaultForOAuthApps: false,
  },
  {
    scope: 'cert:issue',
    label: 'Issue signing certificate',
    description: 'Issue YUCP code-signing certificates for Unity tooling.',
    badge: 'Sign',
    sensitive: true,
    defaultForApiKeys: false,
    defaultForOAuthApps: false,
  },
] as const satisfies readonly PublicApiScopeDefinition[];

export const PUBLIC_API_SCOPES = PUBLIC_API_SCOPE_DEFINITIONS.map((definition) => definition.scope);
export const DEFAULT_PUBLIC_API_KEY_SCOPES = PUBLIC_API_SCOPE_DEFINITIONS.filter(
  (definition) => definition.defaultForApiKeys
).map((definition) => definition.scope);
export const DEFAULT_OAUTH_APP_SCOPES = PUBLIC_API_SCOPE_DEFINITIONS.filter(
  (definition) => definition.defaultForOAuthApps
).map((definition) => definition.scope);

/** Display copy for a single scope on the OAuth consent screen. */
export interface OAuthScopeDisplay {
  label: string;
  description: string;
  badge: string;
}

/**
 * Standard OpenID Connect / OAuth 2.0 scopes that are not YUCP API scopes but may
 * still be requested by clients (e.g. the Unity editor requests `offline_access` to
 * stay signed in). Kept separate from PublicApiScope so they never appear as
 * assignable API-key permissions, but still render with proper copy on consent.
 * Reference: https://openid.net/specs/openid-connect-core-1_0.html#ScopeClaims
 */
export const STANDARD_OAUTH_SCOPE_DEFINITIONS: Record<string, OAuthScopeDisplay> = {
  offline_access: {
    label: 'Stay signed in',
    description:
      'Keep your session active so you do not have to sign in again when it expires. Grants a refresh token the app rotates automatically; it can be revoked any time.',
    badge: 'Session',
  },
  openid: {
    label: 'Confirm your identity',
    description: 'Sign you in by confirming your YUCP identity.',
    badge: 'Identity',
  },
  profile: {
    label: 'Read basic profile',
    description: 'View your YUCP display name and avatar.',
    badge: 'Profile',
  },
  email: {
    label: 'Read your email address',
    description: 'View the email address on your YUCP account.',
    badge: 'Email',
  },
};

const PUBLIC_API_SCOPE_DISPLAY: Record<string, OAuthScopeDisplay> = Object.fromEntries(
  PUBLIC_API_SCOPE_DEFINITIONS.map((definition) => [
    definition.scope,
    { label: definition.label, description: definition.description, badge: definition.badge },
  ])
);

/**
 * Single source of truth for how any requested scope is presented to users.
 * Resolves YUCP API scopes first, then standard OIDC scopes, then a generic
 * fallback for unknown scopes. UI surfaces (consent screen, dashboards) should
 * use this instead of maintaining their own scope copy.
 */
export function getOAuthScopeDisplay(scope: string): OAuthScopeDisplay {
  return (
    PUBLIC_API_SCOPE_DISPLAY[scope] ??
    STANDARD_OAUTH_SCOPE_DEFINITIONS[scope] ?? {
      label: scope,
      description: 'Custom permission scope',
      badge: 'Access',
    }
  );
}

const PUBLIC_API_SCOPE_SET = new Set<string>(PUBLIC_API_SCOPES);

export function isPublicApiScope(scope: string): scope is PublicApiScope {
  return PUBLIC_API_SCOPE_SET.has(scope);
}

export function normalizePublicApiScopeList(
  scopes: unknown,
  fallback: readonly PublicApiScope[],
  errorMessage: string
): PublicApiScope[] {
  const values =
    Array.isArray(scopes) && scopes.length > 0
      ? scopes.map((scope) => (typeof scope === 'string' ? scope.trim() : '')).filter(Boolean)
      : [...fallback];

  if (values.some((scope) => !isPublicApiScope(scope))) {
    throw new Error(errorMessage);
  }

  return Array.from(new Set(values)) as PublicApiScope[];
}
