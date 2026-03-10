/**
 * YUCP Certificate Authority — HTTP routes (Convex HTTP router).
 *
 * Public API routes follow Spotify/GitHub/Stripe conventions: versioned (/v1/),
 * noun-based resources, and /v1/me for the authenticated current user.
 *
 * Public API (Authorization: Bearer <oauth_access_token>):
 *
 *   GET  /v1/me
 *        Returns the authenticated creator's profile (sub, name, email).
 *        Like Spotify GET /v1/me — token identifies "me".
 *
 *   POST /v1/certificates
 *        Issue a signing certificate for the authenticated creator.
 *        Scope: cert:issue   Audience: yucp-public-api
 *        Body: { devPublicKey (base64 Ed25519), publisherName }
 *        Returns: { success, certificate: CertEnvelope }
 *
 *   GET  /v1/packages/:hash
 *        Consumer verification: look up a package by its content SHA-256.
 *        Returns { known, status, publisherId, packageId, certData?, ownershipConflict, ... }
 *
 *   POST /v1/signatures
 *        Transparency log: register a signed package manifest (Layer 2).
 *        Auth: Authorization: Bearer <base64(JSON cert envelope)>
 *        Body: { packageId, contentHash, packageVersion? }
 *
 * Admin routes (Authorization: Bearer <CONVEX_API_SECRET>):
 *
 *   POST /v1/certificates/revoke
 *        Revoke a certificate by nonce.
 *        Body: { certNonce, reason }
 *
 * OAuth infrastructure (not public API — these are part of the PKCE flow):
 *   GET  /api/yucp/oauth/authorize  — loopback port proxy (RFC 8252)
 *   GET  /api/yucp/oauth/callback   — restores original loopback port
 *
 * References:
 *   PKCE flow          https://www.rfc-editor.org/rfc/rfc7636
 *   RFC 9700 best prac https://www.ietf.org/rfc/rfc9700.html
 *   Sigstore design    https://docs.sigstore.dev/about/overview/
 *   Spotify /v1/me     https://developer.spotify.com/documentation/web-api/reference/get-current-users-profile
 */

import { httpRouter } from 'convex/server';
import { httpAction } from './_generated/server';
import { internal, api, components } from './_generated/api';
import { authComponent, createAuth } from './auth';
import {
  verifyCertEnvelope,
  getPublicKeyFromPrivate,
  base64ToBytes,
  type CertEnvelope,
} from './lib/yucpCrypto';

const http = httpRouter();

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorResponse(message: string, status: number): Response {
  return jsonResponse({ error: message }, status);
}

/** Parse and verify a cert envelope from "Authorization: Bearer <base64>" */
async function parseBearerCert(
  request: Request,
  rootPublicKey: string,
): Promise<{ ok: true; envelope: CertEnvelope } | { ok: false; error: string }> {
  const auth = request.headers.get('Authorization');
  if (!auth?.startsWith('Bearer ')) return { ok: false, error: 'Missing Authorization header' };

  let envelope: CertEnvelope;
  try {
    envelope = JSON.parse(atob(auth.slice(7))) as CertEnvelope;
  } catch {
    return { ok: false, error: 'Invalid cert envelope encoding' };
  }

  const valid = await verifyCertEnvelope(envelope, rootPublicKey);
  if (!valid) return { ok: false, error: 'Cert signature verification failed' };

  const now = Date.now();
  const expiresAt = new Date(envelope.cert.expiresAt).getTime();
  if (expiresAt < now) return { ok: false, error: 'Certificate expired' };

  return { ok: true, envelope };
}

/**
 * Verify a YUCP OAuth Bearer access token and return the authenticated user ID
 * plus any profile claims embedded in the token (name, email).
 *
 * The token is a JWT issued by Better Auth's oauth-provider plugin.
 * Profile claims (name, email) are embedded via customAccessTokenClaims so
 * that callers never need a secondary DB lookup — the token is the source of truth.
 *
 * Reference: https://www.rfc-editor.org/rfc/rfc9700.html (OAuth 2.0 Security BCP)
 */
async function verifyOAuthToken(
  token: string,
  siteUrl: string,
): Promise<{ ok: true; yucpUserId: string; name: string | null; email: string | null } | { ok: false; error: string }> {
  try {
    const { verifyAccessToken } = await import('better-auth/oauth2');
    const authBase = `${siteUrl.replace(/\/$/, '')}/api/auth`;

    // Detect token type for diagnostics: JWTs are 3 dot-separated base64 segments
    const isJwtShape = (token.match(/\./g) ?? []).length === 2;
    console.log('[verifyOAuthToken] token_type=' + (isJwtShape ? 'jwt' : 'opaque')
      + ' length=' + token.length
      + ' issuer=' + authBase);

    const verified = await verifyAccessToken(token, {
      verifyOptions: {
        issuer: authBase,
        audience: 'yucp-public-api',
      },
      jwksUrl: `${authBase}/jwks`,
    });

    // Require cert:issue scope (or verification:read as fallback for legacy tokens)
    const claims = verified as Record<string, unknown>;
    const scope: string = (claims.scope as string) ?? '';
    const scopes = scope.split(' ');
    console.log('[verifyOAuthToken] verified ok, scopes=' + scope);
    if (!scopes.includes('cert:issue') && !scopes.includes('verification:read')) {
      return { ok: false, error: 'Token missing required scope: cert:issue' };
    }

    // Better Auth puts the user ID in auth_user_id (custom claim) and sub
    const userId = (claims.auth_user_id as string) ?? (claims.sub as string);
    if (!userId) return { ok: false, error: 'No user identity in token' };

    // Read stable profile claims embedded by customAccessTokenClaims on the server.
    // This avoids a DB lookup — the JWT is the source of truth for name/email.
    const name = (claims.name as string) ?? null;
    const email = (claims.email as string) ?? null;

    return { ok: true, yucpUserId: userId, name, email };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Token verification failed';
    const errName = err instanceof Error ? err.name : 'unknown';
    console.log('[verifyOAuthToken] FAILED err=' + errName + ' msg=' + msg);
    return { ok: false, error: msg };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// RFC 8252 loopback proxy — wildcard port support for Unity Editor OAuth
//
// Better Auth's oauthProvider does not yet support wildcard loopback ports
// (https://github.com/better-auth/better-auth/issues/8426). This proxy:
//   1. Accepts redirect_uri=http://127.0.0.1:PORT/callback (any ephemeral port)
//   2. Stores {state → originalRedirectUri} server-side (10-min TTL)
//   3. Forwards to Better Auth with redirect_uri normalised to our fixed callback
//   4. On callback, looks up stored URI and redirects to the original port
//
// Unity sends to:  GET /api/yucp/oauth/authorize  (not /api/auth/oauth2/authorize)
// After auth:      GET /api/yucp/oauth/callback   (receives code, restores port)
// ─────────────────────────────────────────────────────────────────────────────

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const SESSION_TTL_MS = 10 * 60 * 1000; // 10 minutes

function isLoopback(uri: string): boolean {
  try { return LOOPBACK_HOSTS.has(new URL(uri).hostname); } catch { return false; }
}

http.route({
  method: 'GET',
  path: '/api/yucp/oauth/authorize',
  handler: httpAction(async (ctx, request) => {
    const siteUrl = process.env.CONVEX_SITE_URL?.replace(/\/$/, '');
    if (!siteUrl) return errorResponse('Service not configured', 503);

    const incoming = new URL(request.url);
    const redirectUri = incoming.searchParams.get('redirect_uri');
    const state = incoming.searchParams.get('state');

    if (!redirectUri || !state) {
      return errorResponse('redirect_uri and state are required', 400);
    }

    if (!isLoopback(redirectUri)) {
      // Non-loopback clients go directly — no port proxy needed
      incoming.pathname = '/api/auth/oauth2/authorize';
      return Response.redirect(incoming.toString(), 302);
    }

    // Store the original loopback URI server-side keyed by state
    await ctx.runMutation(internal.oauthLoopback.storeSession, {
      oauthState: state,
      originalRedirectUri: redirectUri,
    });

    // Replace redirect_uri with our fixed callback endpoint
    incoming.pathname = '/api/auth/oauth2/authorize';
    incoming.searchParams.set('redirect_uri', `${siteUrl}/api/yucp/oauth/callback`);
    return Response.redirect(incoming.toString(), 302);
  }),
});

http.route({
  method: 'GET',
  path: '/api/yucp/oauth/callback',
  handler: httpAction(async (ctx, request) => {
    const url = new URL(request.url);
    const state = url.searchParams.get('state');
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');

    if (!state) return errorResponse('Missing state parameter', 400);

    // Look up the original loopback redirect URI
    const session = await ctx.runQuery(internal.oauthLoopback.getSession, {
      oauthState: state,
    });

    if (!session) {
      return new Response(
        '<html><body><p>OAuth session expired or not found. Please try again in Unity.</p></body></html>',
        { status: 400, headers: { 'Content-Type': 'text/html' } },
      );
    }

    // Clean up the session record
    await ctx.runMutation(internal.oauthLoopback.deleteSession, { oauthState: state });

    // Build the redirect back to the Unity local server
    const target = new URL(session.originalRedirectUri);
    if (code) target.searchParams.set('code', code);
    if (state) target.searchParams.set('state', state);
    if (error) target.searchParams.set('error', error);

    const errorDesc = url.searchParams.get('error_description');
    if (errorDesc) target.searchParams.set('error_description', errorDesc);

    return Response.redirect(target.toString(), 302);
  }),
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /v1/me — Current authenticated creator (like Spotify GET /v1/me)
//
// Validates the Bearer token, then fetches fresh user data from DB using the
// `sub` claim (which is the user's stable primary key in Better Auth).
// Pattern: validate → extract sub → db.get(sub) → return {sub, name, email}
// ─────────────────────────────────────────────────────────────────────────────

http.route({
  method: 'GET',
  path: '/v1/me',
  handler: httpAction(async (ctx, request) => {
    const siteUrl = process.env.CONVEX_SITE_URL;
    if (!siteUrl) return errorResponse('Service not configured', 503);

    const authHeader = request.headers.get('Authorization');
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) return errorResponse('Authorization: Bearer <access_token> required', 401);

    const tokenResult = await verifyOAuthToken(token, siteUrl);
    if (!tokenResult.ok) return errorResponse(tokenResult.error, 401);

    // Look up fresh user data from Better Auth's user table.
    // sub = the user's stable primary key (_id in the betterAuth component).
    const user = await ctx.runQuery(components.betterAuth.adapter.findOne, {
      model: 'user',
      where: [{ field: 'id', value: tokenResult.yucpUserId }],
      select: ['id', 'name', 'email'],
    }) as { id?: string; name?: string; email?: string } | null;

    if (!user) return errorResponse('User not found', 404);

    return jsonResponse({
      sub: tokenResult.yucpUserId,
      name: user.name ?? tokenResult.name,
      email: user.email ?? tokenResult.email,
    });
  }),
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /v1/certificates — Issue cert via YUCP OAuth token (was /api/yucp/certificates/issue)
// ─────────────────────────────────────────────────────────────────────────────

http.route({
  method: 'POST',
  path: '/v1/certificates',
  handler: httpAction(async (ctx, request) => {
    const siteUrl = process.env.CONVEX_SITE_URL;
    if (!siteUrl) return errorResponse('Service not configured', 503);

    // Verify YUCP OAuth access token (issued via PKCE flow from Unity Editor)
    const authHeader = request.headers.get('Authorization');
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) return errorResponse('Authorization: Bearer <access_token> required', 401);

    const tokenResult = await verifyOAuthToken(token, siteUrl);
    if (!tokenResult.ok) return errorResponse(tokenResult.error, 401);
    const { yucpUserId } = tokenResult;

    // Look up the user's subject to get their Discord ID (secondary identity anchor)
    const subjectResult = await ctx.runQuery(api.subjects.getSubjectByAuthId, { authUserId: yucpUserId });
    const discordUserId = subjectResult?.found ? subjectResult.subject.primaryDiscordUserId : undefined;

    // Parse request body
    let body: { devPublicKey: string; publisherName: string };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return errorResponse('Invalid JSON body', 400);
    }
    console.log('[cert/issue] body keys=' + Object.keys(body ?? {}).join(',')
      + ' devPublicKey_len=' + (body?.devPublicKey?.length ?? 'null')
      + ' publisherName=' + (body?.publisherName ?? 'null'));
    if (!body.devPublicKey || !body.publisherName) {
      return errorResponse('devPublicKey and publisherName are required', 400);
    }

    // Validate devPublicKey is a 32-byte Ed25519 key
    try {
      const keyBytes = base64ToBytes(body.devPublicKey);
      if (keyBytes.length !== 32) throw new Error('wrong length');
    } catch {
      return errorResponse('devPublicKey must be a base64-encoded 32-byte Ed25519 public key', 400);
    }

    // Issue certificate anchored to YUCP user identity
    let envelope: CertEnvelope;
    try {
      envelope = (await ctx.runAction(internal.yucpCertificates.issueCertificate, {
        publisherName: body.publisherName,
        devPublicKey: body.devPublicKey,
        yucpUserId,
        discordUserId,
      })) as CertEnvelope;
    } catch (err) {
      const raw = err instanceof Error ? err.message : '';
      // Sanitize Convex-wrapped errors — never expose stack traces or internal paths.
      // Map known failure modes to appropriate HTTP status codes.
      if (raw.includes('not configured') || raw.includes('not set')) {
        return errorResponse('Certificate service is not available', 503);
      }
      if (raw.includes('Rate limit')) {
        return errorResponse(raw.replace(/Uncaught Error: /g, '').split('\n')[0], 429);
      }
      if (raw.includes('already has an active certificate')) {
        return errorResponse('An active certificate already exists for this key', 409);
      }
      return errorResponse('Certificate issuance failed', 500);
    }

    return jsonResponse({ success: true, certificate: envelope });
  }),
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /v1/packages/:hash — Consumer verification (was /api/yucp/packages/by-hash/:hash)
// ─────────────────────────────────────────────────────────────────────────────

http.route({
  method: 'GET',
  pathPrefix: '/v1/packages/',
  handler: httpAction(async (ctx, request) => {
    const url = new URL(request.url);
    const hash = url.pathname.replace('/v1/packages/', '').split('?')[0];
    if (!hash) return errorResponse('Missing content hash', 400);

    const logEntries = await ctx.runQuery(internal.signingLog.getEntriesByContentHash, {
      contentHash: hash,
    });

    if (logEntries.length === 0) {
      return jsonResponse({ known: false });
    }

    const entry = logEntries[0];
    const { publisherId, packageId, yucpUserId: signingYucpUserId } = entry;

    const cert = await ctx.runQuery(internal.yucpCertificates.getCertByPublisherId, {
      publisherId,
    });

    const registration = await ctx.runQuery(internal.packageRegistry.getRegistration, {
      packageId,
    });

    const ownershipConflict =
      registration !== null && registration.yucpUserId !== signingYucpUserId;

    return jsonResponse({
      known: true,
      status: cert?.status ?? 'unknown',
      publisherId,
      packageId,
      revocationReason: cert?.revocationReason,
      ownershipConflict,
      registeredOwnerYucpUserId: registration?.yucpUserId,
      signingYucpUserId,
      certData: cert ? (JSON.parse(cert.certData) as CertEnvelope) : undefined,
    });
  }),
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /v1/signatures — Register in transparency log (was /api/yucp/sign-manifest)
// ─────────────────────────────────────────────────────────────────────────────

http.route({
  method: 'POST',
  path: '/v1/signatures',
  handler: httpAction(async (ctx, request) => {
    const rootPrivateKey = process.env.YUCP_ROOT_PRIVATE_KEY;
    if (!rootPrivateKey) return errorResponse('Service not configured', 503);

    const rootPublicKey = getPublicKeyFromPrivate(rootPrivateKey);

    const certResult = await parseBearerCert(request, rootPublicKey);
    if (!certResult.ok) return errorResponse(certResult.error, 401);
    const { envelope } = certResult;

    let body: { packageId: string; contentHash: string; packageVersion?: string };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return errorResponse('Invalid JSON body', 400);
    }
    if (!body.packageId || !body.contentHash) {
      return errorResponse('packageId and contentHash are required', 400);
    }

    const { publisherId, yucpUserId } = envelope.cert;

    // Layer 1: enforce package namespace ownership
    const regResult = await ctx.runMutation(internal.packageRegistry.registerPackage, {
      packageId: body.packageId,
      publisherId,
      yucpUserId,
    });

    if (!regResult.registered && regResult.conflict) {
      return jsonResponse(
        {
          error: 'PACKAGE_OWNERSHIP_CONFLICT',
          message: `Package "${body.packageId}" is owned by a different YUCP account`,
          registeredOwnerYucpUserId: regResult.ownedBy,
        },
        409,
      );
    }

    // Layer 2: append to transparency log
    const logResult = await ctx.runMutation(internal.signingLog.writeEntry, {
      contentHash: body.contentHash,
      packageId: body.packageId,
      publisherId,
      yucpUserId,
      certNonce: envelope.cert.nonce,
      packageVersion: body.packageVersion,
    });

    if (!logResult.written && logResult.conflict) {
      return jsonResponse(
        {
          error: 'IDENTITY_CONFLICT',
          message: 'This package content was previously signed by a different YUCP identity',
          existingYucpUserId: logResult.existingYucpUserId,
        },
        409,
      );
    }

    return jsonResponse({
      success: true,
      packageId: body.packageId,
      publisherId,
    });
  }),
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /v1/certificates/revoke — Admin revocation (was /api/yucp/certificates/revoke)
// ─────────────────────────────────────────────────────────────────────────────

http.route({
  method: 'POST',
  path: '/v1/certificates/revoke',
  handler: httpAction(async (ctx, request) => {
    const apiSecret = process.env.CONVEX_API_SECRET;
    const auth = request.headers.get('Authorization');
    if (!apiSecret || auth !== `Bearer ${apiSecret}`) {
      return errorResponse('Unauthorized', 401);
    }

    let body: { certNonce: string; reason: string };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return errorResponse('Invalid JSON body', 400);
    }
    if (!body.certNonce || !body.reason) {
      return errorResponse('certNonce and reason are required', 400);
    }

    const result = await ctx.runMutation(internal.yucpCertificates.revokeCertByNonce, {
      certNonce: body.certNonce,
      reason: body.reason,
    });

    return jsonResponse(result);
  }),
});

// Better Auth routes must be registered last
authComponent.registerRoutes(http, createAuth, { cors: true });

export default http;
