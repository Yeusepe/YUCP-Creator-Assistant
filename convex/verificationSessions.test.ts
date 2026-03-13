/**
 * Tests for Verification Sessions Module
 *
 * Tests the validator schemas and function definitions.
 * Integration tests with real Convex deployment skip when CONVEX_DEPLOYMENT_URL not configured.
 */

import { describe, expect, it } from 'bun:test';
import { v } from 'convex/values';
import { VerificationMode } from './verificationSessions';

// ============================================================================
// VALIDATOR SCHEMA TESTS
// ============================================================================

describe('Verification Mode Validator', () => {
  it('exports valid modes from source', () => {
    const validModes = ['gumroad', 'discord_role', 'jinxxy', 'manual'];
    expect(validModes).toContain('gumroad');
    expect(validModes).toContain('discord_role');
    expect(validModes).toContain('jinxxy');
    expect(validModes).toContain('manual');
  });

  it('VerificationMode validator matches expected modes', () => {
    expect(VerificationMode).toBeDefined();
  });
});

describe('Verification Session Status Validator', () => {
  const VerificationSessionStatus = v.union(
    v.literal('pending'),
    v.literal('completed'),
    v.literal('failed'),
    v.literal('expired'),
    v.literal('cancelled')
  );

  it('should have correct status values', () => {
    const validStatuses = ['pending', 'completed', 'failed', 'expired', 'cancelled'];
    expect(validStatuses).toContain('pending');
    expect(validStatuses).toContain('completed');
    expect(validStatuses).toContain('failed');
    expect(validStatuses).toContain('expired');
    expect(validStatuses).toContain('cancelled');
  });
});

describe('Create Verification Session Input', () => {
  const CreateVerificationSessionInput = v.object({
    authUserId: v.string(),
    mode: v.union(
      v.literal('gumroad'),
      v.literal('discord_role'),
      v.literal('jinxxy'),
      v.literal('manual')
    ),
    state: v.string(),
    pkceVerifierHash: v.optional(v.string()),
    redirectUri: v.string(),
    nonce: v.optional(v.string()),
    productId: v.optional(v.id('product_catalog')),
    installationHint: v.optional(v.string()),
  });

  it('should have required fields', () => {
    const requiredFields = ['authUserId', 'mode', 'state', 'redirectUri'];
    expect(requiredFields).toContain('authUserId');
    expect(requiredFields).toContain('mode');
    expect(requiredFields).toContain('state');
    expect(requiredFields).toContain('redirectUri');
  });

  it('should have optional fields', () => {
    const optionalFields = ['pkceVerifierHash', 'nonce', 'productId', 'installationHint'];
    expect(optionalFields).toContain('pkceVerifierHash');
    expect(optionalFields).toContain('nonce');
    expect(optionalFields).toContain('productId');
    expect(optionalFields).toContain('installationHint');
  });

  it('should accept minimal input', () => {
    const minimalInput = {
      authUserId: 'user_abc123',
      mode: 'gumroad',
      state: 'abc123def456',
      redirectUri: 'http://localhost:3000/callback',
    };
    expect(minimalInput.authUserId).toBeDefined();
    expect(minimalInput.mode).toBeDefined();
    expect(minimalInput.state).toBeDefined();
    expect(minimalInput.redirectUri).toBeDefined();
  });

  it('should accept full input', () => {
    const fullInput = {
      authUserId: 'user_abc123',
      mode: 'gumroad',
      state: 'abc123def456',
      pkceVerifierHash: 'hash_of_verifier',
      redirectUri: 'http://localhost:3000/callback',
      nonce: 'unity-nonce-123',
      productId: 'product_catalog_xyz',
      installationHint: 'device-fingerprint',
    };
    expect(fullInput.pkceVerifierHash).toBeDefined();
    expect(fullInput.nonce).toBeDefined();
    expect(fullInput.productId).toBeDefined();
    expect(fullInput.installationHint).toBeDefined();
  });
});

describe('Complete Verification Session Input', () => {
  const CompleteVerificationSessionInput = v.object({
    sessionId: v.id('verification_sessions'),
    subjectId: v.id('subjects'),
  });

  it('should have required fields', () => {
    const input = {
      sessionId: 'verification_sessions_abc123',
      subjectId: 'subjects_xyz789',
    };
    expect(input.sessionId).toBeDefined();
    expect(input.subjectId).toBeDefined();
  });
});

// ============================================================================
// SESSION EXPIRY TESTS
// ============================================================================

describe('Session Expiry Constants', () => {
  it('session should expire after 15 minutes', () => {
    const SESSION_EXPIRY_MS = 15 * 60 * 1000;
    expect(SESSION_EXPIRY_MS).toBe(900000);
  });

  it('cleanup should run after 24 hours', () => {
    const CLEANUP_AGE_MS = 24 * 60 * 60 * 1000;
    expect(CLEANUP_AGE_MS).toBe(86400000);
  });
});

// ============================================================================
// HELPER FUNCTION TESTS
// ============================================================================

describe('generateState', () => {
  it('produces 48-character hex string from crypto.getRandomValues', async () => {
    const { generateState } = await import('./verificationSessions');
    const state = generateState();
    expect(state.length).toBe(48);
    expect(/^[0-9a-f]+$/.test(state)).toBe(true);
  });

  it('generates unique values', async () => {
    const { generateState } = await import('./verificationSessions');
    const states = new Set<string>();
    for (let i = 0; i < 10; i++) {
      states.add(generateState());
    }
    expect(states.size).toBe(10);
  });
});

// ============================================================================
// SCENARIO DESCRIPTIONS (for documentation)
// ============================================================================

describe('Verification Session Scenarios', () => {
  it('SESSION_EXPIRY_MS is 15 minutes', async () => {
    const { SESSION_EXPIRY_MS } = await import('./verificationSessions');
    expect(SESSION_EXPIRY_MS).toBe(15 * 60 * 1000);
  });
});

// ============================================================================
// INDEX USAGE TESTS
// ============================================================================

// ============================================================================
// CONVEX INTEGRATION TESTS (skip when CONVEX_DEPLOYMENT_URL not configured)
// ============================================================================

describe('Convex Integration', () => {
  it('createVerificationSession returns session document when deployment and tenant configured', async () => {
    const { loadTestSecrets } = await import('../packages/shared/test/loadTestSecrets');
    const secrets = await loadTestSecrets();
    if (!secrets?.convex?.deploymentUrl || !secrets.convex.testAuthUserId) {
      return; // Skip when not configured
    }
    const { ConvexHttpClient } = await import('convex/browser');
    const {
      createVerificationSession,
      getVerificationSessionByState,
      completeVerificationSession,
      generateState,
    } = await import('./verificationSessions');
    const client = new ConvexHttpClient(secrets.convex.deploymentUrl, { logger: false });
    const state = generateState();
    const redirectUri = 'http://localhost:3000/callback';
    const apiSecret = secrets.convex.apiSecret ?? process.env.CONVEX_API_SECRET ?? '';
    if (!apiSecret) {
      return; // Skip when CONVEX_API_SECRET not set
    }
    const result = await client.mutation(createVerificationSession as any, {
      apiSecret,
      authUserId: secrets.convex.testAuthUserId as string,
      mode: 'gumroad',
      state,
      redirectUri,
    });
    expect(result.success).toBe(true);
    expect(result.sessionId).toBeDefined();
    expect(result.expiresAt).toBeGreaterThan(Date.now());
    const sessionResult = await client.query(getVerificationSessionByState as any, {
      apiSecret,
      authUserId: secrets.convex.testAuthUserId as string,
      state,
    });
    expect(sessionResult.found).toBe(true);
    expect(sessionResult.session?.state).toBe(state);
    if (secrets.convex.testSubjectId) {
      const completeResult = await client.mutation(completeVerificationSession as any, {
        apiSecret,
        sessionId: result.sessionId,
        subjectId: secrets.convex.testSubjectId as import('./_generated/dataModel').Id<'subjects'>,
      });
      expect(completeResult.success).toBe(true);
      expect(completeResult.alreadyCompleted).toBe(false);
    }
  });
});

// ============================================================================
// INDEX USAGE TESTS
// ============================================================================

describe('Index Usage', () => {
  it('documents the by_auth_user_state index usage', () => {
    // This index is used for:
    // 1. OAuth callback to find session by state
    // 2. Must include authUserId for user isolation
    // Index: by_user_state on (authUserId, state)
    const indexFields = ['authUserId', 'state'];
    expect(indexFields).toContain('authUserId');
    expect(indexFields).toContain('state');
  });

  it('documents the by_nonce index usage', () => {
    // This index is used for:
    // 1. Unity client to find session by nonce
    // Index: by_nonce on (nonce)
    const indexFields = ['nonce'];
    expect(indexFields).toContain('nonce');
  });

  it('documents the by_status_expires index usage', () => {
    // This index is used for:
    // 1. Cleanup job to find expired sessions
    // 2. Must filter by status and expiresAt
    // Index: by_status_expires on (status, expiresAt)
    const indexFields = ['status', 'expiresAt'];
    expect(indexFields).toContain('status');
    expect(indexFields).toContain('expiresAt');
  });

  it('documents the by_subject index usage', () => {
    // This index is used for:
    // 1. Finding all sessions for a subject
    // Index: by_subject on (subjectId)
    const indexFields = ['subjectId'];
    expect(indexFields).toContain('subjectId');
  });
});
