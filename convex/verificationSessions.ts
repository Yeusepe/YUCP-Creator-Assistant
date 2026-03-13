/**
 * Verification Session Management
 *
 * Handles the lifecycle of verification sessions for OAuth and PKCE flows.
 * Sessions are short-lived (15 minutes) and provide replay protection.
 *
 * Flow:
 * 1. createVerificationSession - stores state, nonce, PKCE verifier hash
 * 2. getVerificationSessionByState - retrieves session on OAuth callback
 * 3. completeVerificationSession - marks session as completed, links subject
 * 4. expireVerificationSession - marks session as expired
 * 5. cleanupExpiredSessions - removes old expired sessions
 */

import { v } from 'convex/values';
import type { Id } from './_generated/dataModel';
import { mutation, query } from './_generated/server';
import { VerificationModeV } from './lib/providers';

// ============================================================================
// CONSTANTS
// ============================================================================

/** Session expiry time in milliseconds (15 minutes) */
export const SESSION_EXPIRY_MS = 15 * 60 * 1000;

/** Maximum age for cleanup of expired sessions (24 hours) */
export const CLEANUP_AGE_MS = 24 * 60 * 60 * 1000;

// ============================================================================
// VERIFICATION MODE TYPE
// ============================================================================

export const VerificationMode = VerificationModeV;

export type VerificationMode = typeof VerificationMode.type;

function requireApiSecret(apiSecret: string | undefined): void {
  const expected = process.env.CONVEX_API_SECRET;
  if (!expected || apiSecret !== expected) {
    throw new Error('Unauthorized: invalid or missing API secret');
  }
}

// ============================================================================
// QUERIES
// ============================================================================

/**
 * Get a verification session by state parameter.
 * Used by OAuth callback to retrieve session data.
 * Only returns pending sessions that haven't expired.
 * Requires apiSecret - called by API server only.
 */
export const getVerificationSessionByState = query({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    state: v.string(),
  },
  returns: v.union(
    v.object({
      found: v.literal(true),
      session: v.object({
        _id: v.id('verification_sessions'),
        _creationTime: v.number(),
        authUserId: v.string(),
        subjectId: v.optional(v.id('subjects')),
        mode: VerificationModeV,
        providerKey: v.optional(v.string()),
        verificationMethod: v.optional(v.string()),
        productId: v.optional(v.id('product_catalog')),
        state: v.string(),
        pkceVerifierHash: v.optional(v.string()),
        pkceVerifier: v.optional(v.string()),
        redirectUri: v.string(),
        successRedirectUri: v.optional(v.string()),
        discordUserId: v.optional(v.string()),
        nonce: v.optional(v.string()),
        installationHint: v.optional(v.string()),
        expiresAt: v.number(),
        status: v.union(
          v.literal('pending'),
          v.literal('completed'),
          v.literal('failed'),
          v.literal('expired'),
          v.literal('cancelled')
        ),
        errorMessage: v.optional(v.string()),
        createdAt: v.number(),
        updatedAt: v.number(),
      }),
    }),
    v.object({
      found: v.literal(false),
      session: v.null(),
    })
  ),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const session = await ctx.db
      .query('verification_sessions')
      .withIndex('by_auth_user_state', (q) => q.eq('authUserId', args.authUserId).eq('state', args.state))
      .first();

    if (!session) {
      return { found: false as const, session: null };
    }

    // Check if session is expired (but not yet marked as such)
    if (session.status === 'pending' && Date.now() > session.expiresAt) {
      // Session has expired but not yet marked - treat as not found
      return { found: false as const, session: null };
    }

    // Only return pending sessions for OAuth callback
    if (session.status !== 'pending') {
      return { found: false as const, session: null };
    }

    return { found: true as const, session };
  },
});

/**
 * Get a verification session by nonce.
 * Used by Unity integration to retrieve session data.
 * Requires apiSecret - called by API server only.
 */
export const getVerificationSessionByNonce = query({
  args: {
    apiSecret: v.string(),
    nonce: v.string(),
  },
  returns: v.union(
    v.object({
      found: v.literal(true),
      session: v.object({
        _id: v.id('verification_sessions'),
        _creationTime: v.number(),
        authUserId: v.string(),
        subjectId: v.optional(v.id('subjects')),
        mode: VerificationModeV,
        providerKey: v.optional(v.string()),
        verificationMethod: v.optional(v.string()),
        productId: v.optional(v.id('product_catalog')),
        state: v.string(),
        pkceVerifierHash: v.optional(v.string()),
        redirectUri: v.string(),
        successRedirectUri: v.optional(v.string()),
        nonce: v.optional(v.string()),
        installationHint: v.optional(v.string()),
        expiresAt: v.number(),
        status: v.union(
          v.literal('pending'),
          v.literal('completed'),
          v.literal('failed'),
          v.literal('expired'),
          v.literal('cancelled')
        ),
        errorMessage: v.optional(v.string()),
        createdAt: v.number(),
        updatedAt: v.number(),
      }),
    }),
    v.object({
      found: v.literal(false),
      session: v.null(),
    })
  ),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const session = await ctx.db
      .query('verification_sessions')
      .withIndex('by_nonce', (q) => q.eq('nonce', args.nonce))
      .first();

    if (!session) {
      return { found: false as const, session: null };
    }

    // Check if session is expired
    if (session.status === 'pending' && Date.now() > session.expiresAt) {
      return { found: false as const, session: null };
    }

    // Only return pending sessions
    if (session.status !== 'pending') {
      return { found: false as const, session: null };
    }

    return { found: true as const, session };
  },
});

/**
 * Get all pending verification sessions for a tenant.
 * Useful for debugging and admin views.
 */
export const getPendingSessionsForTenant = query({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
  },
  returns: v.array(
    v.object({
      _id: v.id('verification_sessions'),
      _creationTime: v.number(),
      mode: VerificationModeV,
      expiresAt: v.number(),
      createdAt: v.number(),
    })
  ),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const now = Date.now();
    const sessions = await ctx.db
      .query('verification_sessions')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))
      .filter((q) => q.eq(q.field('status'), 'pending'))
      .filter((q) => q.gt(q.field('expiresAt'), now))
      .collect();

    return sessions.map((s) => ({
      _id: s._id,
      _creationTime: s._creationTime,
      mode: s.mode,
      expiresAt: s.expiresAt,
      createdAt: s.createdAt,
    }));
  },
});

// ============================================================================
// MUTATIONS
// ============================================================================

/**
 * Create a new verification session.
 * Stores state, nonce, PKCE verifier hash, mode, authUserId, and expiry.
 * Requires apiSecret - called by API server only.
 */
export const createVerificationSession = mutation({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    mode: VerificationMode,
    providerKey: v.optional(v.string()),
    verificationMethod: v.optional(v.string()),
    state: v.string(),
    pkceVerifierHash: v.optional(v.string()),
    pkceVerifier: v.optional(v.string()),
    redirectUri: v.string(),
    successRedirectUri: v.optional(v.string()),
    discordUserId: v.optional(v.string()),
    nonce: v.optional(v.string()),
    productId: v.optional(v.id('product_catalog')),
    installationHint: v.optional(v.string()),
  },
  returns: v.object({
    success: v.boolean(),
    sessionId: v.id('verification_sessions'),
    expiresAt: v.number(),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const now = Date.now();
    const expiresAt = now + SESSION_EXPIRY_MS;

    // Check for existing session with same state (replay protection)
    const existingSession = await ctx.db
      .query('verification_sessions')
      .withIndex('by_auth_user_state', (q) => q.eq('authUserId', args.authUserId).eq('state', args.state))
      .first();

    if (existingSession && existingSession.status === 'pending') {
      // A pending session with this state already exists
      // This could be a replay attack or a user refreshing the page
      if (existingSession.expiresAt > now) {
        // Session is still valid - return existing
        return {
          success: true,
          sessionId: existingSession._id,
          expiresAt: existingSession.expiresAt,
        };
      }
      // Session expired - mark it and create new one
      await ctx.db.patch(existingSession._id, {
        status: 'expired',
        updatedAt: now,
      });
    }

    const sessionId = await ctx.db.insert('verification_sessions', {
      authUserId: args.authUserId,
      mode: args.mode,
      providerKey: args.providerKey,
      verificationMethod: args.verificationMethod ?? args.mode,
      state: args.state,
      pkceVerifierHash: args.pkceVerifierHash,
      pkceVerifier: args.pkceVerifier,
      redirectUri: args.redirectUri,
      successRedirectUri: args.successRedirectUri,
      discordUserId: args.discordUserId,
      nonce: args.nonce,
      productId: args.productId,
      installationHint: args.installationHint,
      expiresAt,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    });

    return {
      success: true,
      sessionId,
      expiresAt,
    };
  },
});

/**
 * Complete a verification session.
 * Marks the session as completed and links it to the subject.
 * Requires apiSecret - called by API server only.
 */
export const completeVerificationSession = mutation({
  args: {
    apiSecret: v.string(),
    sessionId: v.id('verification_sessions'),
    subjectId: v.id('subjects'),
  },
  returns: v.object({
    success: v.boolean(),
    alreadyCompleted: v.boolean(),
    redirectUri: v.string(),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const now = Date.now();
    const session = await ctx.db.get(args.sessionId);

    if (!session) {
      throw new Error(`Verification session not found: ${args.sessionId}`);
    }

    // Check for replay - session already used
    if (session.status === 'completed') {
      return {
        success: false,
        alreadyCompleted: true,
        redirectUri: session.successRedirectUri ?? session.redirectUri,
      };
    }

    // Check for expired/failed/cancelled sessions
    if (session.status !== 'pending') {
      throw new Error(`Verification session is not pending: ${session.status}`);
    }

    // Check expiry
    if (now > session.expiresAt) {
      await ctx.db.patch(args.sessionId, {
        status: 'expired',
        updatedAt: now,
      });
      throw new Error('Verification session has expired');
    }

    // Mark as completed and link subject
    await ctx.db.patch(args.sessionId, {
      subjectId: args.subjectId,
      status: 'completed',
      updatedAt: now,
    });

    return {
      success: true,
      alreadyCompleted: false,
      redirectUri: session.successRedirectUri ?? session.redirectUri,
    };
  },
});

/**
 * Mark a verification session as expired.
 * Requires apiSecret - called by API server only.
 */
export const expireVerificationSession = mutation({
  args: {
    apiSecret: v.string(),
    sessionId: v.id('verification_sessions'),
  },
  returns: v.object({
    success: v.boolean(),
    previousStatus: v.union(
      v.literal('pending'),
      v.literal('completed'),
      v.literal('failed'),
      v.literal('expired'),
      v.literal('cancelled')
    ),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const session = await ctx.db.get(args.sessionId);

    if (!session) {
      throw new Error(`Verification session not found: ${args.sessionId}`);
    }

    const previousStatus = session.status;

    if (previousStatus !== 'pending') {
      // Can only expire pending sessions
      return { success: false, previousStatus };
    }

    await ctx.db.patch(args.sessionId, {
      status: 'expired',
      updatedAt: Date.now(),
    });

    return { success: true, previousStatus };
  },
});

/**
 * Mark a verification session as failed.
 * Requires apiSecret - called by API server only.
 */
export const failVerificationSession = mutation({
  args: {
    apiSecret: v.string(),
    sessionId: v.id('verification_sessions'),
    errorMessage: v.string(),
  },
  returns: v.object({
    success: v.boolean(),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const session = await ctx.db.get(args.sessionId);

    if (!session) {
      throw new Error(`Verification session not found: ${args.sessionId}`);
    }

    if (session.status !== 'pending') {
      return { success: false };
    }

    await ctx.db.patch(args.sessionId, {
      status: 'failed',
      errorMessage: args.errorMessage,
      updatedAt: Date.now(),
    });

    return { success: true };
  },
});

/**
 * Cancel a verification session.
 * Requires apiSecret - called by API server only.
 */
export const cancelVerificationSession = mutation({
  args: {
    apiSecret: v.string(),
    sessionId: v.id('verification_sessions'),
  },
  returns: v.object({
    success: v.boolean(),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const session = await ctx.db.get(args.sessionId);

    if (!session) {
      throw new Error(`Verification session not found: ${args.sessionId}`);
    }

    if (session.status !== 'pending') {
      return { success: false };
    }

    await ctx.db.patch(args.sessionId, {
      status: 'cancelled',
      updatedAt: Date.now(),
    });

    return { success: true };
  },
});

/**
 * Cleanup expired sessions.
 * Removes sessions that have been expired for more than CLEANUP_AGE_MS.
 * This is a maintenance mutation that should be called periodically.
 */
export const cleanupExpiredSessions = mutation({
  args: {},
  returns: v.object({
    cleaned: v.number(),
  }),
  handler: async (ctx) => {
    const now = Date.now();
    const cleanupThreshold = now - CLEANUP_AGE_MS;

    // Find sessions that are expired and old enough to clean up
    const expiredSessions = await ctx.db
      .query('verification_sessions')
      .withIndex('by_status_expires', (q) =>
        q.eq('status', 'expired').lt('expiresAt', cleanupThreshold)
      )
      .collect();

    // Delete old expired sessions
    let cleaned = 0;
    for (const session of expiredSessions) {
      await ctx.db.delete(session._id);
      cleaned++;
    }

    // Also mark any pending sessions that have expired
    const newlyExpired = await ctx.db
      .query('verification_sessions')
      .withIndex('by_status_expires', (q) => q.eq('status', 'pending').lt('expiresAt', now))
      .collect();

    for (const session of newlyExpired) {
      await ctx.db.patch(session._id, {
        status: 'expired',
        updatedAt: now,
      });
    }

    return { cleaned };
  },
});

/**
 * Get or create a verification session by nonce.
 * Requires apiSecret - called by API server only.
 */
export const getOrCreateSessionByNonce = mutation({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    mode: VerificationMode,
    providerKey: v.optional(v.string()),
    verificationMethod: v.optional(v.string()),
    nonce: v.string(),
    redirectUri: v.string(),
    productId: v.optional(v.id('product_catalog')),
    installationHint: v.optional(v.string()),
  },
  returns: v.object({
    sessionId: v.id('verification_sessions'),
    state: v.string(),
    isNew: v.boolean(),
    expiresAt: v.number(),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const now = Date.now();

    // Check for existing session with this nonce
    const existingSession = await ctx.db
      .query('verification_sessions')
      .withIndex('by_nonce', (q) => q.eq('nonce', args.nonce))
      .first();

    if (existingSession) {
      if (existingSession.status === 'pending' && existingSession.expiresAt > now) {
        // Return existing valid session
        return {
          sessionId: existingSession._id,
          state: existingSession.state,
          isNew: false,
          expiresAt: existingSession.expiresAt,
        };
      }
      // Session expired or completed - create new one
    }

    // Generate new state
    const state = generateState();
    const expiresAt = now + SESSION_EXPIRY_MS;

    const sessionId = await ctx.db.insert('verification_sessions', {
      authUserId: args.authUserId,
      mode: args.mode,
      providerKey: args.providerKey,
      verificationMethod: args.verificationMethod ?? args.mode,
      state,
      nonce: args.nonce,
      redirectUri: args.redirectUri,
      productId: args.productId,
      installationHint: args.installationHint,
      expiresAt,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    });

    return {
      sessionId,
      state,
      isNew: true,
      expiresAt,
    };
  },
});

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Generate a cryptographically secure random state string.
 * Uses Web Crypto API for CSRF protection in OAuth flows.
 */
export function generateState(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
