/**
 * Discord OAuth types for buyer verification.
 *
 * Supports:
 * - `identify` scope: Basic user info (id, username, avatar)
 * - `guilds.members.read` scope: Cross-server role verification
 */

import type { EncryptedPayload } from '@yucp/shared';

/**
 * Discord OAuth configuration.
 */
export interface DiscordOAuthConfig {
  /** Discord application client ID */
  clientId: string;
  /** Discord application client secret */
  clientSecret: string;
  /** Redirect URI for OAuth callback */
  redirectUri: string;
  /** OAuth scopes to request */
  scopes?: DiscordOAuthScope[];
  /** KEK bytes for token encryption */
  kekBytes: Uint8Array;
  /** Key ID for encryption tracking */
  keyId: string;
  /** Key version for encryption */
  keyVersion: number;
  /** Tenant ID for AAD binding */
  tenantId: string;
}

/**
 * Supported Discord OAuth scopes for buyer verification.
 */
export type DiscordOAuthScope = 'identify' | 'guilds.members.read' | 'email';

/**
 * Discord OAuth tokens received from authorization.
 * Note: Discord API returns snake_case properties.
 */
export interface DiscordOAuthTokens {
  /** Access token for Discord API */
  access_token: string;
  /** Refresh token for long-term access */
  refresh_token: string;
  /** Token type (always "Bearer") */
  token_type: 'Bearer';
  /** Seconds until access token expires */
  expires_in: number;
  /** OAuth scopes granted */
  scope: string;
}

/**
 * Encrypted OAuth tokens for secure storage.
 * Tokens are bound to a verification session.
 */
export interface EncryptedDiscordTokens {
  /** Encrypted access token */
  encryptedAccessToken: EncryptedPayload;
  /** Encrypted refresh token */
  encryptedRefreshToken: EncryptedPayload;
  /** Token expiration timestamp */
  expiresAt: Date;
  /** Scopes that were granted */
  scopes: string[];
  /** Verification session this token belongs to */
  verificationSessionId: string;
}

/**
 * Discord user information from /users/@me endpoint.
 */
export interface DiscordUser {
  /** User's Discord ID */
  id: string;
  /** User's username (unique across Discord) */
  username: string;
  /** User's display name (if set) */
  global_name: string | null;
  /** User's avatar hash */
  avatar: string | null;
  /** User's discriminator (legacy, usually "0" now) */
  discriminator: string;
  /** User's locale */
  locale?: string;
  /** User's email (only if email scope granted) */
  email?: string;
  /** Whether email is verified */
  verified?: boolean;
}

/**
 * Discord guild member information from /users/@me/guilds/{guild.id}/member.
 * Used for cross-server role verification.
 */
export interface DiscordGuildMember {
  /** User's Discord ID */
  userId: string;
  /** Guild ID this member belongs to */
  guildId: string;
  /** Member's nickname in the guild */
  nick: string | null;
  /** Member's avatar hash for this guild */
  avatar: string | null;
  /** Member's role IDs */
  roles: string[];
  /** When the user joined the guild */
  joinedAt: Date;
  /** Whether the member is deafened */
  deaf: boolean;
  /** Whether the member is muted */
  mute: boolean;
}

/**
 * OAuth state for PKCE flow.
 * Stored temporarily during authorization.
 */
export interface OAuthState {
  /** Random state string for CSRF protection */
  state: string;
  /** PKCE code verifier */
  codeVerifier: string;
  /** PKCE code challenge (SHA256 of verifier) */
  codeChallenge: string;
  /** When this state was created */
  createdAt: Date;
  /** Verification session ID this state belongs to */
  verificationSessionId: string;
  /** When this state expires */
  expiresAt: Date;
}

/**
 * Result of beginning OAuth verification.
 */
export interface BeginVerificationResult {
  /** OAuth authorization URL to redirect user to */
  authorizationUrl: string;
  /** State string for CSRF protection */
  state: string;
  /** Verification session ID */
  verificationSessionId: string;
}

/**
 * Result of completing OAuth verification.
 */
export interface CompleteVerificationResult {
  /** Discord user information */
  user: DiscordUser;
  /** Encrypted tokens for storage */
  encryptedTokens: EncryptedDiscordTokens;
  /** Verification session ID */
  verificationSessionId: string;
}

/**
 * Token storage interface for verification-session-bound tokens.
 */
export interface TokenStorage {
  /** Store OAuth state temporarily */
  storeState(state: OAuthState): Promise<void>;
  /** Retrieve OAuth state by state string */
  getState(state: string): Promise<OAuthState | null>;
  /** Delete OAuth state after use */
  deleteState(state: string): Promise<void>;
  /** Store encrypted tokens linked to verification session */
  storeTokens(verificationSessionId: string, tokens: EncryptedDiscordTokens): Promise<void>;
  /** Retrieve encrypted tokens for verification session */
  getTokens(verificationSessionId: string): Promise<EncryptedDiscordTokens | null>;
  /** Delete tokens (e.g., on revocation) */
  deleteTokens(verificationSessionId: string): Promise<void>;
}

/**
 * Discord API error response.
 */
export interface DiscordAPIError {
  code: number;
  message: string;
}

/**
 * Default OAuth scopes for buyer verification.
 */
export const DEFAULT_SCOPES: DiscordOAuthScope[] = ['identify'];
