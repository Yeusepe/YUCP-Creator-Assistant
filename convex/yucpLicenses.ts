/**
 * YUCP License Gate — Unity editor license verification endpoint.
 *
 * Verifies a purchase license (Gumroad or Jinxxy) for a specific YUCP package,
 * then returns a short-lived signed JWT that the Unity client caches locally.
 * The JWT is machine-fingerprint-bound so it cannot be shared between machines.
 *
 * Credential resolution order:
 *   1. Look up product in product_catalog by providerProductRef -> get owner tenantId
 *   2. Decrypt owner's credentials from provider_connections via Better Auth symmetricDecrypt
 *   3. For Jinxxy: fall through to collaborator_connections if primary credential missing/invalid
 *   4. Fall back to global env vars (GUMROAD_ACCESS_TOKEN / JINXXY_API_KEY) for YUCP's own products
 *
 * Flow:
 *   Unity client  ->  POST /v1/licenses/verify  ->  Gumroad/Jinxxy API
 *                                              <-  { token: "<EdDSA JWT>" }
 *   Unity client stores JWT in AES-256-CBC+HMAC encrypted on-disk cache
 *   DerivedFbxBuilder reads SessionState set by LicenseTokenCache before decrypting FBX
 *
 * Security properties:
 *   - License key verified against official provider API before any JWT is issued
 *   - Credentials fetched from product owner's connected store -- same path as the Discord bot
 *   - JWT machine_fingerprint claim prevents cross-machine token sharing
 *   - Short TTL (1 h online, 30-day disk cache) limits exposure window
 *   - Timestamp +-120 s window prevents stale request replay
 *   - Raw license key is never logged; only SHA-256(key) is embedded as sub
 *
 * References:
 *   Gumroad license API  https://app.gumroad.com/api#licenses
 *   RFC 8725 JWT BCP     https://www.rfc-editor.org/rfc/rfc8725
 */

import { internalAction, internalQuery } from './_generated/server';
import { v } from 'convex/values';
import { internal } from './_generated/api';
import { symmetricDecrypt } from 'better-auth/crypto';
import { signLicenseJwt, type LicenseClaims } from './lib/yucpCrypto';

const TOKEN_TTL_SECONDS = 3600; // 1 hour -- kept short; disk cache handles offline re-use

// =============================================================================
// Internal queries (callable from internalAction via ctx.runQuery)
// =============================================================================

/** Find a product in the catalog by its provider + providerProductRef slug. */
export const getProductByProviderRef = internalQuery({
  args: {
    provider: v.string(),
    providerProductRef: v.string(),
  },
  returns: v.union(
    v.null(),
    v.object({ tenantId: v.id('tenants'), productId: v.string(), displayName: v.optional(v.string()) }),
  ),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query('product_catalog')
      .withIndex('by_provider_ref', (q) =>
        q.eq('provider', args.provider as 'gumroad' | 'jinxxy').eq('providerProductRef', args.providerProductRef),
      )
      .filter((q) => q.eq(q.field('status'), 'active'))
      .first();
    if (!row) return null;
    return { tenantId: row.tenantId, productId: row.productId, displayName: row.displayName };
  },
});

/** Get the encrypted provider connection for a tenant. */
export const getProviderConnection = internalQuery({
  args: {
    tenantId: v.id('tenants'),
    provider: v.string(),
  },
  returns: v.union(
    v.null(),
    v.object({
      gumroadAccessTokenEncrypted: v.optional(v.string()),
      jinxxyApiKeyEncrypted: v.optional(v.string()),
    }),
  ),
  handler: async (ctx, args) => {
    const conn = await ctx.db
      .query('provider_connections')
      .withIndex('by_tenant_provider', (q) =>
        q.eq('tenantId', args.tenantId).eq('provider', args.provider as 'gumroad' | 'jinxxy'),
      )
      .filter((q) => q.neq(q.field('status'), 'disconnected'))
      .first();
    if (!conn) return null;
    return {
      gumroadAccessTokenEncrypted: conn.gumroadAccessTokenEncrypted,
      jinxxyApiKeyEncrypted: conn.jinxxyApiKeyEncrypted,
    };
  },
});

/** Get active collaborator Jinxxy API keys for a tenant owner. */
export const getCollaboratorConnections = internalQuery({
  args: { ownerTenantId: v.id('tenants') },
  returns: v.array(v.object({ jinxxyApiKeyEncrypted: v.optional(v.string()) })),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('collaborator_connections')
      .withIndex('by_owner_status', (q) =>
        q.eq('ownerTenantId', args.ownerTenantId).eq('status', 'active'),
      )
      .collect();
    return rows
      .filter((r) => r.jinxxyApiKeyEncrypted)
      .map((r) => ({ jinxxyApiKeyEncrypted: r.jinxxyApiKeyEncrypted }));
  },
});

/** Get tenant by ownerAuthUserId (internal only -- no API secret needed). */
export const getTenantByAuthUser = internalQuery({
  args: { ownerAuthUserId: v.string() },
  returns: v.union(
    v.null(),
    v.object({ _id: v.id('tenants'), name: v.string(), slug: v.optional(v.string()) }),
  ),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query('tenants')
      .withIndex('by_owner_auth', (q) => q.eq('ownerAuthUserId', args.ownerAuthUserId))
      .first();
    if (!row) return null;
    return { _id: row._id, name: row.name, slug: row.slug };
  },
});

/** List active products for a tenant (all providers). */
export const getProductsForTenant = internalQuery({
  args: { tenantId: v.id('tenants') },
  returns: v.array(
    v.object({
      productId: v.string(),
      provider: v.string(),
      providerProductRef: v.string(),
      displayName: v.optional(v.string()),
    }),
  ),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('product_catalog')
      .withIndex('by_tenant', (q) => q.eq('tenantId', args.tenantId))
      .filter((q) => q.eq(q.field('status'), 'active'))
      .collect();
    return rows.map((r) => ({
      productId: r.productId,
      provider: r.provider as string,
      providerProductRef: r.providerProductRef,
      displayName: r.displayName,
    }));
  },
});

// =============================================================================
// Helpers
// =============================================================================

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function decryptCredential(encrypted: string): Promise<string | null> {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret || !encrypted) return null;
  try {
    return await symmetricDecrypt({ key: secret, data: encrypted });
  } catch {
    return null;
  }
}

// =============================================================================
// Provider verification (accept credentials as params -- no global env reads)
// =============================================================================

interface GumroadVerifyResult {
  success: boolean;
  purchase?: {
    product_permalink: string;
    email: string;
    refunded: boolean;
    chargebacked: boolean;
  };
  message?: string;
}

async function verifyGumroadLicense(
  licenseKey: string,
  productPermalink: string,
  accessToken: string,
): Promise<{ valid: boolean; reason?: string }> {
  const params = new URLSearchParams({
    access_token: accessToken,
    product_permalink: productPermalink,
    license_key: licenseKey,
    increment_uses_count: 'false',
  });

  const resp = await fetch('https://api.gumroad.com/v2/licenses/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  const json = (await resp.json()) as GumroadVerifyResult;

  if (!json.success) return { valid: false, reason: json.message ?? 'Invalid license' };
  if (json.purchase?.refunded) return { valid: false, reason: 'License has been refunded' };
  if (json.purchase?.chargebacked) return { valid: false, reason: 'License has a chargeback' };

  return { valid: true };
}

async function verifyJinxxyLicense(
  licenseKey: string,
  productId: string,
  apiKey: string,
): Promise<{ valid: boolean; reason?: string }> {
  const resp = await fetch(`https://jinxxy.com/api/v1/licenses/${encodeURIComponent(licenseKey)}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (resp.status === 404) return { valid: false, reason: 'License not found' };
  if (!resp.ok) return { valid: false, reason: `Jinxxy API error: ${resp.status}` };

  const json = (await resp.json()) as { active: boolean; product_id?: string };
  if (!json.active) return { valid: false, reason: 'License is not active' };
  if (productId && json.product_id && json.product_id !== productId) {
    return { valid: false, reason: 'License does not match the expected product' };
  }

  return { valid: true };
}

// =============================================================================
// Main action (called from http.ts httpAction for POST /v1/licenses/verify)
// =============================================================================

export const verifyLicense = internalAction({
  args: {
    packageId: v.string(),
    licenseKey: v.string(),
    provider: v.string(),
    productPermalink: v.string(),
    machineFingerprint: v.string(),
    nonce: v.string(),
    timestamp: v.number(),
  },
  returns: v.object({
    success: v.boolean(),
    token: v.optional(v.string()),
    expiresAt: v.optional(v.number()),
    error: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    // 1. Replay protection: timestamp must be within +-120 seconds
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSeconds - args.timestamp) > 120) {
      return { success: false, error: 'Request timestamp out of range' };
    }

    // 2. Basic input validation
    if (!args.packageId || !args.licenseKey || !args.provider || !args.productPermalink) {
      return { success: false, error: 'Missing required fields' };
    }
    if (!args.machineFingerprint || args.machineFingerprint.length < 16) {
      return { success: false, error: 'Invalid machine fingerprint' };
    }
    if (!args.nonce || args.nonce.length < 16) {
      return { success: false, error: 'Nonce too short' };
    }

    // 3. Resolve credentials from product_catalog + provider_connections
    let verifyResult: { valid: boolean; reason?: string } | null = null;

    const product = await ctx.runQuery(internal.yucpLicenses.getProductByProviderRef, {
      provider: args.provider,
      providerProductRef: args.productPermalink,
    });

    if (product) {
      const conn = await ctx.runQuery(internal.yucpLicenses.getProviderConnection, {
        tenantId: product.tenantId,
        provider: args.provider,
      });

      if (args.provider === 'gumroad' && conn?.gumroadAccessTokenEncrypted) {
        const token = await decryptCredential(conn.gumroadAccessTokenEncrypted);
        if (token) {
          verifyResult = await verifyGumroadLicense(args.licenseKey, args.productPermalink, token);
        }
      } else if (args.provider === 'jinxxy') {
        // Try primary connection first
        if (conn?.jinxxyApiKeyEncrypted) {
          const key = await decryptCredential(conn.jinxxyApiKeyEncrypted);
          if (key) {
            verifyResult = await verifyJinxxyLicense(args.licenseKey, args.productPermalink, key);
          }
        }

        // If primary failed or missing, try collaborator connections
        if (!verifyResult?.valid) {
          const collabConns = await ctx.runQuery(internal.yucpLicenses.getCollaboratorConnections, {
            ownerTenantId: product.tenantId,
          });
          for (const collab of collabConns) {
            if (!collab.jinxxyApiKeyEncrypted) continue;
            const key = await decryptCredential(collab.jinxxyApiKeyEncrypted);
            if (!key) continue;
            const result = await verifyJinxxyLicense(args.licenseKey, args.productPermalink, key);
            if (result.valid) {
              verifyResult = result;
              break;
            }
          }
        }
      }
    }

    // 4. Fall back to global env-var credentials (YUCP's own products)
    if (!verifyResult?.valid) {
      if (args.provider === 'gumroad') {
        const fallbackToken = process.env.GUMROAD_ACCESS_TOKEN;
        if (!fallbackToken) {
          return { success: false, error: 'Gumroad credentials not configured for this product' };
        }
        verifyResult = await verifyGumroadLicense(args.licenseKey, args.productPermalink, fallbackToken);
      } else if (args.provider === 'jinxxy') {
        const fallbackKey = process.env.JINXXY_API_KEY;
        if (!fallbackKey) {
          return { success: false, error: 'Jinxxy credentials not configured for this product' };
        }
        verifyResult = await verifyJinxxyLicense(args.licenseKey, args.productPermalink, fallbackKey);
      } else {
        return { success: false, error: `Unknown provider: ${args.provider}` };
      }
    }

    if (!verifyResult?.valid) {
      return { success: false, error: verifyResult?.reason ?? 'License verification failed' };
    }

    // 5. Issue signed license JWT
    const rootPrivateKey = process.env.YUCP_ROOT_PRIVATE_KEY;
    if (!rootPrivateKey) throw new Error('YUCP_ROOT_PRIVATE_KEY not configured');

    const siteUrl = process.env.CONVEX_SITE_URL?.replace(/\/$/, '') ?? '';
    const iat = nowSeconds;
    const exp = iat + TOKEN_TTL_SECONDS;

    const licenseKeyHash = await sha256Hex(args.licenseKey);

    const claims: LicenseClaims = {
      iss: `${siteUrl}/api/auth`,
      aud: 'yucp-license-gate',
      sub: licenseKeyHash,
      jti: args.nonce,
      package_id: args.packageId,
      machine_fingerprint: args.machineFingerprint,
      provider: args.provider,
      iat,
      exp,
    };

    const keyId = process.env.YUCP_ROOT_KEY_ID ?? 'yucp-root';
    const token = await signLicenseJwt(claims, rootPrivateKey, keyId);

    console.log(
      `[license/verify] issued token package_id=${args.packageId} provider=${args.provider} exp=${exp}`,
    );

    return { success: true, token, expiresAt: exp };
  },
});
