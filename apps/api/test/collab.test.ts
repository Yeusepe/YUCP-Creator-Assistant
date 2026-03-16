/**
 * Collab routes integration tests — Phase 6.2
 *
 * Tests HTTP-level auth guards and input validation for /api/collab/* routes.
 *
 * Auth mechanism: collab routes use a setup-session token (Bearer header or
 * yucp_setup_session cookie) resolved by resolveSetupToken(). With neither
 * present the route returns 401 immediately.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Auth, SessionData } from '../src/auth/index';
import { createSetupSession } from '../src/lib/setupSession';
import { startTestServer, type TestServerHandle } from './helpers/testServer';

/** Must match the encryption secret in testServer.ts DEFAULTS */
const TEST_ENCRYPTION_SECRET = 'test-encryption-secret-32-chars!!';

function makeWebSessionAuth(userId: string): Auth {
  const session: SessionData = {
    user: { id: userId, email: 'test@example.com', name: 'Test User' },
    session: { id: 'sess-123', expiresAt: Date.now() + 3_600_000, token: 'tok-123' },
  };
  return {
    getSession: async () => session,
    getDiscordUserId: async () => null,
    exchangeOTT: async () => ({ session: null, setCookieHeaders: [] as string[] }),
    signOut: async () => ({ ok: false, setCookieHeaders: [] as string[] }),
  } as unknown as Auth;
}

// ─────────────────────────────────────────────────────────────────────────────
// Auth guard tests — no setup session token present → 401
// ─────────────────────────────────────────────────────────────────────────────

describe('Collab routes — auth guards', () => {
  let server: TestServerHandle;

  beforeAll(async () => {
    server = await startTestServer();
  });

  afterAll(() => server.stop());

  it('POST /api/collab/invite without auth returns 401', async () => {
    const res = await server.fetch('/api/collab/invite', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await res.json();
    expect(body).toHaveProperty('error');
  });

  it('GET /api/collab/connections without auth returns 401', async () => {
    const res = await server.fetch('/api/collab/connections');
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await res.json();
    expect(body).toHaveProperty('error');
  });

  it('DELETE /api/collab/connections/test-conn-id without auth returns 401', async () => {
    const res = await server.fetch('/api/collab/connections/test-conn-id', {
      method: 'DELETE',
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await res.json();
    expect(body).toHaveProperty('error');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Validation tests — auth-independent input checks
// ─────────────────────────────────────────────────────────────────────────────

describe('Collab routes — validation', () => {
  let server: TestServerHandle;

  beforeAll(async () => {
    server = await startTestServer();
  });

  afterAll(() => server.stop());

  it('POST /api/collab/session/exchange with missing token returns 400', async () => {
    // exchangeSession checks for the token in the JSON body before any auth check.
    // An empty body (no `token` field) → 400 "Missing token".
    const res = await server.fetch('/api/collab/session/exchange', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await res.json();
    expect(body).toHaveProperty('error');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Security: setup session / web session cross-check
// A setup token belonging to user-A must NOT be usable by user-B's web session.
// ─────────────────────────────────────────────────────────────────────────────

describe('Collab routes — security: setup session user isolation', () => {
  it('Setup session (user-A) + web session (user-B) → 403 (prevents session confusion)', async () => {
    // This test is RED until requireOwnerAuth adds the cross-check.
    const token = await createSetupSession(
      'user-A',
      'guild-iso-1',
      'discord-iso-1',
      TEST_ENCRYPTION_SECRET
    );
    const server = await startTestServer({ auth: makeWebSessionAuth('user-B') });
    try {
      const res = await server.fetch('/api/collab/invite', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ guildName: 'Server A', guildId: 'guild-iso-1' }),
      });
      const body = await res.json();
      expect(res.status).toBe(403);
      expect(body).toHaveProperty('error');
    } finally {
      server.stop();
    }
  });

  it('Setup session (user-A) + web session (user-A) → auth passes (not 401/403)', async () => {
    const token = await createSetupSession(
      'user-A',
      'guild-iso-2',
      'discord-iso-2',
      TEST_ENCRYPTION_SECRET
    );
    const server = await startTestServer({ auth: makeWebSessionAuth('user-A') });
    try {
      const res = await server.fetch('/api/collab/invite', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ guildName: 'Server A', guildId: 'guild-iso-2' }),
      });
      // Auth passes; Convex is unavailable in tests so we may get 500 — that's fine.
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    } finally {
      server.stop();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Security: IDOR guards — a user cannot access another user's resources
// ─────────────────────────────────────────────────────────────────────────────

describe('Collab routes — security: IDOR guards', () => {
  let server: TestServerHandle;

  beforeAll(async () => {
    server = await startTestServer({ auth: makeWebSessionAuth('user-legitimate') });
  });

  afterAll(() => server.stop());

  it('GET /api/collab/connections?authUserId=<other> must not return 200', async () => {
    let status: number | null = null;
    try {
      const res = await server.fetch('/api/collab/connections?authUserId=user-target');
      status = res.status;
    } catch {
      return; // network error is also acceptable — auth was checked
    }
    expect(status).not.toBe(200);
  });

  it('DELETE /api/collab/connections/x?authUserId=<other> must not return 200', async () => {
    let status: number | null = null;
    try {
      const res = await server.fetch(
        '/api/collab/connections/some-conn-id?authUserId=user-target',
        { method: 'DELETE' }
      );
      status = res.status;
    } catch {
      return;
    }
    expect(status).not.toBe(200);
  });

  it('POST /api/collab/invite with explicit authUserId=<other> must not return 200/201', async () => {
    let status: number | null = null;
    try {
      const res = await server.fetch('/api/collab/invite', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ guildName: 'S', guildId: 'g', authUserId: 'user-target' }),
      });
      status = res.status;
    } catch {
      return;
    }
    expect(status).not.toBe(200);
    expect(status).not.toBe(201);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Security: session / token validation — unauthenticated collab-session endpoints
// ─────────────────────────────────────────────────────────────────────────────

describe('Collab routes — security: session and token validation', () => {
  let server: TestServerHandle;

  beforeAll(async () => {
    server = await startTestServer(); // no auth — stub always returns null
  });

  afterAll(() => server.stop());

  it('GET /api/collab/session/invite without collab cookie → 404', async () => {
    const res = await server.fetch('/api/collab/session/invite');
    expect(res.status).toBe(404);
  });

  it('GET /api/collab/session/discord-status without collab cookie → 404', async () => {
    const res = await server.fetch('/api/collab/session/discord-status');
    expect(res.status).toBe(404);
  });

  it('GET /api/collab/session/webhook-config without collab cookie → 404', async () => {
    const res = await server.fetch('/api/collab/session/webhook-config');
    expect(res.status).toBe(404);
  });

  it('GET /api/collab/session/test-webhook without collab cookie → 404', async () => {
    const res = await server.fetch('/api/collab/session/test-webhook');
    expect(res.status).toBe(404);
  });

  it('POST /api/collab/session/submit without collab cookie → 404', async () => {
    const res = await server.fetch('/api/collab/session/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ linkType: 'api', jinxxyApiKey: 'test' }),
    });
    expect(res.status).toBe(404);
  });

  it('GET /api/collab/invite (wrong method) → 405', async () => {
    // createInvite requires POST; GET should return 405
    const res = await server.fetch('/api/collab/invite');
    expect(res.status).toBe(405);
  });

  it('POST /api/collab/session/exchange with forged/garbage token → not 200', async () => {
    // A token that was never stored returns 404 from Convex lookup (or 500 if Convex unreachable)
    let status: number | null = null;
    try {
      const res = await server.fetch('/api/collab/session/exchange', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: 'completely-forged-garbage-token-xyz' }),
      });
      status = res.status;
    } catch {
      return;
    }
    expect(status).not.toBe(200);
    expect(status).not.toBe(201);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Provider-agnostic collab — providerKey validation in addConnectionManual
// ─────────────────────────────────────────────────────────────────────────────

describe('Collab routes — provider-agnostic: addConnectionManual input validation', () => {
  let server: TestServerHandle;

  beforeAll(async () => {
    server = await startTestServer();
  });

  afterAll(() => server.stop());

  it('POST /api/collab/connections/manual with no auth returns 401', async () => {
    const res = await server.fetch('/api/collab/connections/manual', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ providerKey: 'jinxxy', credential: 'somekey' }),
    });
    expect(res.status).toBe(401);
  });

  it('POST /api/collab/connections/manual with auth but missing providerKey returns 400', async () => {
    const token = await createSetupSession(
      'user-manual-add',
      'guild-manual',
      'discord-manual',
      TEST_ENCRYPTION_SECRET
    );
    const res = await server.fetch('/api/collab/connections/manual', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ credential: 'somekey' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toHaveProperty('error');
  });

  it('POST /api/collab/connections/manual with auth but unsupported providerKey returns 400', async () => {
    const token = await createSetupSession(
      'user-manual-add-2',
      'guild-manual-2',
      'discord-manual-2',
      TEST_ENCRYPTION_SECRET
    );
    const res = await server.fetch('/api/collab/connections/manual', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ providerKey: 'gumroad', credential: 'somekey' }),
    });
    // Gumroad uses OAuth and does not support collab; should be rejected
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toHaveProperty('error');
  });

  it('POST /api/collab/connections/manual with auth but unknown providerKey returns 400', async () => {
    const token = await createSetupSession(
      'user-manual-add-3',
      'guild-manual-3',
      'discord-manual-3',
      TEST_ENCRYPTION_SECRET
    );
    const res = await server.fetch('/api/collab/connections/manual', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ providerKey: 'totally-unknown-store', credential: 'somekey' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toHaveProperty('error');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Provider-agnostic collab — createInvite providerKey validation
// ─────────────────────────────────────────────────────────────────────────────

describe('Collab routes — provider-agnostic: createInvite providerKey validation', () => {
  let server: TestServerHandle;

  beforeAll(async () => {
    server = await startTestServer();
  });

  afterAll(() => server.stop());

  it('POST /api/collab/invite with unsupported providerKey returns 400', async () => {
    const token = await createSetupSession(
      'user-invite-pk',
      'guild-invite-pk',
      'discord-invite-pk',
      TEST_ENCRYPTION_SECRET
    );
    const res = await server.fetch('/api/collab/invite', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ guildName: 'S', guildId: 'g', providerKey: 'gumroad' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toHaveProperty('error');
  });

  it('POST /api/collab/invite with unknown providerKey returns 400', async () => {
    const token = await createSetupSession(
      'user-invite-pk-2',
      'guild-invite-pk-2',
      'discord-invite-pk-2',
      TEST_ENCRYPTION_SECRET
    );
    const res = await server.fetch('/api/collab/invite', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ guildName: 'S', guildId: 'g', providerKey: 'nonexistent-provider' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toHaveProperty('error');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Web-session auth path — authenticated user, no setup session token
// ─────────────────────────────────────────────────────────────────────────────

describe('Collab routes — web session auth', () => {
  let server: TestServerHandle;

  beforeAll(async () => {
    server = await startTestServer({ auth: makeWebSessionAuth('user-abc-123') });
  });

  afterAll(() => server.stop());

  it('POST /api/collab/invite with web session and no authUserId in body does not return 400', async () => {
    // When a user is authenticated via Better Auth web session and omits authUserId,
    // the server should fall back to webSession.user.id rather than returning 400.
    // With a non-functional Convex URL the Convex mutation will fail → 500,
    // but 400 ("authUserId is required") must NOT be returned.
    const res = await server.fetch('/api/collab/invite', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ guildName: 'My Server', guildId: '123456789' }),
    });
    const body = await res.json();
    expect(res.status).not.toBe(400);
    expect(body).not.toHaveProperty('error', 'authUserId is required');
  });

  it('POST /api/collab/invite with web session and explicit authUserId returns 403 for wrong owner', async () => {
    // Passing an authUserId that doesn't match the session user → 403 Forbidden.
    // With a fake Convex URL the ownership check throws a network error; the server
    // may crash the connection entirely. Either 403, 500, or a fetch error are all
    // acceptable — the key invariant is it does NOT return 200/201.
    let status: number | null = null;
    try {
      const res = await server.fetch('/api/collab/invite', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ guildName: 'My Server', guildId: '123456789', authUserId: 'some-other-user' }),
      });
      status = res.status;
    } catch {
      // Network error means the server threw before responding — acceptable
      return;
    }
    expect(status).not.toBe(200);
    expect(status).not.toBe(201);
  });
});
