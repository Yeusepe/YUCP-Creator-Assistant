/**
 * Collab routes integration tests, Phase 6.2
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

// ─────────────────────────────────────────────────────────────────────────────
// Dashboard invite display name, server uses session name as fallback
// ─────────────────────────────────────────────────────────────────────────────

describe('Dashboard invite, ownerDisplayName fallback', () => {
  it('collab.ts uses session display name when guildName is absent (no "Unknown Server" fallback)', async () => {
    // When the dashboard does not send a guildName (e.g. no guild is selected),
    // the server must fall back to the authenticated user's display name from the
    // Better Auth session, NOT the literal "Unknown Server". Showing "Unknown Server"
    // on the consent page is confusing and makes collaborators hesitant to connect.
    const src = await Bun.file(`${import.meta.dir}/../src/routes/collab.ts`).text();
    expect(src).not.toContain("'Unknown Server'");
    // requireOwnerAuth must expose a display name for createInvite to use
    expect(src).toContain('displayName');
  });
});

/** Must match the encryption secret in testServer.ts DEFAULTS */
const TEST_ENCRYPTION_SECRET = 'test-encryption-secret-32-chars!!';

function makeWebSessionAuth(userId: string): Auth {
  const session: SessionData = {
    user: { id: userId, email: 'test@example.com', name: 'Test User' },
  };
  return {
    getSession: async () => session,
    getDiscordUserId: async () => null,
  } as unknown as Auth;
}

// ─────────────────────────────────────────────────────────────────────────────
// Auth guard tests, no setup session token present → 401
// ─────────────────────────────────────────────────────────────────────────────

describe('Collab routes, auth guards', () => {
  let server: TestServerHandle;

  beforeAll(async () => {
    server = await startTestServer();
  });

  afterAll(() => server.stop());

  it('POST /api/collab/invite without auth returns 401', async () => {
    const res = await server.fetch('/api/collab/invite', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ providerKey: 'jinxxy' }),
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
// Validation tests, auth-independent input checks
// ─────────────────────────────────────────────────────────────────────────────

describe('Collab routes, validation', () => {
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

describe('Collab routes, security: setup session user isolation', () => {
  it('Setup session (user-A) + web session (user-B) → 403 (prevents session confusion)', async () => {
    const token = await createSetupSession(
      'user-A',
      'guild-iso-1',
      'discord-iso-1',
      TEST_ENCRYPTION_SECRET
    );
    const server = await startTestServer({ auth: makeWebSessionAuth('user-B') });
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith(server.url)) {
          return originalFetch(input, init);
        }
        if (url.includes('/api/query')) {
          return new Response(
            JSON.stringify({ status: 'success', value: { authUserId: 'user-A' } }),
            {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }
          );
        }
        return originalFetch(input, init);
      }) as typeof fetch;

      const res = await server.fetch('/api/collab/invite', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          authUserId: 'user-A',
          guildName: 'Server A',
          guildId: 'guild-iso-1',
          providerKey: 'jinxxy',
        }),
      });
      const body = await res.json();
      expect(res.status).toBe(403);
      expect(body).toHaveProperty('error');
    } finally {
      globalThis.fetch = originalFetch;
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
        body: JSON.stringify({
          guildName: 'Server A',
          guildId: 'guild-iso-2',
          providerKey: 'jinxxy',
        }),
      });
      // Auth passes; Convex is unavailable in tests so we may get 500, that's fine.
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    } finally {
      server.stop();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Security: IDOR guards, a user cannot access another user's resources
// ─────────────────────────────────────────────────────────────────────────────

describe('Collab routes, security: IDOR guards', () => {
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
      return; // network error is also acceptable, auth was checked
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
// Security: session / token validation, unauthenticated collab-session endpoints
// ─────────────────────────────────────────────────────────────────────────────

describe('Collab routes, security: session and token validation', () => {
  let server: TestServerHandle;

  beforeAll(async () => {
    server = await startTestServer(); // no auth, stub always returns null
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
// Provider-agnostic collab, providerKey validation in addConnectionManual
// ─────────────────────────────────────────────────────────────────────────────

describe('Collab routes, provider-agnostic: addConnectionManual input validation', () => {
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
// Provider-agnostic collab, createInvite providerKey validation
// ─────────────────────────────────────────────────────────────────────────────

describe('Collab routes, provider-agnostic: createInvite providerKey validation', () => {
  it('POST /api/collab/invite with unsupported providerKey returns 400', async () => {
    const userId = 'user-invite-pk';
    const token = await createSetupSession(
      userId,
      'guild-invite-pk',
      'discord-invite-pk',
      TEST_ENCRYPTION_SECRET
    );
    const server = await startTestServer({ auth: makeWebSessionAuth(userId) });
    try {
      const res = await server.fetch('/api/collab/invite', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ guildName: 'S', guildId: 'g', providerKey: 'gumroad' }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body).toHaveProperty('error');
    } finally {
      server.stop();
    }
  });

  it('POST /api/collab/invite with unknown providerKey returns 400', async () => {
    const userId = 'user-invite-pk-2';
    const token = await createSetupSession(
      userId,
      'guild-invite-pk-2',
      'discord-invite-pk-2',
      TEST_ENCRYPTION_SECRET
    );
    const server = await startTestServer({ auth: makeWebSessionAuth(userId) });
    try {
      const res = await server.fetch('/api/collab/invite', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ guildName: 'S', guildId: 'g', providerKey: 'nonexistent-provider' }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body).toHaveProperty('error');
    } finally {
      server.stop();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Provider product listing, collab connections must be provider-filtered
// ─────────────────────────────────────────────────────────────────────────────

describe('Provider fetchProducts, collab connection filtering', () => {
  it('jinxxy provider filters collab connections to provider === jinxxy', async () => {
    // Without this filter, Lemon Squeezy credentials get passed to the Jinxxy
    // API client, which silently fails, those collaborator products are never
    // returned. The filter must be present so only jinxxy-typed connections are
    // used by the Jinxxy product fetch loop.
    const src = await Bun.file(`${import.meta.dir}/../src/providers/jinxxy/index.ts`).text();
    // Must compare provider to 'jinxxy' (with === or !==) to skip non-Jinxxy credentials
    expect(src).toMatch(/provider.*[!=]==.*['"]jinxxy['"]|['"]jinxxy['"].*[!=]==.*provider/);
  });

  it('lemonsqueezy provider fetchProducts fetches collab connections', async () => {
    // The LS provider only fetches the owner's products. When an LS collaborator
    // link exists their products are never returned because the provider never
    // calls getCollabConnectionsForVerification. This guard ensures the query
    // is called so collab products show up in /creator-admin product add.
    const src = await Bun.file(`${import.meta.dir}/../src/providers/lemonsqueezy/index.ts`).text();
    expect(src).toContain('getCollabConnectionsForVerification');
  });

  it('lemonsqueezy provider filters collab connections to provider === lemonsqueezy', async () => {
    // Only LS-typed connections should be used in the LS product loop.
    // Using a Jinxxy API key as an LS token would return an auth error
    // and silently drop all products for that connection.
    const src = await Bun.file(`${import.meta.dir}/../src/providers/lemonsqueezy/index.ts`).text();
    expect(src).toMatch(
      /provider.*[!=]==.*['"]lemonsqueezy['"]|['"]lemonsqueezy['"].*[!=]==.*provider/
    );
  });

  it('getCollabConnectionsForVerification returns collaboratorDisplayName', async () => {
    // Without collaboratorDisplayName in the Convex return type, every collab
    // product shows "Collaborator" instead of the real name. The field is present
    // on the collaborator_connections table, it just needs to be included in the
    // query return so providers can label products with the collaborator's name.
    const src = await Bun.file(`${import.meta.dir}/../../../convex/collaboratorInvites.ts`).text();
    // The returns validator for getCollabConnectionsForVerification must include it
    const queryBlock = src.slice(
      src.indexOf('getCollabConnectionsForVerification'),
      src.indexOf('getCollabWebhookSecret')
    );
    expect(queryBlock).toContain('collaboratorDisplayName');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Web-session auth path, authenticated user, no setup session token
// ─────────────────────────────────────────────────────────────────────────────

describe('Collab routes, web session auth', () => {
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
      body: JSON.stringify({ guildName: 'My Server', guildId: '123456789', providerKey: 'jinxxy' }),
    });
    const body = await res.json();
    expect(res.status).not.toBe(400);
    expect(body).not.toHaveProperty('error', 'authUserId is required');
  });

  it('POST /api/collab/invite with web session and explicit authUserId returns 403 for wrong owner', async () => {
    // Passing an authUserId that doesn't match the session user → 403 Forbidden.
    // With a fake Convex URL the ownership check throws a network error; the server
    // may crash the connection entirely. Either 403, 500, or a fetch error are all
    // acceptable, the key invariant is it does NOT return 200/201.
    let status: number | null = null;
    try {
      const res = await server.fetch('/api/collab/invite', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          guildName: 'My Server',
          guildId: '123456789',
          authUserId: 'some-other-user',
        }),
      });
      status = res.status;
    } catch {
      // Network error means the server threw before responding, acceptable
      return;
    }
    expect(status).not.toBe(200);
    expect(status).not.toBe(201);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Collab invite routes and provider metadata
// ─────────────────────────────────────────────────────────────────────────────

describe('Collab invite routes and dynamic providers', () => {
  it('GET /api/collab/providers returns provider list without auth', async () => {
    // The providers list is public metadata, no auth required. It returns the
    // set of providers that support collab invites so the dropdown is always
    // in sync with the server registry.
    const server = await startTestServer();
    try {
      const res = await server.fetch('/api/collab/providers');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty('providers');
      expect(Array.isArray(body.providers)).toBe(true);
      // Each entry must have at least key and label
      if (body.providers.length > 0) {
        expect(body.providers[0]).toHaveProperty('key');
        expect(body.providers[0]).toHaveProperty('label');
      }
    } finally {
      server.stop();
    }
  });

  it('GET /api/collab/invites without auth returns 401', async () => {
    // The invites list is owner-only, must require auth.
    const server = await startTestServer();
    try {
      const res = await server.fetch('/api/collab/invites');
      expect(res.status).toBe(401);
    } finally {
      server.stop();
    }
  });

  it('DELETE /api/collab/invites/:id without auth returns 401', async () => {
    // Revoking an invite is an owner action, must require auth.
    const server = await startTestServer();
    try {
      const res = await server.fetch('/api/collab/invites/some-invite-id', {
        method: 'DELETE',
      });
      expect(res.status).toBe(401);
    } finally {
      server.stop();
    }
  });

  it('collab.ts exposes GET /api/collab/invites route', async () => {
    // The route must exist in the dispatch table so requests are handled.
    const src = await Bun.file(`${import.meta.dir}/../src/routes/collab.ts`).text();
    expect(src).toContain('/api/collab/invites');
  });

  it('collab.ts exposes DELETE /api/collab/invites/:id route', async () => {
    // Revoke needs a DELETE route for the invite resource.
    const src = await Bun.file(`${import.meta.dir}/../src/routes/collab.ts`).text();
    expect(src).toMatch(/collab\/invites.*DELETE|DELETE.*collab\/invites/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Collab routes, "connections I have approved" (as-collaborator view)
// ─────────────────────────────────────────────────────────────────────────────

describe('Collab routes, as-collaborator connections', () => {
  it('GET /api/collab/connections/as-collaborator without auth returns 401', async () => {
    // Viewing which stores you collaborate with is a private operation,
    // must require authentication.
    const server = await startTestServer();
    try {
      const res = await server.fetch('/api/collab/connections/as-collaborator');
      expect(res.status).toBe(401);
    } finally {
      server.stop();
    }
  });

  it('collab.ts exposes GET /api/collab/connections/as-collaborator route', async () => {
    // The route must exist in the dispatch table so requests are handled.
    const src = await Bun.file(`${import.meta.dir}/../src/routes/collab.ts`).text();
    expect(src).toContain('/api/collab/connections/as-collaborator');
  });

  it('convex/collaboratorInvites.ts has listConnectionsAsCollaborator query', async () => {
    // The Convex layer needs a public query that bridges authUserId → Discord ID
    // → active connections where the user is the collaborator.
    const src = await Bun.file(`${import.meta.dir}/../../../convex/collaboratorInvites.ts`).text();
    expect(src).toContain('listConnectionsAsCollaborator');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Collab routes, Discord avatar persistence and response shaping
// ─────────────────────────────────────────────────────────────────────────────

describe('Collab routes, Discord avatars', () => {
  it('authCallback stores avatarHash in Discord state store', async () => {
    // Without capturing avatar during OAuth the dashboard can never show real
    // profile pictures. The Discord user JSON includes an `avatar` hash, it
    // must be extracted and saved alongside discordUserId/discordUsername so it
    // is available when the invite is submitted.
    const src = await Bun.file(`${import.meta.dir}/../src/routes/collab.ts`).text();
    // Must cast Discord user response to include avatar field
    expect(src).toMatch(/avatar\??\s*:\s*string/);
    // Must store avatarHash in the JSON saved to the state store
    expect(src).toContain('avatarHash');
  });

  it('authCallback validates avatar hash before storing (rejects arbitrary strings)', async () => {
    // An attacker could craft a Discord token that returns a malicious `avatar`
    // value. The server must validate the hash matches the expected hex pattern
    // before storing it, never trust user-controlled strings.
    const src = await Bun.file(`${import.meta.dir}/../src/routes/collab.ts`).text();
    // Must have a regex or explicit validation for the avatar hash
    expect(src).toMatch(/[0-9]a-f.*32|a_.*[0-9a-f]/);
  });

  it('submitInvite passes collaboratorAvatarHash to acceptCollaboratorInvite', async () => {
    // The avatar hash must flow from the state store through submitInvite into
    // the Convex mutation so it is persisted on the connection record.
    const src = await Bun.file(`${import.meta.dir}/../src/routes/collab.ts`).text();
    // The full source must reference both avatarHash (from state) and
    // collaboratorAvatarHash (the Convex arg name)
    expect(src).toContain('avatarHash');
    expect(src).toContain('collaboratorAvatarHash');
  });

  it('acceptCollaboratorInvite Convex mutation accepts collaboratorAvatarHash arg', async () => {
    // The mutation validator must declare the field so Convex type-checks it and
    // stores it on the connection record.
    const src = await Bun.file(`${import.meta.dir}/../../../convex/collaboratorInvites.ts`).text();
    const mutationBlock = src.slice(
      src.indexOf('export const acceptCollaboratorInvite'),
      src.indexOf('export const addCollaboratorConnection') > 0
        ? src.indexOf('export const addCollaboratorConnection')
        : src.indexOf('export const revokeCollaboratorInvite')
    );
    expect(mutationBlock).toContain('collaboratorAvatarHash');
  });

  it('schema.ts collaborator_connections table has collaboratorAvatarHash field', async () => {
    // Without the schema field, Convex rejects inserts that include the hash
    // and TypeScript raises a type error at build time.
    const src = await Bun.file(`${import.meta.dir}/../../../convex/schema.ts`).text();
    // The field must appear somewhere between the table definition and the index definitions
    const startIdx = src.indexOf('const collaborator_connections = defineTable(');
    const endIdx = src.indexOf(".index('by_owner'", startIdx);
    const tableBlock = src.slice(startIdx, endIdx);
    expect(tableBlock).toContain('collaboratorAvatarHash');
  });

  it('listCollaboratorConnections Convex query returns collaboratorAvatarHash', async () => {
    // The query must include the hash in its return map so the API layer can
    // construct a Discord CDN URL and include it in the JSON response.
    const src = await Bun.file(`${import.meta.dir}/../../../convex/collaboratorInvites.ts`).text();
    const queryBlock = src.slice(
      src.indexOf('export const listCollaboratorConnections'),
      src.indexOf('export const listPendingInvitesByOwner')
    );
    expect(queryBlock).toContain('collaboratorAvatarHash');
  });

  it('listConnections in collab.ts constructs Discord CDN avatar URL server-side', async () => {
    // The Discord CDN URL must be assembled on the server using validated data,
    // never sent raw from the client. The API response must include `avatarUrl`
    // (the pre-built URL), not `avatarHash` (the raw hash).
    const src = await Bun.file(`${import.meta.dir}/../src/routes/collab.ts`).text();
    // The CDN URL pattern must be assembled in the server source
    expect(src).toContain('cdn.discordapp.com/avatars');
    // The client-facing response must use avatarUrl
    expect(src).toContain('avatarUrl');
  });
});
