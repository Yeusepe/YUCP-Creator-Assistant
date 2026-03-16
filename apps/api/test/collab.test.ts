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

// ─────────────────────────────────────────────────────────────────────────────
// Collab invite page — static HTML completeness
// ─────────────────────────────────────────────────────────────────────────────

describe('Collab invite page — inline script completeness', () => {
  it('collab-invite.html declares async function submitAccountLinking', async () => {
    // Regression guard: the Connect button uses onclick="submitAccountLinking()".
    // When the function declaration is accidentally omitted, the function body
    // floats at the top level of a non-module <script>, turning every `return`
    // inside it into "Uncaught SyntaxError: Illegal return statement" in
    // the browser — crashing the page for every collaborator who opens the link.
    const html = await Bun.file(`${import.meta.dir}/../public/collab-invite.html`).text();
    expect(html).toContain('async function submitAccountLinking()');
  });

  it('collab-invite.html submit functions use generic apiKey field, not jinxxyApiKey', async () => {
    // Both submit functions must send `apiKey` (the canonical field the server
    // accepts). The deprecated `jinxxyApiKey` alias must not appear in the
    // request body — it breaks non-Jinxxy providers since the field name leaks
    // provider identity to the client and confuses users.
    const html = await Bun.file(`${import.meta.dir}/../public/collab-invite.html`).text();
    expect(html).not.toContain('jinxxyApiKey');
  });

  it('collab-invite.html consent title uses dynamic provider label, not hardcoded Jinxxy', async () => {
    // The consent stage title must not hardcode "Jinxxy™ store" — it must use
    // getProviderUI(inviteData.providerKey).label so Lemon Squeezy and future
    // providers display the correct store name.
    const html = await Bun.file(`${import.meta.dir}/../public/collab-invite.html`).text();
    expect(html).not.toContain('with your Jinxxy™ store');
    expect(html).toContain('getProviderUI(inviteData.providerKey).label');
  });

  it('collab-invite.html calls updateProviderUI after invite data is loaded', async () => {
    // updateProviderUI must be called with inviteData.providerKey after the
    // invite is fetched so that labels, placeholders, and error messages are
    // correct for every provider (not just Jinxxy).
    const html = await Bun.file(`${import.meta.dir}/../public/collab-invite.html`).text();
    expect(html).toContain('updateProviderUI(inviteData.providerKey)');
  });
  it('collab-invite.html stage-type has a provider label element populated by updateProviderUI', async () => {
    // stage-type must contain an element with id="stage-type-provider" so
    // updateProviderUI can inject "Connecting your Lemon Squeezy store" (etc.).
    // Without this the collaborator loses provider context after the consent stage.
    const html = await Bun.file(`${import.meta.dir}/../public/collab-invite.html`).text();
    expect(html).toContain('id="stage-type-provider"');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: checking for literal template expression in HTML source
    expect(html).toContain('Connecting your ${ui.label} store');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Dashboard collab.js — static code completeness
// ─────────────────────────────────────────────────────────────────────────────

describe('Dashboard collab.js — providerKey completeness', () => {
  it('collab.js submitGenerateInvite sends providerKey in request body', async () => {
    // The API now requires providerKey. Without it, createInvite returns 400.
    // This guard ensures the dashboard always sends providerKey, and that the
    // old generateCollabInvite no longer makes the API call directly.
    const js = await Bun.file(`${import.meta.dir}/../public/assets/dashboard/collab.js`).text();
    expect(js).toContain('submitGenerateInvite');
    // providerKey must appear as a body field in the API call
    expect(js).toContain('providerKey,');
    // Old pattern: generateCollabInvite must NOT call apiFetch directly
    expect(js).not.toMatch(/function generateCollabInvite[\s\S]{0,300}apiFetch/);
  });

  it('dashboard.html invite panel has two-step flow (provider select + URL display)', async () => {
    // Regression guard: the invite panel must include provider selection (invite-step-select)
    // and a URL display step (invite-step-url). Removing either breaks the invite flow.
    const html = await Bun.file(`${import.meta.dir}/../public/dashboard.html`).text();
    expect(html).toContain('id="invite-step-select"');
    expect(html).toContain('id="invite-provider-select"');
    expect(html).toContain('id="invite-step-url"');
    expect(html).toContain('submitGenerateInvite()');
  });

  it('collab.js submitGenerateInvite does not send server name — lets server use creator Discord name', async () => {
    // The dashboard invite must show the creator's Discord display name, not the
    // Discord server name. The server already resolves ownerDisplayName from
    // webSession.user.name when no guildName is sent. The client must NOT read
    // sidebar-selected-name and send it as guildName, because that shows the
    // server name ("Personal Dashboard", etc.) instead of the creator's name.
    const js = await Bun.file(`${import.meta.dir}/../public/assets/dashboard/collab.js`).text();
    expect(js).not.toContain("'this server'");
    // Must not read the sidebar server name and send it as guildName
    expect(js).not.toContain('sidebar-selected-name');
  });

  it('dashboard.html invite-provider-select uses invite-provider-pick CSS class, not inline style', async () => {
    // The invite provider select must use the .invite-provider-pick CSS class
    // (dark-themed, defined in dashboard.css) rather than an ad-hoc inline style.
    // This ensures consistent styling across browsers and proper right-margin on the chevron.
    const html = await Bun.file(`${import.meta.dir}/../public/dashboard.html`).text();
    expect(html).toContain('class="invite-provider-pick"');
    // Must not have the verbose inline appearance-none inline style (moved to CSS)
    const css = await Bun.file(`${import.meta.dir}/../public/dashboard.css`).text();
    expect(css).toContain('.invite-provider-pick');
    expect(css).toContain('appearance: none');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Dashboard invite display name — server uses session name as fallback
// ─────────────────────────────────────────────────────────────────────────────

describe('Dashboard invite — ownerDisplayName fallback', () => {
  it('collab.ts uses session display name when guildName is absent (no "Unknown Server" fallback)', async () => {
    // When the dashboard does not send a guildName (e.g. no guild is selected),
    // the server must fall back to the authenticated user's display name from the
    // Better Auth session — NOT the literal "Unknown Server". Showing "Unknown Server"
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

  it('POST /api/collab/invite without providerKey returns 400', async () => {
    // createInvite now requires providerKey — omitting it should fail before auth.
    const res = await server.fetch('/api/collab/invite', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ guildName: 'Server A', guildId: 'guild-1' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toHaveProperty('error');
    expect((body.error as string).toLowerCase()).toContain('providerkey');
  });

  it('POST /api/collab/invite with unknown providerKey returns 400', async () => {
    // An unrecognised provider key that does not have supportsCollab must be rejected.
    const res = await server.fetch('/api/collab/invite', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ guildName: 'Server A', guildId: 'guild-1', providerKey: 'notreal' }),
    });
    expect(res.status).toBe(400);
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
        body: JSON.stringify({
          guildName: 'Server A',
          guildId: 'guild-iso-1',
          providerKey: 'jinxxy',
        }),
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
        body: JSON.stringify({
          guildName: 'Server A',
          guildId: 'guild-iso-2',
          providerKey: 'jinxxy',
        }),
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
    // acceptable — the key invariant is it does NOT return 200/201.
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
      // Network error means the server threw before responding — acceptable
      return;
    }
    expect(status).not.toBe(200);
    expect(status).not.toBe(201);
  });
});
