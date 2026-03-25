/**
 * YUCP License Gate — Unity editor license verification endpoint.
 *
 * Verifies a purchase license (Gumroad or Jinxxy) for a specific YUCP package,
 * then returns a short-lived signed JWT that the Unity client caches locally.
 * The JWT is machine-fingerprint-bound so it cannot be shared between machines.
 *
 * Credential resolution order:
 *   1. Look up product in product_catalog by providerProductRef -> get owner authUserId
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

import { symmetricDecrypt } from 'better-auth/crypto';
import { ConvexError, v } from 'convex/values';
import { internal } from './_generated/api';
import { internalAction, internalMutation, internalQuery } from './_generated/server';
import { BILLING_CAPABILITY_KEYS } from './lib/billingCapabilities';
import {
  decryptProtectedBlobContentKey,
  encryptProtectedBlobContentKey,
} from './lib/protectedAssetKeyCrypto';
import { resolveProtectedAssetUnlockMode } from './lib/protectedAssetUnlockMode';
import { buildPublicAuthIssuer } from './lib/publicAuthIssuer';
import {
  RELEASE_ARTIFACT_KEYS,
  RELEASE_CHANNELS,
  RELEASE_PLATFORMS,
} from './lib/releaseArtifactKeys';
import {
  getPublicKeyFromPrivate,
  type LicenseClaims,
  type ProtectedUnlockClaims,
  signLicenseJwt,
  signProtectedUnlockJwt,
  verifyLicenseJwt,
} from './lib/yucpCrypto';

const TOKEN_TTL_SECONDS = 3600; // 1 hour -- kept short; disk cache handles offline re-use
const PROTECTED_UNLOCK_TTL_SECONDS = 30 * 24 * 60 * 60;
const WATERMARK_ASSET_PATH_MAX_LENGTH = 512;
const PACKAGE_ID_RE = /^[a-z0-9\-_./:]{1,128}$/;
const PROTECTED_ASSET_ID_RE = /^[a-f0-9]{32}$/;
const MACHINE_FINGERPRINT_RE = /^[a-z0-9:_-]{16,256}$/i;
const PROJECT_ID_RE = /^[a-f0-9]{32}$/;
const PROTECTED_ASSET_REGISTRATION = v.object({
  protectedAssetId: v.string(),
  unlockMode: v.union(v.literal('wrapped_content_key'), v.literal('content_key_b64')),
  wrappedContentKey: v.optional(v.string()),
  contentKeyBase64: v.optional(v.string()),
  displayName: v.optional(v.string()),
});

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
    v.object({
      authUserId: v.string(),
      productId: v.string(),
      displayName: v.optional(v.string()),
    })
  ),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query('product_catalog')
      .withIndex('by_provider_ref', (q) =>
        q
          .eq('provider', args.provider as 'gumroad' | 'jinxxy')
          .eq('providerProductRef', args.providerProductRef)
      )
      .filter((q) => q.eq(q.field('status'), 'active'))
      .first();
    if (!row) return null;
    return { authUserId: row.authUserId, productId: row.productId, displayName: row.displayName };
  },
});

/** Get the encrypted provider connection credentials for a user. */
export const getProviderConnection = internalQuery({
  args: {
    authUserId: v.string(),
    provider: v.string(),
  },
  returns: v.union(
    v.null(),
    v.object({
      credentials: v.record(v.string(), v.string()),
    })
  ),
  handler: async (ctx, args) => {
    const conn = await ctx.db
      .query('provider_connections')
      .withIndex('by_auth_user_provider', (q) =>
        q.eq('authUserId', args.authUserId).eq('provider', args.provider as 'gumroad' | 'jinxxy')
      )
      .filter((q) => q.neq(q.field('status'), 'disconnected'))
      .first();
    if (!conn) return null;

    const credRows = await ctx.db
      .query('provider_credentials')
      .withIndex('by_connection', (q) => q.eq('providerConnectionId', conn._id))
      .collect();

    const credentials: Record<string, string> = {};
    for (const row of credRows) {
      if (row.encryptedValue) {
        credentials[row.credentialKey] = row.encryptedValue;
      }
    }
    return { credentials };
  },
});

/** Get active collaborator API keys for a creator owner. */
export const getCollaboratorConnections = internalQuery({
  args: { ownerAuthUserId: v.string() },
  returns: v.array(v.object({ credentialEncrypted: v.optional(v.string()) })),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('collaborator_connections')
      .withIndex('by_owner_status', (q) =>
        q.eq('ownerAuthUserId', args.ownerAuthUserId).eq('status', 'active')
      )
      .collect();
    return rows
      .filter((r) => r.credentialEncrypted)
      .map((r) => ({ credentialEncrypted: r.credentialEncrypted }));
  },
});

/** Get creator profile by ownerAuthUserId (internal only -- no API secret needed). */
export const getTenantByAuthUser = internalQuery({
  args: { ownerAuthUserId: v.string() },
  returns: v.union(
    v.null(),
    v.object({ _id: v.id('creator_profiles'), name: v.string(), slug: v.optional(v.string()) })
  ),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query('creator_profiles')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', args.ownerAuthUserId))
      .first();
    if (!row) return null;
    return { _id: row._id, name: row.name, slug: row.slug };
  },
});

/** Get a creator profile by authUserId (used for collab product attribution). */
export const getTenantById = internalQuery({
  args: { authUserId: v.string() },
  returns: v.union(v.null(), v.object({ authUserId: v.string(), name: v.string() })),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query('creator_profiles')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))
      .first();
    if (!row) return null;
    return { authUserId: row.authUserId, name: row.name };
  },
});

/** Get a creator profile by authUserId (for internal auth lookups). */
export const getTenantOwnerById = internalQuery({
  args: { authUserId: v.string() },
  returns: v.union(v.null(), v.object({ authUserId: v.string(), name: v.string() })),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query('creator_profiles')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))
      .first();
    if (!row) return null;
    return { authUserId: row.authUserId, name: row.name };
  },
});

/**
 * Return distinct VRChat providerUserIds for all active buyers verified under
 * the given creator. Used by the /v1/vrchat/avatar-name HTTP endpoint to find
 * a live buyer session that can reach the VRChat API.
 */
export const getVrchatProviderUserIdsForCreator = internalQuery({
  args: { authUserId: v.string() },
  returns: v.array(v.string()),
  handler: async (ctx, args) => {
    const activeBindings = await ctx.db
      .query('bindings')
      .withIndex('by_auth_user_status', (q) =>
        q.eq('authUserId', args.authUserId).eq('status', 'active')
      )
      .collect();

    const seen = new Set<string>();
    const ids: string[] = [];
    for (const binding of activeBindings) {
      const extAccount = await ctx.db.get(binding.externalAccountId);
      if (
        extAccount?.provider === 'vrchat' &&
        extAccount.providerUserId &&
        !seen.has(extAccount.providerUserId)
      ) {
        seen.add(extAccount.providerUserId);
        ids.push(extAccount.providerUserId);
      }
    }
    return ids;
  },
});

export const getProductsForTenant = internalQuery({
  args: { authUserId: v.string() },
  returns: v.array(
    v.object({
      productId: v.string(),
      displayName: v.optional(v.string()),
      providers: v.array(v.object({ provider: v.string(), providerProductRef: v.string() })),
    })
  ),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('product_catalog')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))
      .filter((q) => q.eq(q.field('status'), 'active'))
      .collect();

    // Group by productId so each canonical product appears once with all its providers
    const grouped = new Map<
      string,
      {
        productId: string;
        displayName?: string;
        providers: Array<{ provider: string; providerProductRef: string }>;
      }
    >();

    for (const row of rows) {
      if (!grouped.has(row.productId)) {
        grouped.set(row.productId, {
          productId: row.productId,
          // Mirror the bot's fallback chain: displayName → canonicalSlug → providerProductRef
          displayName: row.displayName || row.canonicalSlug || row.providerProductRef || undefined,
          providers: [],
        });
      } else {
        // If a later row for the same productId has a better name, promote it
        const entry = grouped.get(row.productId);
        const betterName = row.displayName || row.canonicalSlug;
        if (entry && !entry.displayName && betterName) entry.displayName = betterName;
      }
      grouped.get(row.productId)?.providers.push({
        provider: row.provider as string,
        providerProductRef: row.providerProductRef,
      });
    }

    // ── Add pure Discord cross-server products (discord_role: entries, no catalog product) ──
    const roleRules = await ctx.db
      .query('role_rules')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))
      .filter((q) => q.eq(q.field('enabled'), true))
      .collect();

    for (const rule of roleRules) {
      // Discord cross-server products have no catalog entry; their productId is synthetic
      if (rule.catalogProductId) continue; // skip catalog-linked rules (those are Gumroad/Jinxxy products)
      if (!rule.productId.startsWith('discord_role:')) continue;

      const guildLink = await ctx.db.get(rule.guildLinkId);
      if (!guildLink || guildLink.status !== 'active') continue;

      if (!grouped.has(rule.productId)) {
        grouped.set(rule.productId, {
          productId: rule.productId,
          displayName: `Discord role — ${guildLink.discordGuildName ?? rule.guildId}`,
          providers: [{ provider: 'discord', providerProductRef: rule.guildId }],
        });
      }
    }

    return Array.from(grouped.values());
  },
});

export const getCachedProviderProductsForTenant = internalQuery({
  args: { authUserId: v.string() },
  returns: v.array(
    v.object({
      productId: v.string(),
      displayName: v.optional(v.string()),
      providers: v.array(v.object({ provider: v.string(), providerProductRef: v.string() })),
      configured: v.boolean(),
      live: v.boolean(),
      lastSyncedAt: v.optional(v.number()),
    })
  ),
  handler: async (ctx, args) => {
    const connections = await ctx.db
      .query('provider_connections')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))
      .collect();

    const activeConnections = connections.filter(
      (connection) => connection.status !== 'disconnected'
    );
    const mappingGroups = await Promise.all(
      activeConnections.map(async (connection) => ({
        connection,
        mappings: await ctx.db
          .query('provider_catalog_mappings')
          .withIndex('by_connection', (q) => q.eq('providerConnectionId', connection._id))
          .filter((q) => q.eq(q.field('status'), 'active'))
          .collect(),
      }))
    );

    const products: Array<{
      productId: string;
      displayName?: string;
      providers: Array<{ provider: string; providerProductRef: string }>;
      configured: boolean;
      live: boolean;
      lastSyncedAt?: number;
    }> = [];

    for (const { connection, mappings } of mappingGroups) {
      for (const mapping of mappings) {
        const providerProductRef =
          mapping.externalVariantId ??
          mapping.externalProductId ??
          mapping.externalSku ??
          mapping.externalPriceId;
        if (!providerProductRef) {
          continue;
        }

        products.push({
          productId: mapping.localProductId ?? '',
          displayName: mapping.displayName ?? undefined,
          providers: [
            {
              provider: mapping.providerKey,
              providerProductRef,
            },
          ],
          configured: Boolean(mapping.catalogProductId || mapping.localProductId),
          live: true,
          lastSyncedAt:
            mapping.lastSyncedAt ??
            connection.lastSyncAt ??
            connection.lastWebhookAt ??
            connection.updatedAt,
        });
      }
    }

    return products;
  },
});

/**
 * Get Discord user ID for a YUCP auth user by looking up their linked Better Auth Discord account.
 * Returns null if user has no Discord linked.
 * NOTE: Must be called from an httpAction since it uses components.betterAuth — see http.ts.
 */

/** Find a subject by their Discord user ID. */
export const getSubjectByDiscordUser = internalQuery({
  args: { discordUserId: v.string() },
  returns: v.union(v.null(), v.object({ _id: v.id('subjects') })),
  handler: async (ctx, args) => {
    const subject = await ctx.db
      .query('subjects')
      .withIndex('by_discord_user', (q) => q.eq('primaryDiscordUserId', args.discordUserId))
      .filter((q) => q.eq(q.field('status'), 'active'))
      .first();
    if (!subject) return null;
    return { _id: subject._id };
  },
});

/** Find a subject by Better Auth user ID. */
export const getSubjectByAuthUser = internalQuery({
  args: { authUserId: v.string() },
  returns: v.union(v.null(), v.object({ _id: v.id('subjects') })),
  handler: async (ctx, args) => {
    const subject = await ctx.db
      .query('subjects')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))
      .filter((q) => q.eq(q.field('status'), 'active'))
      .first();
    if (!subject) return null;
    return { _id: subject._id };
  },
});

/**
 * Check if a subject has an active entitlement for a specific product within a tenant.
 * Used for Discord role-based license verification — the entitlement was granted by the bot.
 */
export const checkSubjectEntitlement = internalQuery({
  args: {
    authUserId: v.string(),
    subjectId: v.id('subjects'),
    productId: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const entitlement = await ctx.db
      .query('entitlements')
      .withIndex('by_auth_user_subject', (q) =>
        q.eq('authUserId', args.authUserId).eq('subjectId', args.subjectId)
      )
      .filter((q) =>
        q.and(q.eq(q.field('productId'), args.productId), q.eq(q.field('status'), 'active'))
      )
      .first();
    return entitlement != null;
  },
});

export const verifyLicenseProof = internalAction({
  args: {
    packageId: v.string(),
    licenseKey: v.string(),
    provider: v.string(),
    productPermalink: v.string(),
  },
  returns: v.object({
    success: v.boolean(),
    error: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    if (!args.packageId || !args.licenseKey || !args.provider || !args.productPermalink) {
      return { success: false, error: 'Missing required fields' };
    }

    let verifyResult: { valid: boolean; reason?: string } | null = null;

    const product = await ctx.runQuery(internal.yucpLicenses.getProductByProviderRef, {
      provider: args.provider,
      providerProductRef: args.productPermalink,
    });

    if (product) {
      const packageReg = await ctx.runQuery(internal.packageRegistry.getRegistration, {
        packageId: args.packageId,
      });
      if (!packageReg || packageReg.yucpUserId !== product.authUserId) {
        return {
          success: false,
          error: 'Package not found or not registered to the product owner',
        };
      }

      const conn = await ctx.runQuery(internal.yucpLicenses.getProviderConnection, {
        authUserId: product.authUserId,
        provider: args.provider,
      });

      if (args.provider === 'gumroad' && conn?.credentials.oauth_access_token) {
        const token = await decryptCredential(conn.credentials.oauth_access_token);
        if (token) {
          verifyResult = await verifyGumroadLicense(args.licenseKey, args.productPermalink, token);
        }
      } else if (args.provider === 'jinxxy') {
        if (conn?.credentials.api_key) {
          const key = await decryptCredential(conn.credentials.api_key);
          if (key) {
            verifyResult = await verifyJinxxyLicense(args.licenseKey, args.productPermalink, key);
          }
        }

        if (!verifyResult?.valid) {
          const collabConns = await ctx.runQuery(internal.yucpLicenses.getCollaboratorConnections, {
            ownerAuthUserId: product.authUserId,
          });
          for (const collab of collabConns) {
            if (!collab.credentialEncrypted) continue;
            const key = await decryptCredential(collab.credentialEncrypted);
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

    if (!verifyResult?.valid) {
      return { success: false, error: verifyResult?.reason ?? 'License verification failed' };
    }

    return { success: true };
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

function normalizeWatermarkAssetPath(input: string): string {
  return input.replace(/\\/g, '/').replace(/^\/+/, '').trim();
}

function isValidWatermarkAssetPath(input: string): boolean {
  return (
    input.length > 0 &&
    input.length <= WATERMARK_ASSET_PATH_MAX_LENGTH &&
    !input.includes('|') &&
    !input.includes('\r') &&
    !input.includes('\n')
  );
}

function getWatermarkTokenLength(assetPath: string): number {
  const normalized = normalizeWatermarkAssetPath(assetPath).toLowerCase();
  if (normalized.endsWith('.png')) return 32;
  if (normalized.endsWith('.fbx')) return 8;
  return 0;
}

async function hmacSha256Hex(secret: string, input: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(input));
  return Array.from(new Uint8Array(signature))
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
  accessToken: string
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
  apiKey: string
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
// Nonce replay prevention
// =============================================================================

/**
 * Atomically check and consume a JWT nonce to prevent replay attacks.
 * Throws ConvexError if the nonce has already been used.
 */
export const checkAndConsumeNonce = internalMutation({
  args: { nonce: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query('used_nonces')
      .withIndex('by_nonce', (q) => q.eq('nonce', args.nonce))
      .first();
    if (existing) {
      throw new ConvexError('JWT nonce already used');
    }
    await ctx.db.insert('used_nonces', {
      nonce: args.nonce,
      authUserId: '',
      usedAt: Date.now(),
    });
  },
});

export const upsertProtectedAssets = internalMutation({
  args: {
    packageId: v.string(),
    contentHash: v.string(),
    packageVersion: v.optional(v.string()),
    publisherId: v.string(),
    yucpUserId: v.string(),
    certNonce: v.string(),
    protectedAssets: v.array(PROTECTED_ASSET_REGISTRATION),
  },
  handler: async (ctx, args) => {
    if (!PACKAGE_ID_RE.test(args.packageId)) {
      throw new ConvexError(`Invalid packageId format: ${args.packageId}`);
    }

    const now = Date.now();
    for (const asset of args.protectedAssets) {
      if (!PROTECTED_ASSET_ID_RE.test(asset.protectedAssetId)) {
        throw new ConvexError(`Invalid protectedAssetId format: ${asset.protectedAssetId}`);
      }
      if (asset.unlockMode === 'wrapped_content_key') {
        if (!asset.wrappedContentKey) {
          throw new ConvexError('wrappedContentKey is required for wrapped_content_key assets');
        }
      } else if (asset.unlockMode === 'content_key_b64') {
        if (!asset.contentKeyBase64) {
          throw new ConvexError('contentKeyBase64 is required for content_key_b64 assets');
        }
      }

      const encryptedContentKey =
        asset.unlockMode === 'content_key_b64' && asset.contentKeyBase64
          ? await encryptProtectedBlobContentKey(asset.contentKeyBase64)
          : undefined;

      const existing = await ctx.db
        .query('protected_assets')
        .withIndex('by_package_and_asset', (q) =>
          q.eq('packageId', args.packageId).eq('protectedAssetId', asset.protectedAssetId)
        )
        .first();

      if (existing) {
        await ctx.db.patch(existing._id, {
          unlockMode: asset.unlockMode,
          wrappedContentKey:
            asset.unlockMode === 'wrapped_content_key' ? asset.wrappedContentKey : undefined,
          encryptedContentKey,
          displayName: asset.displayName,
          contentHash: args.contentHash,
          packageVersion: args.packageVersion,
          publisherId: args.publisherId,
          yucpUserId: args.yucpUserId,
          certNonce: args.certNonce,
          updatedAt: now,
        });
      } else {
        await ctx.db.insert('protected_assets', {
          packageId: args.packageId,
          protectedAssetId: asset.protectedAssetId,
          unlockMode: asset.unlockMode,
          wrappedContentKey:
            asset.unlockMode === 'wrapped_content_key' ? asset.wrappedContentKey : undefined,
          encryptedContentKey,
          displayName: asset.displayName,
          contentHash: args.contentHash,
          packageVersion: args.packageVersion,
          publisherId: args.publisherId,
          yucpUserId: args.yucpUserId,
          certNonce: args.certNonce,
          registeredAt: now,
          updatedAt: now,
        });
      }
    }
  },
});

export const getProtectedAsset = internalQuery({
  args: {
    packageId: v.string(),
    protectedAssetId: v.string(),
  },
  returns: v.union(
    v.null(),
    v.object({
      _id: v.id('protected_assets'),
      unlockMode: v.union(v.literal('wrapped_content_key'), v.literal('content_key_b64')),
      wrappedContentKey: v.optional(v.string()),
      encryptedContentKey: v.optional(v.string()),
      yucpUserId: v.string(),
    })
  ),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query('protected_assets')
      .withIndex('by_package_and_asset', (q) =>
        q.eq('packageId', args.packageId).eq('protectedAssetId', args.protectedAssetId)
      )
      .first();
    if (!row) return null;
    const unlockMode = resolveProtectedAssetUnlockMode(row);
    return {
      _id: row._id,
      unlockMode,
      wrappedContentKey: row.wrappedContentKey,
      encryptedContentKey: row.encryptedContentKey,
      yucpUserId: row.yucpUserId,
    };
  },
});

export const recordProtectedUnlockIssuance = internalMutation({
  args: {
    packageId: v.string(),
    protectedAssetId: v.string(),
    licenseSubject: v.string(),
    machineFingerprint: v.string(),
    projectId: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await ctx.db
      .query('protected_asset_unlocks')
      .withIndex('by_package_asset_machine_project', (q) =>
        q
          .eq('packageId', args.packageId)
          .eq('protectedAssetId', args.protectedAssetId)
          .eq('machineFingerprint', args.machineFingerprint)
          .eq('projectId', args.projectId)
      )
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        licenseSubject: args.licenseSubject,
        lastIssuedAt: now,
        issueCount: existing.issueCount + 1,
      });
      return;
    }

    await ctx.db.insert('protected_asset_unlocks', {
      packageId: args.packageId,
      protectedAssetId: args.protectedAssetId,
      licenseSubject: args.licenseSubject,
      machineFingerprint: args.machineFingerprint,
      projectId: args.projectId,
      firstUnlockedAt: now,
      lastIssuedAt: now,
      issueCount: 1,
    });
  },
});

export const recordCouplingTraceIssuance = internalMutation({
  args: {
    authUserId: v.string(),
    packageId: v.string(),
    licenseSubject: v.string(),
    machineFingerprint: v.string(),
    projectId: v.string(),
    runtimeArtifactVersion: v.string(),
    runtimePlaintextSha256: v.string(),
    correlationId: v.string(),
    jobs: v.array(
      v.object({
        assetPath: v.string(),
        tokenHex: v.string(),
      })
    ),
  },
  handler: async (ctx, args) => {
    const machineFingerprintHash = await sha256Hex(args.machineFingerprint);
    const projectIdHash = await sha256Hex(args.projectId);
    const now = Date.now();

    for (const job of args.jobs) {
      await ctx.db.insert('coupling_trace_records', {
        authUserId: args.authUserId,
        packageId: args.packageId,
        licenseSubject: args.licenseSubject,
        assetPath: job.assetPath,
        tokenHash: await sha256Hex(job.tokenHex),
        tokenLength: job.tokenHex.length,
        machineFingerprintHash,
        projectIdHash,
        runtimeArtifactVersion: args.runtimeArtifactVersion,
        runtimePlaintextSha256: args.runtimePlaintextSha256,
        correlationId: args.correlationId,
        createdAt: now,
      });
    }

    await ctx.db.insert('audit_events', {
      authUserId: args.authUserId,
      eventType: 'coupling.trace.recorded',
      actorType: 'system',
      metadata: {
        packageId: args.packageId,
        licenseSubject: args.licenseSubject,
        assetCount: args.jobs.length,
        runtimeArtifactVersion: args.runtimeArtifactVersion,
      },
      correlationId: args.correlationId,
      createdAt: now,
    });

    await ctx.db.insert('audit_events', {
      authUserId: args.authUserId,
      eventType: 'coupling.unlock.issued',
      actorType: 'system',
      metadata: {
        packageId: args.packageId,
        licenseSubject: args.licenseSubject,
        assetCount: args.jobs.length,
        runtimeArtifactVersion: args.runtimeArtifactVersion,
      },
      correlationId: args.correlationId,
      createdAt: now,
    });
  },
});

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
    issuerBaseUrl: v.string(),
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
      // c62: Verify packageId is registered to the same creator that owns this product.
      // Without this, a buyer can forge the package_id claim in the issued JWT.
      const packageReg = await ctx.runQuery(internal.packageRegistry.getRegistration, {
        packageId: args.packageId,
      });
      if (!packageReg || packageReg.yucpUserId !== product.authUserId) {
        return {
          success: false,
          error: 'Package not found or not registered to the product owner',
        };
      }

      const conn = await ctx.runQuery(internal.yucpLicenses.getProviderConnection, {
        authUserId: product.authUserId,
        provider: args.provider,
      });

      if (args.provider === 'gumroad' && conn?.credentials.oauth_access_token) {
        const token = await decryptCredential(conn.credentials.oauth_access_token);
        if (token) {
          verifyResult = await verifyGumroadLicense(args.licenseKey, args.productPermalink, token);
        }
      } else if (args.provider === 'jinxxy') {
        // Try primary connection first
        if (conn?.credentials.api_key) {
          const key = await decryptCredential(conn.credentials.api_key);
          if (key) {
            verifyResult = await verifyJinxxyLicense(args.licenseKey, args.productPermalink, key);
          }
        }

        // If primary failed or missing, try collaborator connections
        if (!verifyResult?.valid) {
          const collabConns = await ctx.runQuery(internal.yucpLicenses.getCollaboratorConnections, {
            ownerAuthUserId: product.authUserId,
          });
          for (const collab of collabConns) {
            if (!collab.credentialEncrypted) continue;
            const key = await decryptCredential(collab.credentialEncrypted);
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

    // c63: No global credential fallback — only the product owner's credentials are accepted.
    // Removed: GUMROAD_ACCESS_TOKEN / JINXXY_API_KEY env-var fallback that bypassed product ownership.
    if (!verifyResult?.valid) {
      return { success: false, error: verifyResult?.reason ?? 'License verification failed' };
    }

    // 5. Issue signed license JWT
    const rootPrivateKey = process.env.YUCP_ROOT_PRIVATE_KEY;
    if (!rootPrivateKey) throw new Error('YUCP_ROOT_PRIVATE_KEY not configured');

    const issuer = buildPublicAuthIssuer(args.issuerBaseUrl);
    const iat = nowSeconds;
    const exp = iat + TOKEN_TTL_SECONDS;

    const licenseKeyHash = await sha256Hex(args.licenseKey);

    // 5a. Nonce replay check: ensure this nonce has not been used before
    const jti = args.nonce;
    await ctx.runMutation(internal.yucpLicenses.checkAndConsumeNonce, { nonce: jti });

    const claims: LicenseClaims = {
      iss: issuer,
      aud: 'yucp-license-gate',
      sub: licenseKeyHash,
      jti: jti,
      package_id: args.packageId,
      machine_fingerprint: args.machineFingerprint,
      provider: args.provider,
      iat,
      exp,
    };

    const keyId = process.env.YUCP_ROOT_KEY_ID ?? 'yucp-root';
    const token = await signLicenseJwt(claims, rootPrivateKey, keyId);

    console.log(
      `[license/verify] issued token package_id=${args.packageId} provider=${args.provider} exp=${exp}`
    );

    return { success: true, token, expiresAt: exp };
  },
});

export const issueProtectedUnlock = internalAction({
  args: {
    packageId: v.string(),
    protectedAssetId: v.string(),
    machineFingerprint: v.string(),
    projectId: v.string(),
    licenseToken: v.string(),
    issuerBaseUrl: v.string(),
  },
  returns: v.object({
    success: v.boolean(),
    unlockToken: v.optional(v.string()),
    expiresAt: v.optional(v.number()),
    error: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    if (!PACKAGE_ID_RE.test(args.packageId)) {
      return { success: false, error: 'Invalid packageId format' };
    }
    if (!PROTECTED_ASSET_ID_RE.test(args.protectedAssetId)) {
      return { success: false, error: 'Invalid protected asset identifier' };
    }
    if (!MACHINE_FINGERPRINT_RE.test(args.machineFingerprint)) {
      return { success: false, error: 'Invalid machine fingerprint' };
    }
    if (!PROJECT_ID_RE.test(args.projectId)) {
      return { success: false, error: 'Invalid project identifier' };
    }
    if (!args.licenseToken) {
      return { success: false, error: 'licenseToken is required' };
    }

    const rootPrivateKey = process.env.YUCP_ROOT_PRIVATE_KEY;
    if (!rootPrivateKey) throw new Error('YUCP_ROOT_PRIVATE_KEY not configured');

    const issuer = buildPublicAuthIssuer(args.issuerBaseUrl);
    const rootPublicKey =
      process.env.YUCP_ROOT_PUBLIC_KEY ?? (await getPublicKeyFromPrivate(rootPrivateKey));
    const licenseClaims = await verifyLicenseJwt(args.licenseToken, rootPublicKey, issuer);

    if (!licenseClaims) {
      return { success: false, error: 'License token is invalid or expired' };
    }
    if (licenseClaims.package_id !== args.packageId) {
      return { success: false, error: 'License token package mismatch' };
    }
    if (licenseClaims.machine_fingerprint !== args.machineFingerprint) {
      return { success: false, error: 'License token machine mismatch' };
    }

    const protectedAsset = await ctx.runQuery(internal.yucpLicenses.getProtectedAsset, {
      packageId: args.packageId,
      protectedAssetId: args.protectedAssetId,
    });
    if (!protectedAsset) {
      return { success: false, error: 'Protected asset registration not found' };
    }

    const packageReg = await ctx.runQuery(internal.packageRegistry.getRegistration, {
      packageId: args.packageId,
    });
    if (!packageReg || packageReg.yucpUserId !== protectedAsset.yucpUserId) {
      return { success: false, error: 'Protected asset owner mismatch' };
    }

    await ctx.runMutation(internal.yucpLicenses.recordProtectedUnlockIssuance, {
      packageId: args.packageId,
      protectedAssetId: args.protectedAssetId,
      licenseSubject: licenseClaims.sub,
      machineFingerprint: args.machineFingerprint,
      projectId: args.projectId,
    });

    const nowSeconds = Math.floor(Date.now() / 1000);
    const exp = nowSeconds + PROTECTED_UNLOCK_TTL_SECONDS;
    const keyId = process.env.YUCP_ROOT_KEY_ID ?? 'yucp-root';
    const contentKeyB64 =
      protectedAsset.unlockMode === 'content_key_b64' && protectedAsset.encryptedContentKey
        ? await decryptProtectedBlobContentKey(protectedAsset.encryptedContentKey)
        : undefined;
    const claims: ProtectedUnlockClaims = {
      iss: issuer,
      aud: 'yucp-protected-unlock',
      sub: licenseClaims.sub,
      jti: crypto.randomUUID(),
      package_id: args.packageId,
      protected_asset_id: args.protectedAssetId,
      machine_fingerprint: args.machineFingerprint,
      project_id: args.projectId,
      unlock_mode: protectedAsset.unlockMode,
      wrapped_content_key:
        protectedAsset.unlockMode === 'wrapped_content_key'
          ? protectedAsset.wrappedContentKey
          : undefined,
      content_key_b64: protectedAsset.unlockMode === 'content_key_b64' ? contentKeyB64 : undefined,
      iat: nowSeconds,
      exp,
    };

    const unlockToken = await signProtectedUnlockJwt(claims, rootPrivateKey, keyId);
    return { success: true, unlockToken, expiresAt: exp };
  },
});

export const issueCouplingJob = internalAction({
  args: {
    packageId: v.string(),
    machineFingerprint: v.string(),
    projectId: v.string(),
    licenseToken: v.string(),
    assetPaths: v.array(v.string()),
    issuerBaseUrl: v.string(),
  },
  returns: v.object({
    success: v.boolean(),
    subject: v.optional(v.string()),
    jobs: v.optional(
      v.array(
        v.object({
          assetPath: v.string(),
          tokenHex: v.string(),
        })
      )
    ),
    skipReason: v.optional(v.string()),
    error: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    if (!PACKAGE_ID_RE.test(args.packageId)) {
      return { success: false, error: 'Invalid packageId format' };
    }
    if (!MACHINE_FINGERPRINT_RE.test(args.machineFingerprint)) {
      return { success: false, error: 'Invalid machine fingerprint' };
    }
    if (!PROJECT_ID_RE.test(args.projectId)) {
      return { success: false, error: 'Invalid project identifier' };
    }
    if (!args.licenseToken) {
      return { success: false, error: 'licenseToken is required' };
    }
    if (!Array.isArray(args.assetPaths) || args.assetPaths.length === 0) {
      return { success: false, error: 'At least one asset path is required' };
    }
    if (args.assetPaths.length > 512) {
      return { success: false, error: 'Too many coupling asset paths in one request' };
    }

    const rootPrivateKey = process.env.YUCP_ROOT_PRIVATE_KEY;
    if (!rootPrivateKey) throw new Error('YUCP_ROOT_PRIVATE_KEY not configured');

    const issuer = buildPublicAuthIssuer(args.issuerBaseUrl);
    const rootPublicKey =
      process.env.YUCP_ROOT_PUBLIC_KEY ?? (await getPublicKeyFromPrivate(rootPrivateKey));
    const licenseClaims = await verifyLicenseJwt(args.licenseToken, rootPublicKey, issuer);

    if (!licenseClaims) {
      return { success: false, error: 'License token is invalid or expired' };
    }
    if (licenseClaims.package_id !== args.packageId) {
      return { success: false, error: 'License token package mismatch' };
    }
    if (licenseClaims.machine_fingerprint !== args.machineFingerprint) {
      return { success: false, error: 'License token machine mismatch' };
    }

    const packageReg = await ctx.runQuery(internal.packageRegistry.getRegistration, {
      packageId: args.packageId,
    });
    if (!packageReg) {
      return { success: false, error: 'Package registration not found' };
    }

    const creatorCanTrace = await ctx.runQuery(
      internal.certificateBilling.hasCapabilityForAuthUser,
      {
        authUserId: packageReg.yucpUserId,
        capabilityKey: BILLING_CAPABILITY_KEYS.couplingTraceability,
      }
    );
    if (!creatorCanTrace) {
      return {
        success: true,
        subject: licenseClaims.sub,
        jobs: [],
        skipReason: 'capability_disabled',
      };
    }

    const watermarkSecret = process.env.YUCP_WATERMARK_HMAC_KEY ?? rootPrivateKey;
    const jobs: Array<{ assetPath: string; tokenHex: string }> = [];
    const seen = new Set<string>();

    for (const rawAssetPath of args.assetPaths) {
      const assetPath = normalizeWatermarkAssetPath(rawAssetPath ?? '');
      if (!isValidWatermarkAssetPath(assetPath)) {
        return { success: false, error: `Invalid coupling asset path: ${rawAssetPath ?? ''}` };
      }
      if (seen.has(assetPath)) {
        continue;
      }
      seen.add(assetPath);

      const tokenLength = getWatermarkTokenLength(assetPath);
      if (tokenLength <= 0) {
        continue;
      }

      const tokenInput = [
        args.packageId,
        licenseClaims.sub,
        args.machineFingerprint,
        args.projectId,
        assetPath,
      ].join('|');
      const tokenHex = (await hmacSha256Hex(watermarkSecret, tokenInput)).slice(0, tokenLength);
      jobs.push({ assetPath, tokenHex });
    }

    const activeRuntimeArtifact = await ctx.runQuery(internal.releaseArtifacts.getActiveArtifact, {
      artifactKey: RELEASE_ARTIFACT_KEYS.couplingRuntime,
      channel: RELEASE_CHANNELS.stable,
      platform: RELEASE_PLATFORMS.winX64,
    });
    if (!activeRuntimeArtifact) {
      return { success: false, error: 'Coupling runtime is not configured on the server' };
    }

    const correlationId = crypto.randomUUID();
    await ctx.runMutation(internal.yucpLicenses.recordCouplingTraceIssuance, {
      authUserId: packageReg.yucpUserId,
      packageId: args.packageId,
      licenseSubject: licenseClaims.sub,
      machineFingerprint: args.machineFingerprint,
      projectId: args.projectId,
      runtimeArtifactVersion: activeRuntimeArtifact.version,
      runtimePlaintextSha256: activeRuntimeArtifact.plaintextSha256,
      correlationId,
      jobs,
    });

    return {
      success: true,
      subject: licenseClaims.sub,
      jobs,
    };
  },
});
