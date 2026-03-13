/**
 * YUCP Certificate Authority, HTTP routes (Convex HTTP router).
 *
 * Public API routes follow Spotify/GitHub/Stripe conventions: versioned (/v1/),
 * noun-based resources, and /v1/me for the authenticated current user.
 *
 * Public API (Authorization: Bearer <oauth_access_token>):
 *
 *   GET  /v1/keys
 *        CA trust anchor, returns the root public key as a JWK Set (no auth).
 *        Clients fetch this once and cache it; eliminates hardcoded keys.
 *
 *   GET  /v1/me
 *        Returns the authenticated creator's profile (sub, name, email).
 *        Like Spotify GET /v1/me, token identifies "me".
 *
 *   GET  /v1/products
 *        List the authenticated creator's registered products (all providers).
 *        Used by the Unity PackageSigning editor to populate Gumroad/Jinxxy pickers.
 *        Returns: { products: [{ productId, provider, providerProductRef, displayName }] }
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
 * OAuth infrastructure (not public API, these are part of the PKCE flow):
 *   GET  /api/yucp/oauth/authorize , loopback port proxy (RFC 8252)
 *   GET  /api/yucp/oauth/callback  , restores original loopback port
 *
 * References:
 *   PKCE flow          https://www.rfc-editor.org/rfc/rfc7636
 *   RFC 9700 best prac https://www.ietf.org/rfc/rfc9700.html
 *   Sigstore design    https://docs.sigstore.dev/about/overview/
 *   Spotify /v1/me     https://developer.spotify.com/documentation/web-api/reference/get-current-users-profile
 */

import { httpRouter } from 'convex/server';
import { PROVIDER_REGISTRY, PROVIDER_REGISTRY_BY_KEY } from '../packages/shared/src/providers';
import { api, components, internal } from './_generated/api';
import { httpAction } from './_generated/server';
import { authComponent, createAuth } from './auth';
import { constantTimeEqual, decryptForPurpose } from './lib/vrchat/crypto';
import {
  base64ToBytes,
  type CertEnvelope,
  getPublicKeyFromPrivate,
  type LicenseClaims,
  signLicenseJwt,
  verifyCertEnvelope,
} from './lib/yucpCrypto';

/**
 * Public API routes follow Spotify/GitHub/Stripe conventions.
 *
 *   POST /v1/licenses/verify
 *        Verify a Gumroad or Jinxxy purchase license for a YUCP package.
 *        No auth header, license key is the credential.
 *        Body: { packageId, licenseKey, provider, productPermalink,
 *                machineFingerprint, nonce, timestamp }
 *
 *   POST /v1/licenses/verify-discord
 *        Verify entitlement via Discord role (buyer must have verified with creator's bot).
 *        Requires Bearer OAuth token to identify the buyer's YUCP account.
 *        Body: { packageId, creatorAuthUserId, productId,
 *                machineFingerprint, nonce, timestamp }
 */

async function sha256HexHttp(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

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

http.route({
  method: 'GET',
  path: '/v1/providers',
  handler: httpAction(async () => {
    return jsonResponse({
      providers: PROVIDER_REGISTRY.map((provider) => ({
        providerKey: provider.providerKey,
        label: provider.label,
        category: provider.category,
        status: provider.status,
        docsUrl: provider.docsUrl,
        creatorAuthModes: provider.creatorAuthModes,
        buyerVerificationMethods: provider.buyerVerificationMethods,
        capabilities: provider.capabilities,
        setupRequirements: provider.setupRequirements,
        supportsTestMode: provider.supportsTestMode,
      })),
    });
  }),
});

http.route({
  method: 'GET',
  pathPrefix: '/v1/providers/',
  handler: httpAction(async (_ctx, request) => {
    const providerKey = request.url.replace(/^.*\/v1\/providers\//, '').split('?')[0];
    const provider = PROVIDER_REGISTRY_BY_KEY[providerKey as keyof typeof PROVIDER_REGISTRY_BY_KEY];
    if (!provider) {
      return errorResponse('Provider not found', 404);
    }
    return jsonResponse(provider);
  }),
});

/** Parse and verify a cert envelope from "Authorization: Bearer <base64>" */
async function parseBearerCert(
  request: Request,
  rootPublicKey: string
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
 * that callers never need a secondary DB lookup, the token is the source of truth.
 *
 * Reference: https://www.rfc-editor.org/rfc/rfc9700.html (OAuth 2.0 Security BCP)
 */
async function verifyOAuthToken(
  token: string,
  siteUrl: string,
  requiredScope: string
): Promise<
  | { ok: true; yucpUserId: string; name: string | null; email: string | null }
  | { ok: false; error: string }
> {
  try {
    const { verifyAccessToken } = await import('better-auth/oauth2');
    const authBase = `${siteUrl.replace(/\/$/, '')}/api/auth`;

    // Detect token type for diagnostics: JWTs are 3 dot-separated base64 segments
    const _isJwtShape = (token.match(/\./g) ?? []).length === 2;

    const verified = await verifyAccessToken(token, {
      verifyOptions: {
        issuer: authBase,
        audience: 'yucp-public-api',
      },
      jwksUrl: `${authBase}/jwks`,
    });

    // Require the exact scope this endpoint needs
    const claims = verified as Record<string, unknown>;
    const scope: string = (claims.scope as string) ?? '';
    const scopes = scope.split(' ');
    if (!scopes.includes(requiredScope)) {
      return { ok: false, error: `Token missing required scope: ${requiredScope}` };
    }

    // Better Auth puts the user ID in auth_user_id (custom claim) and sub
    const userId = (claims.auth_user_id as string) ?? (claims.sub as string);
    if (!userId) return { ok: false, error: 'No user identity in token' };

    // Read stable profile claims embedded by customAccessTokenClaims on the server.
    // This avoids a DB lookup, the JWT is the source of truth for name/email.
    const name = (claims.name as string) ?? null;
    const email = (claims.email as string) ?? null;

    return { ok: true, yucpUserId: userId, name, email };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Token verification failed';
    return { ok: false, error: msg };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// RFC 8252 loopback proxy, wildcard port support for Unity Editor OAuth
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
const _SESSION_TTL_MS = 10 * 60 * 1000; // 10 minutes

function isLoopback(uri: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(uri).hostname);
  } catch {
    return false;
  }
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
      // Non-loopback clients go directly, no port proxy needed
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

    // Atomically look up and consume the loopback session (prevents TOCTOU)
    const session = await ctx.runMutation(internal.oauthLoopback.consumeSession, {
      oauthState: state,
    });

    if (!session) {
      return new Response(
        '<html><body><p>OAuth session expired or not found. Please try again in Unity.</p></body></html>',
        { status: 400, headers: { 'Content-Type': 'text/html' } }
      );
    }

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
// GET /v1/me, Current authenticated creator (like Spotify GET /v1/me)
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

    const tokenResult = await verifyOAuthToken(token, siteUrl, 'cert:issue');
    if (!tokenResult.ok) return errorResponse(tokenResult.error, 401);

    // Look up fresh user data from Better Auth's user table.
    // sub = the user's stable primary key (_id in the betterAuth component).
    const user = (await ctx.runQuery(components.betterAuth.adapter.findOne, {
      model: 'user',
      where: [{ field: 'id', value: tokenResult.yucpUserId }],
      select: ['id', 'name', 'email'],
    })) as { id?: string; name?: string; email?: string } | null;

    if (!user) return errorResponse('User not found', 404);

    return jsonResponse({
      sub: tokenResult.yucpUserId,
      name: user.name ?? tokenResult.name,
      email: user.email ?? tokenResult.email,
    });
  }),
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /v1/products, List authenticated creator's registered products
//
// Returns all active products from product_catalog for the requesting creator.
// Used by the Unity PackageSigning editor to populate Gumroad/Jinxxy dropdowns.
// Pattern mirrors GET /v1/me, validate Bearer token → sub → tenant → products.
// ─────────────────────────────────────────────────────────────────────────────

http.route({
  method: 'GET',
  path: '/v1/products',
  handler: httpAction(async (ctx, request) => {
    const siteUrl = process.env.CONVEX_SITE_URL;
    if (!siteUrl) return errorResponse('Service not configured', 503);

    const authHeader = request.headers.get('Authorization');
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) return errorResponse('Authorization: Bearer <access_token> required', 401);

    const tokenResult = await verifyOAuthToken(token, siteUrl, 'cert:issue');
    if (!tokenResult.ok) return errorResponse(tokenResult.error, 401);

    const tenant = await ctx.runQuery(internal.yucpLicenses.getTenantByAuthUser, {
      ownerAuthUserId: tokenResult.yucpUserId,
    });
    if (!tenant) {
      console.log(`[products] No creator profile found for user ${tokenResult.yucpUserId}`);
      return errorResponse('Creator account not found', 404);
    }

    // ── Own products (includes Discord if role_rules are configured) ──────────
    const ownProducts = await ctx.runQuery(internal.yucpLicenses.getProductsForTenant, {
      authUserId: tokenResult.yucpUserId,
    });

    // Tag own products with owner=null
    const allProducts: Array<{
      productId: string;
      displayName?: string;
      providers: Array<{ provider: string; providerProductRef: string }>;
      owner: string | null;
    }> = ownProducts.map((p) => ({ ...p, owner: null }));

    // ── Collaborator products ─────────────────────────────────────────────────
    // If the creator has linked Discord, check for collaborator connections
    try {
      const discordAccount = (await ctx.runQuery(components.betterAuth.adapter.findOne, {
        model: 'account',
        where: [
          { field: 'userId', value: tokenResult.yucpUserId },
          { field: 'providerId', value: 'discord' },
        ],
        select: ['accountId'],
      })) as { accountId?: string } | null;

      if (discordAccount?.accountId) {
        const collabConnections = await ctx.runQuery(
          internal.collaboratorInvites.getActiveByCollaboratorDiscord,
          { collaboratorDiscordUserId: discordAccount.accountId }
        );

        for (const conn of collabConnections) {
          // Skip if this is the same creator as own (shouldn't happen, but guard)
          if (conn.ownerAuthUserId === tokenResult.yucpUserId) continue;

          const [collabProducts, ownerProfile] = await Promise.all([
            ctx.runQuery(internal.yucpLicenses.getProductsForTenant, {
              authUserId: conn.ownerAuthUserId,
            }),
            ctx.runQuery(internal.yucpLicenses.getTenantByAuthUser, {
              ownerAuthUserId: conn.ownerAuthUserId,
            }),
          ]);

          const ownerName = ownerProfile?.name ?? 'Collaborator';
          for (const p of collabProducts) {
            allProducts.push({ ...p, owner: ownerName });
          }
        }
      }
    } catch (err) {
      // Non-fatal: collaborator lookup failure should not block own products
      console.warn('[products] collaborator lookup failed:', err);
    }

    console.log(
      `[products] authUserId=${tokenResult.yucpUserId} own=${ownProducts.length} total=${allProducts.length}`
    );
    return jsonResponse({ products: allProducts });
  }),
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /v1/keys, YUCP CA root public key (JWK Set format, no auth required)
//
// Returns the trust anchor used to verify all YUCP certificates.
// Clients (Unity) fetch this once and cache it in settings, no hardcoding.
// ─────────────────────────────────────────────────────────────────────────────

http.route({
  method: 'GET',
  path: '/v1/keys',
  handler: httpAction(async (_ctx, _request) => {
    const rootPrivateKey = process.env.YUCP_ROOT_PRIVATE_KEY;
    const keyId = process.env.YUCP_KEY_ID ?? 'yucp-root-2025';
    if (!rootPrivateKey) return errorResponse('Service not configured', 503);

    const publicKeyBase64 = await getPublicKeyFromPrivate(rootPrivateKey);

    return jsonResponse({
      keys: [
        {
          kty: 'OKP',
          crv: 'Ed25519',
          kid: keyId,
          x: publicKeyBase64,
        },
      ],
    });
  }),
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /v1/certificates/me, Restore active cert for this machine's key
//
// Called by new Unity projects that are already signed in but have no local
// SigningSettings asset yet. Returns the active cert for the authenticated
// user + the devPublicKey from the request header, so the project can
// bootstrap without issuing a new cert (no rate limit consumed).
//
// Header: Authorization: Bearer <access_token>
// Header: X-Dev-Public-Key: <base64 devPublicKey>
// ─────────────────────────────────────────────────────────────────────────────

http.route({
  method: 'GET',
  path: '/v1/certificates/me',
  handler: httpAction(async (ctx, request) => {
    const siteUrl = process.env.CONVEX_SITE_URL;
    if (!siteUrl) return errorResponse('Service not configured', 503);

    const authHeader = request.headers.get('Authorization');
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) return errorResponse('Authorization: Bearer <access_token> required', 401);

    const tokenResult = await verifyOAuthToken(token, siteUrl, 'cert:issue');
    if (!tokenResult.ok) return errorResponse(tokenResult.error, 401);

    const devPublicKey = request.headers.get('X-Dev-Public-Key');
    if (!devPublicKey) return errorResponse('X-Dev-Public-Key header required', 400);

    const cert = await ctx.runQuery(internal.yucpCertificates.getActiveCertForUser, {
      yucpUserId: tokenResult.yucpUserId,
      devPublicKey,
    });

    if (!cert) return errorResponse('No active certificate found for this machine', 404);

    return jsonResponse({ certificate: JSON.parse(cert.certData) });
  }),
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /v1/certificates, Issue cert via YUCP OAuth token (was /api/yucp/certificates/issue)
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

    const tokenResult = await verifyOAuthToken(token, siteUrl, 'cert:issue');
    if (!tokenResult.ok) return errorResponse(tokenResult.error, 401);
    const { yucpUserId } = tokenResult;

    // Look up the user's subject to get their Discord ID (secondary identity anchor)
    const subjectResult = await ctx.runQuery(api.subjects.getSubjectByAuthId, {
      apiSecret: process.env.CONVEX_API_SECRET ?? '',
      authUserId: yucpUserId,
    });
    const discordUserId = subjectResult?.found
      ? subjectResult.subject.primaryDiscordUserId
      : undefined;

    // Parse request body
    let body: { devPublicKey: string; publisherName: string };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return errorResponse('Invalid JSON body', 400);
    }
    if (!body.devPublicKey || !body.publisherName) {
      return errorResponse('devPublicKey and publisherName are required', 400);
    }

    // Validate publisherName against allowlist: alphanumeric, spaces, underscore, dash, dot (1-100 chars)
    const PUBLISHER_NAME_RE = /^[a-zA-Z0-9 _\-.]{1,100}$/;
    if (!PUBLISHER_NAME_RE.test(body.publisherName)) {
      return errorResponse('Invalid publisherName', 400);
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
      // Sanitize Convex-wrapped errors, never expose stack traces or internal paths.
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
// GET /v1/packages/:hash, Consumer verification (was /api/yucp/packages/by-hash/:hash)
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
// POST /v1/signatures, Register in transparency log (was /api/yucp/sign-manifest)
// ─────────────────────────────────────────────────────────────────────────────

http.route({
  method: 'POST',
  path: '/v1/signatures',
  handler: httpAction(async (ctx, request) => {
    const rootPrivateKey = process.env.YUCP_ROOT_PRIVATE_KEY;
    if (!rootPrivateKey) return errorResponse('Service not configured', 503);

    const rootPublicKey = await getPublicKeyFromPrivate(rootPrivateKey);

    const certResult = await parseBearerCert(request, rootPublicKey);
    if (!certResult.ok) return errorResponse(certResult.error, 401);
    const { envelope } = certResult;

    // Reject revoked certificates, revocation via /v1/certificates/revoke must
    // be enforced here; parseBearerCert only checks signature validity and expiry.
    const certRecord = await ctx.runQuery(internal.yucpCertificates.getCertByNonce, {
      certNonce: envelope.cert.nonce,
    });
    if (!certRecord || certRecord.status !== 'active') {
      return errorResponse('Certificate has been revoked', 401);
    }

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
        409
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
        409
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
// POST /v1/certificates/revoke, Admin revocation (was /api/yucp/certificates/revoke)
// ─────────────────────────────────────────────────────────────────────────────

http.route({
  method: 'POST',
  path: '/v1/certificates/revoke',
  handler: httpAction(async (ctx, request) => {
    const apiSecret = process.env.CONVEX_API_SECRET;
    const auth = request.headers.get('Authorization');
    if (!apiSecret || !constantTimeEqual(auth ?? '', `Bearer ${apiSecret}`)) {
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

// ─────────────────────────────────────────────────────────────────────────────
// POST /v1/licenses/verify, Unity editor license gate
// ─────────────────────────────────────────────────────────────────────────────

http.route({
  method: 'POST',
  path: '/v1/licenses/verify',
  handler: httpAction(async (ctx, request) => {
    let body: {
      packageId: string;
      licenseKey: string;
      provider: string;
      productPermalink: string;
      machineFingerprint: string;
      nonce: string;
      timestamp: number;
    };

    try {
      body = (await request.json()) as typeof body;
    } catch {
      return errorResponse('Invalid JSON body', 400);
    }

    const {
      packageId,
      licenseKey,
      provider,
      productPermalink,
      machineFingerprint,
      nonce,
      timestamp,
    } = body ?? {};

    if (
      !packageId ||
      !licenseKey ||
      !provider ||
      !productPermalink ||
      !machineFingerprint ||
      !nonce ||
      !timestamp
    ) {
      return errorResponse('Missing required fields', 400);
    }

    const licenseKeyDigest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(licenseKey),
    );
    const licenseKeyHash = Array.from(new Uint8Array(licenseKeyDigest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    const result = await ctx.runAction(internal.yucpLicenses.verifyLicense, {
      packageId,
      licenseKey: licenseKeyHash,
      provider,
      productPermalink,
      machineFingerprint,
      nonce,
      timestamp,
    });

    if (!result.success) {
      return jsonResponse({ error: result.error }, 422);
    }

    return jsonResponse({ success: true, token: result.token, expiresAt: result.expiresAt });
  }),
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /v1/licenses/verify-discord, Discord role entitlement verification
//
// The buyer must have already been granted an entitlement via the creator's
// Discord bot. This endpoint checks for that existing entitlement and issues
// a license JWT, no license key input required.
//
// Flow: buyer does YUCP OAuth → Bearer token → server maps to Discord user ID
//   → checks entitlements table → issues machine-bound license JWT
// ─────────────────────────────────────────────────────────────────────────────

http.route({
  method: 'POST',
  path: '/v1/licenses/verify-discord',
  handler: httpAction(async (ctx, request) => {
    const siteUrl = process.env.CONVEX_SITE_URL;
    if (!siteUrl) return errorResponse('Service not configured', 503);

    const authHeader = request.headers.get('Authorization');
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) return errorResponse('Authorization: Bearer <oauth_access_token> required', 401);

    const tokenResult = await verifyOAuthToken(token, siteUrl, 'verification:read');
    if (!tokenResult.ok) return errorResponse(tokenResult.error, 401);

    let body: {
      packageId: string;
      creatorAuthUserId: string;
      productId: string;
      machineFingerprint: string;
      nonce: string;
      timestamp: number;
    };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return errorResponse('Invalid JSON body', 400);
    }

    const { packageId, creatorAuthUserId, productId, machineFingerprint, nonce, timestamp } =
      body ?? {};
    if (
      !packageId ||
      !creatorAuthUserId ||
      !productId ||
      !machineFingerprint ||
      !nonce ||
      !timestamp
    ) {
      return errorResponse('Missing required fields', 400);
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSeconds - (timestamp as number)) > 120) {
      return errorResponse('Request timestamp out of range', 422);
    }

    // Get buyer's linked Discord account via Better Auth
    const discordAccount = (await ctx.runQuery(components.betterAuth.adapter.findOne, {
      model: 'account',
      where: [
        { field: 'userId', value: tokenResult.yucpUserId },
        { field: 'providerId', value: 'discord' },
      ],
      select: ['accountId'],
    })) as { accountId?: string } | null;

    if (!discordAccount?.accountId) {
      return errorResponse('No Discord account linked. Sign in with Discord via YUCP first.', 403);
    }

    // Find subject record by their Discord user ID
    const subject = await ctx.runQuery(internal.yucpLicenses.getSubjectByDiscordUser, {
      discordUserId: discordAccount.accountId,
    });
    if (!subject) {
      return errorResponse(
        "No verified Discord account found. Verify your purchase with the creator's Discord server first.",
        403
      );
    }

    // Look up creator's profile
    const creatorProfile = await ctx.runQuery(internal.yucpLicenses.getTenantByAuthUser, {
      ownerAuthUserId: creatorAuthUserId,
    });
    if (!creatorProfile) return errorResponse('Creator account not found', 404);

    // Check for an active entitlement
    const hasEntitlement = await ctx.runQuery(internal.yucpLicenses.checkSubjectEntitlement, {
      authUserId: creatorAuthUserId,
      subjectId: subject._id,
      productId,
    });
    if (!hasEntitlement) {
      return errorResponse(
        "No active entitlement. Purchase or verify via the creator's Discord server first.",
        403
      );
    }

    // Verify packageId is registered to the creator so the JWT package_id
    // claim cannot be forged by a buyer supplying an arbitrary package name.
    const packageReg = await ctx.runQuery(internal.packageRegistry.getRegistration, {
      packageId,
    });
    if (!packageReg || packageReg.yucpUserId !== creatorAuthUserId) {
      return errorResponse('Package not found or not owned by the specified creator', 403);
    }

    // Issue machine-fingerprint-bound license JWT
    const rootPrivateKey = process.env.YUCP_ROOT_PRIVATE_KEY;
    if (!rootPrivateKey) throw new Error('YUCP_ROOT_PRIVATE_KEY not configured');

    const TOKEN_TTL_SECONDS = 3600;
    const iat = nowSeconds;
    const exp = iat + TOKEN_TTL_SECONDS;

    const claims: LicenseClaims = {
      iss: `${siteUrl.replace(/\/$/, '')}/api/auth`,
      aud: 'yucp-license-gate',
      sub: await sha256HexHttp(discordAccount.accountId),
      jti: nonce,
      package_id: packageId,
      machine_fingerprint: machineFingerprint,
      provider: 'discord',
      iat,
      exp,
    };

    const keyId = process.env.YUCP_ROOT_KEY_ID ?? 'yucp-root';
    const licenseToken = await signLicenseJwt(claims, rootPrivateKey, keyId);

    console.log(
      `[license/verify-discord] issued token package_id=${packageId} subject=${String(subject._id).slice(0, 8)}*** exp=${exp}`
    );

    return jsonResponse({ success: true, token: licenseToken, expiresAt: exp });
  }),
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /v1/vrchat/avatar-name, Bot-internal: resolve avatar display name
// Auth: Bearer <CONVEX_API_SECRET>
// Body: { authUserId, avatarId }
// Uses the tenant owner's stored VRChat session (from BetterAuth) to call
// GET /avatars/{id} and return the avatar name. Non-fatal, returns null if
// the owner has no linked VRChat account or the avatar is inaccessible.
// ─────────────────────────────────────────────────────────────────────────────

http.route({
  method: 'POST',
  path: '/v1/vrchat/avatar-name',
  handler: httpAction(async (ctx, request) => {
    const apiSecret = process.env.CONVEX_API_SECRET;
    const auth = request.headers.get('Authorization');
    if (!apiSecret || !constantTimeEqual(auth ?? '', `Bearer ${apiSecret}`)) {
      return errorResponse('Unauthorized', 401);
    }

    let body: { authUserId: string; avatarId: string };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return errorResponse('Invalid JSON body', 400);
    }
    if (!body.authUserId || !body.avatarId) {
      return errorResponse('authUserId and avatarId are required', 400);
    }

    // Get creator profile to find owner's auth user ID
    const creatorProfile = await ctx.runQuery(internal.yucpLicenses.getTenantOwnerById, {
      authUserId: body.authUserId,
    });
    if (!creatorProfile) return jsonResponse({ name: null });

    // Look up owner's VRChat account from BetterAuth
    const vrchatAccount = (await ctx.runQuery(components.betterAuth.adapter.findOne, {
      model: 'account',
      where: [
        { field: 'userId', value: creatorProfile.authUserId },
        { field: 'providerId', value: 'vrchat' },
      ],
      select: ['accessToken', 'idToken'],
    })) as { accessToken?: string; idToken?: string } | null;

    if (!vrchatAccount?.accessToken) return jsonResponse({ name: null });

    // Decrypt the stored VRChat session (mirrors loadStoredSession in vrchat plugin)
    const ENCRYPTED_PREFIX = 'enc:v1:';
    const PROVIDER_SESSION_PURPOSE = 'vrchat-provider-session';
    const sessionSecret =
      process.env.VRCHAT_PROVIDER_SESSION_SECRET ?? process.env.BETTER_AUTH_SECRET;
    if (!sessionSecret) return jsonResponse({ name: null });

    let authToken: string;
    let twoFactorAuthToken: string | undefined;
    try {
      const rawAuth = vrchatAccount.accessToken;
      authToken = rawAuth.startsWith(ENCRYPTED_PREFIX)
        ? await decryptForPurpose(
            rawAuth.slice(ENCRYPTED_PREFIX.length),
            sessionSecret,
            PROVIDER_SESSION_PURPOSE
          )
        : rawAuth;
      if (vrchatAccount.idToken) {
        const rawTfa = vrchatAccount.idToken;
        twoFactorAuthToken = rawTfa.startsWith(ENCRYPTED_PREFIX)
          ? await decryptForPurpose(
              rawTfa.slice(ENCRYPTED_PREFIX.length),
              sessionSecret,
              PROVIDER_SESSION_PURPOSE
            )
          : rawTfa;
      }
    } catch {
      return jsonResponse({ name: null });
    }

    // Call VRChat API with the decrypted session
    const cookieParts = [`auth=${authToken}`];
    if (twoFactorAuthToken) cookieParts.push(`twoFactorAuth=${twoFactorAuthToken}`);
    const avatarRes = await fetch(
      `https://api.vrchat.cloud/api/1/avatars/${encodeURIComponent(body.avatarId)}`,
      {
        headers: {
          cookie: cookieParts.join('; '),
          'user-agent': 'YUCP Creator Assistant/0.1.0 (https://yucp.app)',
        },
      }
    );

    if (!avatarRes.ok) return jsonResponse({ name: null });
    const avatarData = (await avatarRes.json().catch(() => null)) as Record<string, unknown> | null;
    const name = typeof avatarData?.name === 'string' ? avatarData.name : null;
    return jsonResponse({ name });
  }),
});

// Better Auth routes must be registered last
authComponent.registerRoutes(http, createAuth, { cors: true });

export default http;
