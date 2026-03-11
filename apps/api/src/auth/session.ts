/**
 * Session management configuration and utilities for Better Auth
 * Provides production-safe session settings, CSRF protection, and session invalidation
 */

import type { Auth } from './index';

/**
 * Session cookie attributes for production safety
 */
export const SECURE_COOKIE_ATTRIBUTES = {
  httpOnly: true,
  secure: true,
  sameSite: 'strict' as const,
  path: '/',
};

/**
 * Development cookie attributes (less restrictive for local testing)
 */
export const DEV_COOKIE_ATTRIBUTES = {
  httpOnly: true,
  secure: false,
  sameSite: 'lax' as const,
  path: '/',
};

/**
 * Session configuration for Better Auth
 * - 7 day session expiration (604800 seconds)
 * - 1 day refresh window (86400 seconds)
 * - Cookie caching enabled for performance
 */
export function createSessionConfig(isProduction: boolean) {
  return {
    modelName: 'session',
    expiresIn: 60 * 60 * 24 * 7, // 7 days in seconds
    updateAge: 60 * 60 * 24, // 1 day in seconds
    cookieCache: {
      enabled: true,
      maxAge: 5 * 60, // 5 minutes
    },
  };
}

/**
 * Advanced cookie configuration for Better Auth
 */
export function createCookieConfig(isProduction: boolean) {
  const attributes = isProduction ? SECURE_COOKIE_ATTRIBUTES : DEV_COOKIE_ATTRIBUTES;

  return {
    session_token: {
      name: 'yucp_session_token',
      attributes,
    },
    csrf_token: {
      name: 'yucp_csrf_token',
      attributes,
    },
  };
}

/**
 * Session invalidation utilities
 */
export interface SessionManager {
  /**
   * Invalidate a specific session by token
   */
  revokeSession: (token: string) => Promise<void>;

  /**
   * Invalidate all sessions for a user
   */
  revokeAllUserSessions: (userId: string) => Promise<void>;

  /**
   * List all active sessions for a user
   */
  listUserSessions: (userId: string) => Promise<SessionInfo[]>;
}

export interface SessionInfo {
  id: string;
  userId: string;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
  userAgent?: string;
  ipAddress?: string;
}

interface BetterAuthAdminApi {
  revokeSession(args: { body: { token: string } }): Promise<void>;
  revokeUserSessions(args: { body: { userId: string } }): Promise<void>;
  listUserSessions(args: { body: { userId: string } }): Promise<SessionInfo[] | null | undefined>;
}

/**
 * Creates a session manager from a Better Auth instance
 * Uses the admin plugin for user session management
 * Note: Admin plugin methods are added at runtime, so we use type assertion
 */
export function createSessionManager(auth: Auth): SessionManager {
  const adminApi = (auth as unknown as { api: BetterAuthAdminApi }).api;

  return {
    async revokeSession(token: string) {
      await adminApi.revokeSession({ body: { token } });
    },

    async revokeAllUserSessions(userId: string) {
      await adminApi.revokeUserSessions({ body: { userId } });
    },

    async listUserSessions(userId: string) {
      return (await adminApi.listUserSessions({ body: { userId } })) ?? [];
    },
  };
}
