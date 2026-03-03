/**
 * Discord OAuth provider for buyer verification.
 *
 * Implements PKCE flow for secure OAuth:
 * 1. Generate state + code_verifier + code_challenge
 * 2. Redirect user to Discord authorization URL
 * 3. Exchange authorization code for tokens
 * 4. Encrypt and store tokens bound to verification session
 * 5. Use tokens to fetch user info/guild membership
 *
 * Security properties:
 * - PKCE prevents authorization code interception attacks
 * - State parameter prevents CSRF attacks
 * - Tokens encrypted with envelope encryption
 * - AAD binds tokens to tenant/provider/session
 * - Short-lived tokens (verification-session-bound)
 */

import { type EncryptedPayload, createAAD, decrypt, encrypt } from '@yucp/shared';
import {
  type BeginVerificationResult,
  type CompleteVerificationResult,
  DEFAULT_SCOPES,
  type DiscordAPIError,
  type DiscordGuildMember,
  type DiscordOAuthConfig,
  type DiscordOAuthScope,
  type DiscordOAuthTokens,
  type DiscordUser,
  type EncryptedDiscordTokens,
  type OAuthState,
  type TokenStorage,
} from './types';

/**
 * Discord API raw response for guild member.
 * This is the shape returned by /users/@me/guilds/{guild.id}/member
 */
interface DiscordGuildMemberAPIResponse {
  user: {
    id: string;
  };
  nick: string | null;
  avatar: string | null;
  roles: string[];
  joined_at: string;
  deaf: boolean;
  mute: boolean;
}

/** Discord OAuth endpoints */
const DISCORD_OAUTH_AUTHORIZE = 'https://discord.com/oauth2/authorize';
const DISCORD_OAUTH_TOKEN = 'https://discord.com/api/oauth2/token';
const DISCORD_API_BASE = 'https://discord.com/api/v10';

/** State expiration time (10 minutes) */
const STATE_EXPIRY_MS = 10 * 60 * 1000;

/**
 * Generate a cryptographically secure random string.
 * Used for state and code_verifier generation.
 */
function generateRandomString(length: number): string {
  const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const values = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(values, (v) => charset[v % charset.length]).join('');
}

/**
 * Generate SHA256 hash and encode as base64url.
 * Used for PKCE code_challenge generation.
 */
async function sha256Base64Url(plain: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(plain);
  const hash = await crypto.subtle.digest('SHA-256', data);
  // Convert to base64 and make URL-safe
  const base64 = btoa(String.fromCharCode(...new Uint8Array(hash)));
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Generate PKCE code verifier (43-128 characters).
 */
function generateCodeVerifier(): string {
  return generateRandomString(128);
}

/**
 * Generate PKCE code challenge from verifier.
 */
async function generateCodeChallenge(verifier: string): Promise<string> {
  return sha256Base64Url(verifier);
}

/**
 * Generate a unique verification session ID.
 */
function generateVerificationSessionId(): string {
  return crypto.randomUUID();
}

/**
 * Encrypt a token using envelope encryption.
 */
async function encryptToken(
  token: string,
  config: DiscordOAuthConfig,
  tokenType: 'access' | 'refresh'
): Promise<EncryptedPayload> {
  return encrypt(token, {
    keyId: config.keyId,
    keyVersion: config.keyVersion,
    kekBytes: config.kekBytes,
    aad: createAAD(config.tenantId, 'discord', tokenType),
  });
}

/**
 * Decrypt a token using envelope encryption.
 */
async function decryptToken(
  encryptedToken: EncryptedPayload,
  config: DiscordOAuthConfig,
  tokenType: 'access' | 'refresh'
): Promise<string> {
  return decrypt({
    kekBytes: config.kekBytes,
    payload: encryptedToken,
    aad: createAAD(config.tenantId, 'discord', tokenType),
  });
}

/**
 * Discord OAuth provider for buyer verification.
 *
 * @example
 * ```ts
 * const provider = new DiscordOAuthProvider({
 *   clientId: process.env.DISCORD_CLIENT_ID!,
 *   clientSecret: process.env.DISCORD_CLIENT_SECRET!,
 *   redirectUri: 'https://example.com/auth/discord/callback',
 *   scopes: ['identify', 'guilds.members.read'],
 *   kekBytes: kekFromInfisical,
 *   keyId: 'kek-v1',
 *   keyVersion: 1,
 *   tenantId: 'tenant-123',
 * }, tokenStorage);
 *
 * // Begin verification
 * const { authorizationUrl, state, verificationSessionId } = await provider.beginVerification();
 *
 * // After user authorizes, complete verification
 * const { user, encryptedTokens } = await provider.completeVerification(
 *   code,
 *   state,
 *   verificationSessionId
 * );
 * ```
 */
export class DiscordOAuthProvider {
  private readonly scopes: DiscordOAuthScope[];

  constructor(
    private readonly config: DiscordOAuthConfig,
    private readonly storage: TokenStorage
  ) {
    this.scopes = config.scopes ?? DEFAULT_SCOPES;
  }

  /**
   * Begin OAuth verification flow.
   * Generates PKCE challenge and state, stores state, returns authorization URL.
   */
  async beginVerification(): Promise<BeginVerificationResult> {
    // Generate verification session ID
    const verificationSessionId = generateVerificationSessionId();

    // Generate PKCE verifier and challenge
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = await generateCodeChallenge(codeVerifier);

    // Generate state for CSRF protection
    const state = generateRandomString(32);

    // Create OAuth state record
    const now = new Date();
    const oauthState: OAuthState = {
      state,
      codeVerifier,
      codeChallenge,
      createdAt: now,
      verificationSessionId,
      expiresAt: new Date(now.getTime() + STATE_EXPIRY_MS),
    };

    // Store state for later verification
    await this.storage.storeState(oauthState);

    // Build authorization URL
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      response_type: 'code',
      scope: this.scopes.join(' '),
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });

    const authorizationUrl = `${DISCORD_OAUTH_AUTHORIZE}?${params.toString()}`;

    return {
      authorizationUrl,
      state,
      verificationSessionId,
    };
  }

  /**
   * Complete OAuth verification flow.
   * Exchanges authorization code for tokens, encrypts and stores them.
   */
  async completeVerification(
    code: string,
    state: string,
    verificationSessionId: string
  ): Promise<CompleteVerificationResult> {
    // Retrieve and validate state
    const oauthState = await this.storage.getState(state);
    if (!oauthState) {
      throw new Error('Invalid or expired OAuth state');
    }

    // Verify state hasn't expired
    if (oauthState.expiresAt < new Date()) {
      await this.storage.deleteState(state);
      throw new Error('OAuth state has expired');
    }

    // Verify verification session ID matches
    if (oauthState.verificationSessionId !== verificationSessionId) {
      throw new Error('Verification session ID mismatch');
    }

    // Exchange code for tokens
    const tokens = await this.exchangeCodeForTokens(code, oauthState.codeVerifier);

    // Get user info
    const user = await this.getUserInfo(tokens.access_token);

    // Encrypt tokens
    const encryptedAccessToken = await encryptToken(tokens.access_token, this.config, 'access');
    const encryptedRefreshToken = await encryptToken(tokens.refresh_token, this.config, 'refresh');

    // Calculate expiration
    const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);

    // Build encrypted tokens record
    const encryptedTokens: EncryptedDiscordTokens = {
      encryptedAccessToken,
      encryptedRefreshToken,
      expiresAt,
      scopes: tokens.scope.split(' '),
      verificationSessionId,
    };

    // Store encrypted tokens
    await this.storage.storeTokens(verificationSessionId, encryptedTokens);

    // Clean up state
    await this.storage.deleteState(state);

    return {
      user,
      encryptedTokens,
      verificationSessionId,
    };
  }

  /**
   * Exchange authorization code for OAuth tokens.
   */
  private async exchangeCodeForTokens(
    code: string,
    codeVerifier: string
  ): Promise<DiscordOAuthTokens> {
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.config.redirectUri,
      code_verifier: codeVerifier,
    });

    const response = await fetch(DISCORD_OAUTH_TOKEN, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    if (!response.ok) {
      const error = (await response.json()) as DiscordAPIError;
      throw new Error(`Discord token exchange failed: ${error.message} (code: ${error.code})`);
    }

    return response.json() as Promise<DiscordOAuthTokens>;
  }

  /**
   * Get user information from Discord API.
   * Uses decrypted access token from verification session.
   */
  async getUserInfo(verificationSessionId: string): Promise<DiscordUser>;
  async getUserInfo(accessToken: string): Promise<DiscordUser>;
  async getUserInfo(accessTokenOrSessionId: string): Promise<DiscordUser> {
    // Check if this is a verification session ID or an access token
    const tokens = await this.storage.getTokens(accessTokenOrSessionId);
    let accessToken: string;

    if (tokens) {
      // It's a session ID, decrypt the access token
      accessToken = await decryptToken(tokens.encryptedAccessToken, this.config, 'access');
    } else {
      // Assume it's already an access token
      accessToken = accessTokenOrSessionId;
    }

    const response = await fetch(`${DISCORD_API_BASE}/users/@me`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      const error = (await response.json()) as DiscordAPIError;
      throw new Error(`Discord user info fetch failed: ${error.message} (code: ${error.code})`);
    }

    return response.json() as Promise<DiscordUser>;
  }

  /**
   * Get guild member information for cross-server role verification.
   * Requires `guilds.members.read` scope.
   */
  async getGuildMember(verificationSessionId: string, guildId: string): Promise<DiscordGuildMember>;
  async getGuildMember(accessToken: string, guildId: string): Promise<DiscordGuildMember>;
  async getGuildMember(
    accessTokenOrSessionId: string,
    guildId: string
  ): Promise<DiscordGuildMember> {
    // Check if this is a verification session ID or an access token
    const tokens = await this.storage.getTokens(accessTokenOrSessionId);
    let accessToken: string;

    if (tokens) {
      // It's a session ID, decrypt the access token
      accessToken = await decryptToken(tokens.encryptedAccessToken, this.config, 'access');

      // Verify the guilds.members.read scope was granted
      if (!tokens.scopes.includes('guilds.members.read')) {
        throw new Error('guilds.members.read scope not granted for this verification session');
      }
    } else {
      // Assume it's already an access token
      accessToken = accessTokenOrSessionId;
    }

    const response = await fetch(`${DISCORD_API_BASE}/users/@me/guilds/${guildId}/member`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      if (response.status === 403) {
        throw new Error('Access denied: user is not a member of this guild');
      }
      if (response.status === 404) {
        throw new Error('Guild not found or user is not a member');
      }
      const error = (await response.json()) as DiscordAPIError;
      throw new Error(`Discord guild member fetch failed: ${error.message} (code: ${error.code})`);
    }

    const member = (await response.json()) as DiscordGuildMemberAPIResponse;

    // Transform Discord API response to our type
    return {
      userId: member.user.id,
      guildId,
      nick: member.nick,
      avatar: member.avatar,
      roles: member.roles,
      joinedAt: new Date(member.joined_at),
      deaf: member.deaf,
      mute: member.mute,
    };
  }

  /**
   * Refresh access token using refresh token.
   */
  async refreshTokens(verificationSessionId: string): Promise<EncryptedDiscordTokens> {
    const tokens = await this.storage.getTokens(verificationSessionId);
    if (!tokens) {
      throw new Error('No tokens found for verification session');
    }

    // Decrypt refresh token
    const refreshToken = await decryptToken(tokens.encryptedRefreshToken, this.config, 'refresh');

    // Refresh the tokens
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });

    const response = await fetch(DISCORD_OAUTH_TOKEN, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    if (!response.ok) {
      const error = (await response.json()) as DiscordAPIError;
      throw new Error(`Discord token refresh failed: ${error.message} (code: ${error.code})`);
    }

    const newTokens = (await response.json()) as DiscordOAuthTokens;

    // Encrypt new tokens
    const encryptedAccessToken = await encryptToken(newTokens.access_token, this.config, 'access');
    const encryptedRefreshToken = await encryptToken(
      newTokens.refresh_token,
      this.config,
      'refresh'
    );

    const expiresAt = new Date(Date.now() + newTokens.expires_in * 1000);

    const encryptedTokens: EncryptedDiscordTokens = {
      encryptedAccessToken,
      encryptedRefreshToken,
      expiresAt,
      scopes: newTokens.scope.split(' '),
      verificationSessionId,
    };

    // Update stored tokens
    await this.storage.storeTokens(verificationSessionId, encryptedTokens);

    return encryptedTokens;
  }

  /**
   * Revoke tokens for a verification session.
   */
  async revokeTokens(verificationSessionId: string): Promise<void> {
    const tokens = await this.storage.getTokens(verificationSessionId);
    if (!tokens) {
      return; // Already revoked or never existed
    }

    // Decrypt access token for revocation
    const accessToken = await decryptToken(tokens.encryptedAccessToken, this.config, 'access');

    // Revoke the token with Discord
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      token: accessToken,
    });

    await fetch('https://discord.com/api/oauth2/token/revoke', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    // Delete stored tokens
    await this.storage.deleteTokens(verificationSessionId);
  }

  /**
   * Check if tokens are expired for a verification session.
   */
  async isTokenExpired(verificationSessionId: string): Promise<boolean> {
    const tokens = await this.storage.getTokens(verificationSessionId);
    if (!tokens) {
      return true;
    }
    return tokens.expiresAt < new Date();
  }

  /**
   * Check if a user has a specific role in a guild.
   */
  async hasRole(verificationSessionId: string, guildId: string, roleId: string): Promise<boolean> {
    const member = await this.getGuildMember(verificationSessionId, guildId);
    return member.roles.includes(roleId);
  }

  /**
   * Check if a user has any of the specified roles in a guild.
   */
  async hasAnyRole(
    verificationSessionId: string,
    guildId: string,
    roleIds: string[]
  ): Promise<boolean> {
    const member = await this.getGuildMember(verificationSessionId, guildId);
    return roleIds.some((roleId) => member.roles.includes(roleId));
  }

  /**
   * Check if a user has all of the specified roles in a guild.
   */
  async hasAllRoles(
    verificationSessionId: string,
    guildId: string,
    roleIds: string[]
  ): Promise<boolean> {
    const member = await this.getGuildMember(verificationSessionId, guildId);
    return roleIds.every((roleId) => member.roles.includes(roleId));
  }
}
