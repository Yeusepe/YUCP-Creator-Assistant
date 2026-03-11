/**
 * Gumroad OAuth 2.0 Implementation
 *
 * Implements the OAuth 2.0 authorization code flow for Gumroad.
 * Supports PKCE for enhanced security when possible.
 *
 * Reference: https://gumroad.com/api#section/Authentication
 */

import type {
  AuthorizationUrlResult,
  GumroadAdapterConfig,
  GumroadOAuthError,
  GumroadTokenResponse,
  GumroadUserResponse,
  OAuthCompletionResult,
  OAuthState,
} from './types';

// Default endpoints
const DEFAULT_OAUTH_BASE_URL = 'https://gumroad.com';
const DEFAULT_API_BASE_URL = 'https://api.gumroad.com/v2';

/**
 * Generate a cryptographically random string for state/PKCE
 */
function generateRandomString(length: number): string {
  const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const values = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(values, (v) => charset[v % charset.length]).join('');
}

/**
 * Generate SHA256 hash for PKCE code challenge
 */
async function sha256(plain: string): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const data = encoder.encode(plain);
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
}

/**
 * Base64 URL encode (no padding)
 */
function base64UrlEncode(bytes: Uint8Array): string {
  const base64 =
    typeof Buffer !== 'undefined'
      ? Buffer.from(bytes).toString('base64')
      : btoa(String.fromCharCode(...bytes));
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Generate PKCE code verifier and challenge
 */
async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
  const verifier = generateRandomString(64);
  const challengeBytes = await sha256(verifier);
  const challenge = base64UrlEncode(challengeBytes);
  return { verifier, challenge };
}

/**
 * Gumroad OAuth client for managing the authorization flow
 */
export class GumroadOAuthClient {
  private readonly oauthBaseUrl: string;
  private readonly apiBaseUrl: string;

  constructor(private readonly config: GumroadAdapterConfig) {
    this.oauthBaseUrl = config.oauthBaseUrl ?? DEFAULT_OAUTH_BASE_URL;
    this.apiBaseUrl = config.apiBaseUrl ?? DEFAULT_API_BASE_URL;
  }

  /**
   * Generate the authorization URL for the OAuth flow.
   * User should be redirected to this URL to authorize the application.
   *
   * @param tenantId - The tenant ID for multi-tenant context
   * @param options - Optional parameters (scope, subjectId)
   * @returns Authorization URL and state for the OAuth flow
   */
  async getAuthorizationUrl(
    tenantId: string,
    options?: {
      scope?: string;
      subjectId?: string;
    }
  ): Promise<AuthorizationUrlResult> {
    // Generate state for CSRF protection
    const state = generateRandomString(32);

    // Generate PKCE for enhanced security
    const { verifier, challenge } = await generatePKCE();

    // Build authorization URL
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      response_type: 'code',
      scope: options?.scope ?? 'view_profile view_sales',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });

    const url = `${this.oauthBaseUrl}/oauth/authorize?${params.toString()}`;

    return {
      url,
      state,
      codeVerifier: verifier,
    };
  }

  /**
   * Exchange authorization code for access token.
   *
   * @param code - The authorization code from the callback
   * @param codeVerifier - The PKCE code verifier from the authorization step
   * @returns Token response with access and refresh tokens
   */
  async exchangeCodeForToken(code: string, codeVerifier: string): Promise<GumroadTokenResponse> {
    const response = await fetch(`${this.oauthBaseUrl}/oauth/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        code,
        redirect_uri: this.config.redirectUri,
        grant_type: 'authorization_code',
        code_verifier: codeVerifier,
      }).toString(),
    });

    if (!response.ok) {
      const error = (await response.json()) as GumroadOAuthError;
      throw new OAuthError(error.error_description ?? error.error, error.error, response.status);
    }

    return response.json() as Promise<GumroadTokenResponse>;
  }

  /**
   * Refresh an access token using a refresh token.
   *
   * @param refreshToken - The refresh token from the initial token exchange
   * @returns New token response with fresh access token
   */
  async refreshAccessToken(refreshToken: string): Promise<GumroadTokenResponse> {
    const response = await fetch(`${this.oauthBaseUrl}/oauth/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }).toString(),
    });

    if (!response.ok) {
      const error = (await response.json()) as GumroadOAuthError;
      throw new OAuthError(error.error_description ?? error.error, error.error, response.status);
    }

    return response.json() as Promise<GumroadTokenResponse>;
  }

  /**
   * Get the current authenticated user's profile.
   *
   * @param accessToken - The OAuth access token
   * @returns User profile information
   */
  async getCurrentUser(accessToken: string): Promise<GumroadUserResponse> {
    const response = await fetch(`${this.apiBaseUrl}/users/@me?access_token=${accessToken}`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new GumroadApiError(`Failed to get user: ${text}`, response.status);
    }

    return response.json() as Promise<GumroadUserResponse>;
  }

  /**
   * Complete the OAuth flow by exchanging code for tokens and fetching user info.
   *
   * @param code - The authorization code from the callback
   * @param codeVerifier - The PKCE code verifier
   * @returns OAuth completion result with user ID and encrypted tokens
   */
  async completeOAuthFlow(code: string, codeVerifier: string): Promise<OAuthCompletionResult> {
    try {
      // Exchange code for tokens
      const tokenResponse = await this.exchangeCodeForToken(code, codeVerifier);

      // Get user info
      const userResponse = await this.getCurrentUser(tokenResponse.access_token);

      if (!userResponse.success || !userResponse.user) {
        return {
          success: false,
          error: 'Failed to fetch user information',
        };
      }

      // Calculate token expiration
      const expiresIn = tokenResponse.expires_in ?? 7200; // Default 2 hours
      const expiresAt = Date.now() + expiresIn * 1000;

      return {
        success: true,
        gumroadUserId: String(userResponse.user.id),
        encryptedAccessToken: tokenResponse.access_token, // Will be encrypted by caller
        encryptedRefreshToken: tokenResponse.refresh_token, // Will be encrypted by caller
        expiresAt,
      };
    } catch (error) {
      if (error instanceof OAuthError) {
        return {
          success: false,
          error: error.message,
        };
      }
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown OAuth error',
      };
    }
  }

  /**
   * Validate OAuth state to prevent CSRF attacks.
   *
   * @param receivedState - State received from callback
   * @param expectedState - State stored from authorization
   * @returns Whether the state is valid
   */
  validateState(receivedState: string, expectedState: string): boolean {
    if (!receivedState || !expectedState) {
      return false;
    }
    // Use timing-safe comparison
    if (receivedState.length !== expectedState.length) {
      return false;
    }
    let result = 0;
    for (let i = 0; i < receivedState.length; i++) {
      result |= receivedState.charCodeAt(i) ^ expectedState.charCodeAt(i);
    }
    return result === 0;
  }

  /**
   * Create a state object for storage
   */
  createState(tenantId: string, subjectId?: string): OAuthState {
    return {
      state: generateRandomString(32),
      tenantId,
      subjectId,
      createdAt: Date.now(),
    };
  }

  /**
   * Check if state is expired (default: 10 minutes)
   */
  isStateExpired(state: OAuthState, maxAgeMs = 600000): boolean {
    return Date.now() - state.createdAt > maxAgeMs;
  }
}

/**
 * OAuth error class
 */
export class OAuthError extends Error {
  constructor(
    message: string,
    public readonly errorCode: string,
    public readonly statusCode: number
  ) {
    super(message);
    this.name = 'OAuthError';
  }
}

/**
 * Gumroad API error class
 */
export class GumroadApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number
  ) {
    super(message);
    this.name = 'GumroadApiError';
  }
}

/**
 * Create a Gumroad OAuth client from environment variables
 */
export function createOAuthClientFromEnv(): GumroadOAuthClient {
  const config: GumroadAdapterConfig = {
    clientId: process.env.GUMROAD_CLIENT_ID ?? '',
    clientSecret: process.env.GUMROAD_CLIENT_SECRET ?? '',
    redirectUri: process.env.GUMROAD_REDIRECT_URI ?? '',
  };

  if (!config.clientId || !config.clientSecret || !config.redirectUri) {
    throw new Error(
      'Missing Gumroad OAuth configuration. Set GUMROAD_CLIENT_ID, GUMROAD_CLIENT_SECRET, and GUMROAD_REDIRECT_URI environment variables.'
    );
  }

  return new GumroadOAuthClient(config);
}
