/**
 * YUCP License Gate, Unity editor license verification endpoint.
 *
 * Verifies a purchase license for a specific YUCP package,
 * then returns a short-lived signed JWT that the Unity client caches locally.
 * The JWT is machine-fingerprint-bound so it cannot be shared between machines.
 *
 * Credential resolution order:
 *   1. Look up product in product_catalog by providerProductRef -> get owner authUserId
 *   2. Resolve the provider runtime for that store
 *   3. Let the provider-owned verification module validate the license
 *
 * Flow:
 *   Unity client  ->  POST /v1/licenses/verify  ->  provider-owned verification runtime
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

import { sha256Hex } from '@yucp/shared/crypto';
import { ConvexError, v } from 'convex/values';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  query,
} from './_generated/server';
import { requireApiSecret } from './lib/apiAuth';
import { PII_PURPOSES } from './lib/credentialKeys';
import { upsertLicenseSubjectLink } from './lib/licenseSubjectLink';
import { encryptPii } from './lib/piiCrypto';
import {
  decryptProtectedBlobContentKey,
  encryptProtectedBlobContentKey,
} from './lib/protectedAssetKeyCrypto';
import { resolveProtectedAssetUnlockMode } from './lib/protectedAssetUnlockMode';
import { verifyLicenseWithProviderRuntime } from './lib/providerLicenseVerification';
import { buildPublicAuthIssuer, resolveConfiguredPublicApiBaseUrl } from './lib/publicAuthIssuer';
import {
  RELEASE_ARTIFACT_KEYS,
  RELEASE_CHANNELS,
  RELEASE_PLATFORMS,
} from './lib/releaseArtifactKeys';
import {
  type CouplingRuntimeArtifactClaims,
  type CouplingRuntimeClaims,
  type LicenseClaims,
  type ProtectedUnlockClaims,
  resolvePinnedYucpSigningRoot,
  signCouplingRuntimeArtifactJwt,
  signCouplingRuntimeJwt,
  signLicenseJwt,
  signProtectedUnlockJwt,
  verifyLicenseJwtAgainstPinnedRoots,
  verifyProtectedUnlockJwtAgainstPinnedRoots,
} from './lib/yucpCrypto';

const TOKEN_TTL_SECONDS = 3600; // 1 hour -- kept short; disk cache handles offline re-use
const PROTECTED_UNLOCK_TTL_SECONDS = 10 * 60;
const COUPLING_ASSET_PATH_MAX_LENGTH = 512;
const MAX_PROTECTED_ASSETS_PER_REQUEST = 100;
const MAX_MANUAL_LICENSE_KEY_LENGTH = 4_096;
const COUPLING_SEED_RELAY_TIMEOUT_MS = 5_000;
const COUPLING_SEED_RELAY_RESPONSE_MAX_CHARS = 256 * 1024;
const PACKAGE_ID_RE = /^[a-z0-9\-_./:]{1,128}$/;
const PROTECTED_ASSET_ID_RE = /^[a-f0-9]{32}$/;
const MACHINE_FINGERPRINT_RE = /^[a-z0-9:_-]{16,256}$/i;
const PROJECT_ID_RE = /^[a-f0-9]{32}$/;
const CONTENT_HASH_RE = /^[0-9a-f]{64}$/;

type ManualLicenseHashVerificationResult =
  | { valid: true; licenseId: Id<'manual_licenses'> }
  | { valid: false };

type LicenseProofResult = {
  success: boolean;
  error?: string;
  manualLicenseId?: Id<'manual_licenses'>;
  creatorAuthUserId?: string;
  productId?: string;
  catalogProductId?: Id<'product_catalog'>;
};

async function hashManualLicenseKey(licenseKey: string): Promise<string> {
  const encryptionSecret = process.env.ENCRYPTION_SECRET;
  if (!encryptionSecret) {
    throw new Error('ENCRYPTION_SECRET is required for manual license verification');
  }

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(encryptionSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(licenseKey));
  return Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function getPinnedSigningRoot(configuredKeyId?: string | null): Promise<{
  keyId: string;
  publicKeyBase64: string;
  privateKeyBase64: string;
}> {
  const rootPrivateKey = process.env.YUCP_ROOT_PRIVATE_KEY;
  if (!rootPrivateKey) {
    throw new Error('YUCP_ROOT_PRIVATE_KEY not configured');
  }

  const signingRoot = await resolvePinnedYucpSigningRoot(rootPrivateKey, configuredKeyId);
  return {
    keyId: signingRoot.keyId,
    publicKeyBase64: signingRoot.publicKeyBase64,
    privateKeyBase64: rootPrivateKey,
  };
}

type ProductByProviderRefResult = {
  authUserId: string;
  productId: string;
  catalogProductId: Id<'product_catalog'>;
  displayName?: string;
} | null;
const PROTECTED_ASSET_REGISTRATION = v.object({
  protectedAssetId: v.string(),
  unlockMode: v.union(v.literal('wrapped_content_key'), v.literal('content_key_b64')),
  wrappedContentKey: v.optional(v.string()),
  contentKeyBase64: v.optional(v.string()),
  contentHash: v.optional(v.string()),
  manifestBindingSha256: v.optional(v.string()),
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
      catalogProductId: v.id('product_catalog'),
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
    return {
      authUserId: row.authUserId,
      productId: row.productId,
      catalogProductId: row._id,
      displayName: row.displayName,
    };
  },
});

/**
 * Find a creator-owned product by its provider reference.
 *
 * Manual license intent requirements already identify the creator and local
 * product. Querying through that owner scope prevents another creator's
 * matching provider reference from changing the proof target.
 */
export const getProductByProviderRefForCreator = internalQuery({
  args: {
    authUserId: v.string(),
    provider: v.string(),
    providerProductRef: v.string(),
  },
  returns: v.union(
    v.null(),
    v.object({
      authUserId: v.string(),
      productId: v.string(),
      catalogProductId: v.id('product_catalog'),
      displayName: v.optional(v.string()),
    })
  ),
  handler: async (ctx, args): Promise<ProductByProviderRefResult> => {
    const row = await ctx.db
      .query('product_catalog')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))
      .filter((q) =>
        q.and(
          q.eq(q.field('provider'), args.provider),
          q.eq(q.field('providerProductRef'), args.providerProductRef),
          q.eq(q.field('status'), 'active')
        )
      )
      .first();
    if (!row) return null;
    return {
      authUserId: row.authUserId,
      productId: row.productId,
      catalogProductId: row._id,
      displayName: row.displayName,
    };
  },
});

export const lookupProductByProviderRef = query({
  args: {
    apiSecret: v.string(),
    provider: v.string(),
    providerProductRef: v.string(),
  },
  returns: v.union(
    v.null(),
    v.object({
      authUserId: v.string(),
      productId: v.string(),
      catalogProductId: v.id('product_catalog'),
      displayName: v.optional(v.string()),
    })
  ),
  handler: async (ctx, args): Promise<ProductByProviderRefResult> => {
    requireApiSecret(args.apiSecret);
    return await ctx.runQuery(internal.yucpLicenses.getProductByProviderRef, {
      provider: args.provider,
      providerProductRef: args.providerProductRef,
    });
  },
});

export const verifyManualLicenseByHash = internalQuery({
  args: {
    authUserId: v.string(),
    productId: v.string(),
    licenseKeyHash: v.string(),
  },
  returns: v.union(
    v.object({ valid: v.literal(true), licenseId: v.id('manual_licenses') }),
    v.object({ valid: v.literal(false) })
  ),
  handler: async (ctx, args): Promise<ManualLicenseHashVerificationResult> => {
    const licenses = await ctx.db
      .query('manual_licenses')
      .withIndex('by_license_key_hash', (q) => q.eq('licenseKeyHash', args.licenseKeyHash))
      .collect();
    const license = licenses.find(
      (candidate) =>
        candidate.authUserId === args.authUserId && candidate.productId === args.productId
    );

    if (!license) {
      return { valid: false as const };
    }
    if (license.status === 'revoked') {
      return { valid: false as const };
    }

    // Exhausted and expired licenses can prove an existing redemption only.
    // The atomic completion mutation rechecks consumability and permits these
    // rows exclusively when this buyer already has the matching entitlement.
    return { valid: true as const, licenseId: license._id };
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
  returns: v.array(
    v.object({
      id: v.string(),
      provider: v.string(),
      credentialEncrypted: v.optional(v.string()),
      collaboratorDisplayName: v.optional(v.string()),
    })
  ),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('collaborator_connections')
      .withIndex('by_owner_status', (q) =>
        q.eq('ownerAuthUserId', args.ownerAuthUserId).eq('status', 'active')
      )
      .collect();
    return rows
      .filter((r) => r.credentialEncrypted)
      .map((r) => ({
        id: r._id,
        provider: r.provider,
        credentialEncrypted: r.credentialEncrypted,
        collaboratorDisplayName: r.collaboratorDisplayName,
      }));
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
          displayName: `Discord role, ${guildLink.discordGuildName ?? rule.guildId}`,
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
 * NOTE: Must be called from an httpAction since it uses components.betterAuth, see http.ts.
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
 * Used for Discord role-based license verification, the entitlement was granted by the bot.
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
    creatorAuthUserId: v.optional(v.string()),
    productId: v.optional(v.string()),
  },
  returns: v.object({
    success: v.boolean(),
    error: v.optional(v.string()),
    manualLicenseId: v.optional(v.id('manual_licenses')),
    creatorAuthUserId: v.optional(v.string()),
    productId: v.optional(v.string()),
    catalogProductId: v.optional(v.id('product_catalog')),
  }),
  handler: async (ctx, args): Promise<LicenseProofResult> => {
    if (!args.packageId || !args.licenseKey || !args.provider || !args.productPermalink) {
      return { success: false, error: 'Missing required fields' };
    }
    if (args.provider === 'manual' && args.licenseKey.length > MAX_MANUAL_LICENSE_KEY_LENGTH) {
      return { success: false, error: 'License verification failed' };
    }

    let verifyResult: { valid: boolean; reason?: string } | null = null;

    const product =
      args.provider === 'manual' && args.creatorAuthUserId && args.productId
        ? await ctx.runQuery(internal.yucpLicenses.getProductByProviderRefForCreator, {
            authUserId: args.creatorAuthUserId,
            provider: args.provider,
            providerProductRef: args.productPermalink,
          })
        : await ctx.runQuery(internal.yucpLicenses.getProductByProviderRef, {
            provider: args.provider,
            providerProductRef: args.productPermalink,
          });

    if (product) {
      if (args.creatorAuthUserId || args.productId) {
        if (args.creatorAuthUserId !== product.authUserId || args.productId !== product.productId) {
          return {
            success: false,
            error: 'Verification method points at a different creator product',
          };
        }
      } else {
        const packageReg = await ctx.runQuery(internal.packageRegistry.getRegistration, {
          packageId: args.packageId,
        });
        if (!packageReg || packageReg.yucpUserId !== product.authUserId) {
          return {
            success: false,
            error: 'Package not found or not registered to the product owner',
          };
        }
      }

      if (args.provider === 'manual') {
        const manualLicense = await ctx.runQuery(internal.yucpLicenses.verifyManualLicenseByHash, {
          authUserId: product.authUserId,
          productId: product.productId,
          licenseKeyHash: await hashManualLicenseKey(args.licenseKey),
        });
        if (!manualLicense.valid) {
          return { success: false, error: 'License verification failed' };
        }
        return {
          success: true,
          manualLicenseId: manualLicense.licenseId,
          creatorAuthUserId: product.authUserId,
          productId: product.productId,
          catalogProductId: product.catalogProductId,
        };
      }

      verifyResult = await verifyLicenseWithProviderRuntime(ctx, {
        provider: args.provider,
        licenseKey: args.licenseKey,
        providerProductRef: args.productPermalink,
        authUserId: product.authUserId,
      });
    }

    if (!verifyResult?.valid) {
      return { success: false, error: verifyResult?.reason ?? 'License verification failed' };
    }

    return { success: true };
  },
});

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
    if (args.protectedAssets.length > MAX_PROTECTED_ASSETS_PER_REQUEST) {
      throw new ConvexError(
        `Maximum of ${MAX_PROTECTED_ASSETS_PER_REQUEST} protected assets per request`
      );
    }

    const now = Date.now();
    for (const asset of args.protectedAssets) {
      if (!PROTECTED_ASSET_ID_RE.test(asset.protectedAssetId)) {
        throw new ConvexError(`Invalid protectedAssetId format: ${asset.protectedAssetId}`);
      }
      const assetContentHash = asset.contentHash ?? args.contentHash;
      if (!CONTENT_HASH_RE.test(assetContentHash)) {
        throw new ConvexError('contentHash must be 64 lowercase hex characters');
      }
      if (
        asset.manifestBindingSha256 !== undefined &&
        !CONTENT_HASH_RE.test(asset.manifestBindingSha256)
      ) {
        throw new ConvexError('manifestBindingSha256 must be 64 lowercase hex characters');
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
          contentHash: assetContentHash,
          manifestBindingSha256: asset.manifestBindingSha256,
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
          contentHash: assetContentHash,
          manifestBindingSha256: asset.manifestBindingSha256,
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
      contentHash: v.string(),
      manifestBindingSha256: v.optional(v.string()),
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
      contentHash: row.contentHash,
      manifestBindingSha256: row.manifestBindingSha256,
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

export const recordLicenseSubjectLink = internalMutation({
  args: {
    licenseSubject: v.string(),
    authUserId: v.string(),
    packageId: v.optional(v.string()),
    provider: v.string(),
    licenseKey: v.optional(v.string()),
    licenseKeyEncrypted: v.optional(v.string()),
    purchaserEmail: v.optional(v.string()),
    providerUserId: v.optional(v.string()),
    externalOrderId: v.optional(v.string()),
    providerProductId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const licenseKeyEncrypted =
      args.licenseKeyEncrypted ??
      (await encryptPii(args.licenseKey, PII_PURPOSES.forensicsLicenseKey));

    await upsertLicenseSubjectLink(ctx, {
      authUserId: args.authUserId,
      licenseSubject: args.licenseSubject,
      packageId: args.packageId,
      provider: args.provider,
      licenseKeyEncrypted,
      providerUserId: args.providerUserId,
      externalOrderId: args.externalOrderId,
      providerProductId: args.providerProductId,
    });
  },
});

export const recordProtectedMaterializationReceipt = internalMutation({
  args: {
    grantId: v.string(),
    authUserId: v.string(),
    machineFingerprint: v.string(),
    projectId: v.string(),
  },
  returns: v.object({
    success: v.boolean(),
    updatedCount: v.number(),
    error: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    const machineFingerprintHash = await sha256Hex(args.machineFingerprint);
    const projectIdHash = await sha256Hex(args.projectId);
    const grantRows = await ctx.db
      .query('coupling_trace_records')
      .withIndex('by_grant_id', (q) => q.eq('grantId', args.grantId))
      .collect();

    const matchingRows = grantRows.filter(
      (row) =>
        row.authUserId === args.authUserId &&
        row.machineFingerprintHash === machineFingerprintHash &&
        row.projectIdHash === projectIdHash
    );

    if (matchingRows.length === 0) {
      return {
        success: false,
        updatedCount: 0,
        error: 'Protected materialization grant receipt did not match any issued traces',
      };
    }

    const now = Date.now();
    for (const row of matchingRows) {
      await ctx.db.patch(row._id, {
        grantIssuanceStatus: 'receipted',
        grantReceiptedAt: now,
      });
    }

    await ctx.db.insert('audit_events', {
      authUserId: args.authUserId,
      eventType: 'protected.materialization.grant.receipted',
      actorType: 'system',
      metadata: {
        grantId: args.grantId,
        packageId: matchingRows[0]?.packageId,
        licenseSubject: matchingRows[0]?.licenseSubject,
        assetCount: matchingRows.length,
      },
      correlationId: matchingRows[0]?.correlationId ?? crypto.randomUUID(),
      createdAt: now,
    });

    return {
      success: true,
      updatedCount: matchingRows.length,
    };
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
    let verifyResult: {
      valid: boolean;
      purchaserEmail?: string;
      providerUserId?: string;
      externalOrderId?: string;
      providerProductId?: string;
      reason?: string;
    } | null = null;
    let productAuthUserId: string | null = null;

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

      productAuthUserId = product.authUserId;

      verifyResult = await verifyLicenseWithProviderRuntime(ctx, {
        provider: args.provider,
        licenseKey: args.licenseKey,
        providerProductRef: args.productPermalink,
        authUserId: product.authUserId,
      });
    }

    // c63: No global credential fallback, only the product owner's credentials are accepted.
    // Removed: GUMROAD_ACCESS_TOKEN / JINXXY_API_KEY env-var fallback that bypassed product ownership.
    if (!verifyResult?.valid) {
      return { success: false, error: verifyResult?.reason ?? 'License verification failed' };
    }

    // 5. Issue signed license JWT
    const signingRoot = await getPinnedSigningRoot(process.env.YUCP_ROOT_KEY_ID ?? null);

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

    const token = await signLicenseJwt(claims, signingRoot.privateKeyBase64, signingRoot.keyId);

    // 5b. Store the license subject link for forensics lookups (best-effort, does not fail the request).
    if (
      productAuthUserId &&
      (verifyResult.purchaserEmail ||
        verifyResult.providerProductId ||
        args.licenseKey ||
        verifyResult.providerUserId ||
        verifyResult.externalOrderId)
    ) {
      try {
        await ctx.runMutation(internal.yucpLicenses.recordLicenseSubjectLink, {
          licenseSubject: licenseKeyHash,
          authUserId: productAuthUserId,
          provider: args.provider,
          licenseKeyEncrypted: await encryptPii(args.licenseKey, PII_PURPOSES.forensicsLicenseKey),
          providerProductId: verifyResult.providerProductId,
        });
      } catch {
        // Non-fatal: forensics data is best-effort
      }
    }

    console.log(
      `[license/verify] issued token package_id=${args.packageId} provider=${args.provider} exp=${exp}`
    );

    return { success: true, token, expiresAt: exp };
  },
});

/**
 * Resolves the active entitlement for an alias/VPM buyer so the install-plan can
 * mint a machine-bound license token. Returns the canonical license subject (when
 * the grant was license-verified) and the source provider for the token claim.
 */
export const resolveAliasInstallLicenseContext = internalQuery({
  args: {
    creatorAuthUserId: v.string(),
    subjectId: v.id('subjects'),
    catalogProductId: v.id('product_catalog'),
  },
  returns: v.object({
    active: v.boolean(),
    licenseSubject: v.optional(v.string()),
    provider: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    const entitlement = await ctx.db
      .query('entitlements')
      .withIndex('by_auth_user_subject', (q) =>
        q.eq('authUserId', args.creatorAuthUserId).eq('subjectId', args.subjectId)
      )
      .filter((q) => q.eq(q.field('catalogProductId'), args.catalogProductId))
      .filter((q) => q.eq(q.field('status'), 'active'))
      .first();

    if (!entitlement) {
      return { active: false };
    }

    return {
      active: true,
      licenseSubject: entitlement.licenseSubject,
      provider: entitlement.sourceProvider,
    };
  },
});

/**
 * Mints a short-lived, machine-fingerprint-bound license token for an entitled
 * alias/VPM buyer at install-plan time. The token's `sub` re-uses the buyer's
 * canonical license subject (when present) so a later coupling watermark resolves
 * back to the specific license + buyer; otherwise it falls back to a deterministic
 * non-license subject so attribution still binds to the buyer/product.
 *
 * Security: entitlement re-checked here; token machine-bound, short TTL, `jti`
 * consumed against used_nonces. Never logs the token.
 */
export const issueAliasInstallLicenseToken = action({
  args: {
    apiSecret: v.string(),
    creatorAuthUserId: v.string(),
    subjectId: v.id('subjects'),
    catalogProductId: v.id('product_catalog'),
    packageId: v.string(),
    machineFingerprint: v.string(),
  },
  returns: v.object({
    success: v.boolean(),
    token: v.optional(v.string()),
    expiresAt: v.optional(v.number()),
    error: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    if (!PACKAGE_ID_RE.test(args.packageId)) {
      return { success: false, error: 'Invalid package id' };
    }
    if (!MACHINE_FINGERPRINT_RE.test(args.machineFingerprint)) {
      return { success: false, error: 'Invalid machine fingerprint' };
    }

    // Derive the issuer exactly like POST /v1/licenses/verify so the token's `iss`
    // matches what the client pins.
    const issuerBaseUrl = resolveConfiguredPublicApiBaseUrl();
    if (!issuerBaseUrl) {
      return { success: false, error: 'Service not configured' };
    }

    const context = await ctx.runQuery(internal.yucpLicenses.resolveAliasInstallLicenseContext, {
      creatorAuthUserId: args.creatorAuthUserId,
      subjectId: args.subjectId,
      catalogProductId: args.catalogProductId,
    });
    if (!context.active) {
      return { success: false, error: 'No active entitlement for this product' };
    }

    // Re-use the buyer's canonical license subject when the grant was license-verified
    // so coupling forensics can resolve the specific license; otherwise bind a
    // deterministic non-license subject to the buyer/product for buyer attribution.
    const sub =
      context.licenseSubject ??
      (await sha256Hex(
        `alias-fallback:${args.creatorAuthUserId}:${args.subjectId}:${args.catalogProductId}`
      ));

    const signingRoot = await getPinnedSigningRoot(process.env.YUCP_ROOT_KEY_ID ?? null);
    const issuer = buildPublicAuthIssuer(issuerBaseUrl);
    const iat = Math.floor(Date.now() / 1000);
    const exp = iat + TOKEN_TTL_SECONDS;
    const jti = crypto.randomUUID();
    await ctx.runMutation(internal.yucpLicenses.checkAndConsumeNonce, { nonce: jti });

    const claims: LicenseClaims = {
      iss: issuer,
      aud: 'yucp-license-gate',
      sub,
      jti,
      package_id: args.packageId,
      machine_fingerprint: args.machineFingerprint,
      provider: context.provider ?? 'alias',
      iat,
      exp,
    };

    const token = await signLicenseJwt(claims, signingRoot.privateKeyBase64, signingRoot.keyId);
    return { success: true, token, expiresAt: exp };
  },
});

const COUPLING_RUNTIME_TOKEN_TTL_SECONDS = 10 * 60;

/** Inserts one coupling_trace_records row per coupled asset (hash-only forensics). */
export const recordCouplingTraces = internalMutation({
  args: {
    authUserId: v.string(),
    packageId: v.string(),
    licenseSubject: v.string(),
    provider: v.optional(v.string()),
    machineFingerprintHash: v.string(),
    projectIdHash: v.string(),
    runtimeArtifactVersion: v.string(),
    runtimePlaintextSha256: v.string(),
    correlationId: v.string(),
    entries: v.array(
      v.object({ assetPath: v.string(), tokenHash: v.string(), tokenLength: v.number() })
    ),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    for (const entry of args.entries) {
      await ctx.db.insert('coupling_trace_records', {
        authUserId: args.authUserId,
        packageId: args.packageId,
        licenseSubject: args.licenseSubject,
        assetPath: entry.assetPath,
        tokenHash: entry.tokenHash,
        tokenLength: entry.tokenLength,
        machineFingerprintHash: args.machineFingerprintHash,
        projectIdHash: args.projectIdHash,
        runtimeArtifactVersion: args.runtimeArtifactVersion,
        runtimePlaintextSha256: args.runtimePlaintextSha256,
        correlationId: args.correlationId,
        createdAt: now,
        provider: args.provider,
      });
    }
    return null;
  },
});

/**
 * Issues per-asset coupling tokens for an entitled VPM/alias install and records the
 * forensic traces. Validates the machine-bound license token server-side and binds the
 * traces to the token's licenseSubject so a later watermark hit resolves to the buyer.
 *
 * Self-guarding: if no coupling-runtime artifact is active, returns success with no files
 * (skipReason) so the importer skips coupling instead of failing the install.
 */

/**
 * Asks the closed coupling service to derive the per-(asset, buyer) placement seeds. Returns a
 * map of assetPath -> seedHex, or null when the service is unconfigured/unreachable (caller then
 * skips coupling rather than blocking the install). The watermark master never lives in this
 * open-source server.
 */
const COUPLING_SEED_RELAY_HTTP_LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function isAllowedCouplingSeedRelayEndpoint(endpoint: URL): boolean {
  if (endpoint.username || endpoint.password) {
    return false;
  }
  if (endpoint.protocol === 'https:') {
    return true;
  }
  return (
    endpoint.protocol === 'http:' && COUPLING_SEED_RELAY_HTTP_LOOPBACK_HOSTS.has(endpoint.hostname)
  );
}

async function readBoundedResponseText(
  response: Response,
  maxBytes: number
): Promise<string | null> {
  if (!response.body) {
    const text = await response.text();
    return text.length <= maxBytes ? text : null;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let bytesRead = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      bytesRead += value.byteLength;
      if (bytesRead > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
  } finally {
    reader.releaseLock();
  }
  const text = chunks.join('');
  return text.length <= maxBytes ? text : null;
}

async function deriveCouplingSeeds(
  licenseSubject: string,
  assetPaths: string[]
): Promise<Map<string, string> | null> {
  const baseUrl = process.env.YUCP_COUPLING_SERVICE_BASE_URL?.trim();
  const secret =
    process.env.YUCP_COUPLING_SERVICE_SHARED_SECRET?.trim() ||
    process.env.COUPLING_SERVICE_SECRET?.trim();
  if (!baseUrl || !secret) {
    return null;
  }
  let endpoint: URL;
  try {
    endpoint = new URL(
      'v1/coupling/internal/derive-seeds',
      baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
    );
  } catch {
    return null;
  }
  if (!isAllowedCouplingSeedRelayEndpoint(endpoint)) {
    return null;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), COUPLING_SEED_RELAY_TIMEOUT_MS);
  try {
    const res = await fetch(endpoint.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ licenseSubject, assetPaths }),
      redirect: 'error',
      signal: controller.signal,
    });
    if (!res.ok) {
      return null;
    }
    const text = await readBoundedResponseText(res, COUPLING_SEED_RELAY_RESPONSE_MAX_CHARS);
    if (!text) {
      return null;
    }
    const data = JSON.parse(text) as { seeds?: { assetPath: string; seedHex: string }[] };
    if (!Array.isArray(data?.seeds)) {
      return null;
    }
    const map = new Map<string, string>();
    for (const seed of data.seeds) {
      if (seed?.assetPath && /^[0-9a-f]{64}$/i.test(seed?.seedHex ?? '')) {
        map.set(seed.assetPath, seed.seedHex.toLowerCase());
      }
    }
    return map;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

type CouplingLicenseVerificationResult =
  | { success: true; issuer: string; claims: LicenseClaims; error?: undefined }
  | { success: false; issuer?: undefined; claims?: undefined; error: string };

async function verifyCouplingJobLicenseClaims(args: {
  packageId: string;
  machineFingerprint: string;
  licenseToken: string;
}): Promise<CouplingLicenseVerificationResult> {
  const publicIssuerBaseUrl = resolveConfiguredPublicApiBaseUrl();
  if (!publicIssuerBaseUrl) {
    return { success: false, error: 'Service not configured' };
  }

  const issuer = buildPublicAuthIssuer(publicIssuerBaseUrl);
  const claims = await verifyLicenseJwtAgainstPinnedRoots(args.licenseToken, issuer);
  if (!claims) {
    return { success: false, error: 'License token is invalid or expired' };
  }
  if (claims.package_id !== args.packageId) {
    return { success: false, error: 'License token package mismatch' };
  }
  if (claims.machine_fingerprint !== args.machineFingerprint) {
    return { success: false, error: 'License token machine mismatch' };
  }

  return { success: true, issuer, claims };
}

export const issueCouplingJob = internalAction({
  args: {
    packageId: v.string(),
    projectId: v.string(),
    machineFingerprint: v.string(),
    licenseToken: v.string(),
    assetPaths: v.array(v.string()),
    issuerBaseUrl: v.string(),
  },
  returns: v.object({
    success: v.boolean(),
    runtimeToken: v.optional(v.string()),
    runtimeSha256: v.optional(v.string()),
    expiresAt: v.optional(v.number()),
    skipReason: v.optional(v.string()),
    error: v.optional(v.string()),
    files: v.optional(
      v.array(v.object({ assetPath: v.string(), tokenHex: v.string(), seedHex: v.string() }))
    ),
  }),
  handler: async (
    ctx,
    args
  ): Promise<{
    success: boolean;
    runtimeToken?: string;
    runtimeSha256?: string;
    expiresAt?: number;
    skipReason?: string;
    error?: string;
    files?: { assetPath: string; tokenHex: string; seedHex: string }[];
  }> => {
    if (!PACKAGE_ID_RE.test(args.packageId)) {
      return { success: false, error: 'Invalid packageId format' };
    }
    if (!PROJECT_ID_RE.test(args.projectId)) {
      return { success: false, error: 'Invalid projectId format' };
    }
    if (!MACHINE_FINGERPRINT_RE.test(args.machineFingerprint)) {
      return { success: false, error: 'Invalid machine fingerprint' };
    }
    if (args.assetPaths.length === 0) {
      return { success: true, files: [], skipReason: 'no_assets' };
    }
    if (args.assetPaths.length > MAX_PROTECTED_ASSETS_PER_REQUEST) {
      return { success: false, error: 'Too many coupling asset paths' };
    }
    for (const assetPath of args.assetPaths) {
      if (!assetPath || assetPath.length > COUPLING_ASSET_PATH_MAX_LENGTH) {
        return { success: false, error: 'Invalid coupling asset path' };
      }
    }

    // Validate the machine-bound license token server-side; never trust the client.
    const issuer = buildPublicAuthIssuer(args.issuerBaseUrl);
    const claims = await verifyLicenseJwtAgainstPinnedRoots(args.licenseToken, issuer);
    if (!claims) {
      return { success: false, error: 'License token is invalid or expired' };
    }
    if (claims.package_id !== args.packageId) {
      return { success: false, error: 'License token package mismatch' };
    }
    if (claims.machine_fingerprint !== args.machineFingerprint) {
      return { success: false, error: 'License token machine mismatch' };
    }

    const registration = await ctx.runQuery(internal.packageRegistry.getRegistration, {
      packageId: args.packageId,
    });
    if (!registration) {
      return { success: false, error: 'Package not found' };
    }

    const artifact = await ctx.runQuery(internal.releaseArtifacts.getActiveArtifact, {
      artifactKey: RELEASE_ARTIFACT_KEYS.couplingRuntime,
      channel: RELEASE_CHANNELS.stable,
      platform: RELEASE_PLATFORMS.winX64,
    });
    if (!artifact) {
      // No runtime published yet → skip coupling without failing the install.
      return { success: true, files: [], skipReason: 'no_runtime' };
    }

    // The per-asset placement seed is derived in the closed coupling service (the watermark master
    // never lives here). Without seeds the client cannot place a v2 mark, so coupling is skipped
    // rather than failing the install.
    const seedMap = await deriveCouplingSeeds(claims.sub, args.assetPaths);
    if (!seedMap) {
      return { success: true, files: [], skipReason: 'seed_unavailable' };
    }

    const files: { assetPath: string; tokenHex: string; seedHex: string }[] = [];
    const entries: { assetPath: string; tokenHash: string; tokenLength: number }[] = [];
    // Both v2 encoders (image xg_0122, FBX mesh xg_0124) carry a 64-bit (8-byte) token - broad
    // low-poly/low-resolution coverage, exact recovery via ECC+CRC. Token length is recorded per
    // asset so the forensic decoder reconstructs the exact hex before hashing.
    for (const assetPath of args.assetPaths) {
      const seedHex = seedMap.get(assetPath);
      if (!seedHex) {
        continue; // no seed for this asset → cannot place a mark → skip it (never blocks)
      }
      const tokenBytes = crypto.getRandomValues(new Uint8Array(8));
      const tokenHex = Array.from(tokenBytes)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      files.push({ assetPath, tokenHex, seedHex });
      entries.push({
        assetPath,
        tokenHash: await sha256Hex(tokenHex),
        tokenLength: tokenBytes.length,
      });
    }

    if (files.length === 0) {
      return { success: true, files: [], skipReason: 'seed_unavailable' };
    }

    const signingRoot = await getPinnedSigningRoot(process.env.YUCP_ROOT_KEY_ID ?? null);
    const iat = Math.floor(Date.now() / 1000);
    const exp = iat + COUPLING_RUNTIME_TOKEN_TTL_SECONDS;
    const runtimeClaims: CouplingRuntimeClaims = {
      iss: issuer,
      aud: 'yucp-coupling-runtime',
      sub: claims.sub,
      jti: crypto.randomUUID(),
      package_id: args.packageId,
      machine_fingerprint: args.machineFingerprint,
      artifact_version: artifact.version,
      plaintext_sha256: artifact.plaintextSha256,
      iat,
      exp,
    };
    const runtimeToken = await signCouplingRuntimeJwt(
      runtimeClaims,
      signingRoot.privateKeyBase64,
      signingRoot.keyId
    );

    const correlationId = crypto.randomUUID();
    await ctx.runMutation(internal.yucpLicenses.recordCouplingTraces, {
      authUserId: registration.yucpUserId,
      packageId: args.packageId,
      licenseSubject: claims.sub,
      provider: claims.provider,
      machineFingerprintHash: await sha256Hex(args.machineFingerprint),
      projectIdHash: await sha256Hex(args.projectId),
      runtimeArtifactVersion: artifact.version,
      runtimePlaintextSha256: artifact.plaintextSha256,
      correlationId,
      entries,
    });

    return {
      success: true,
      runtimeToken,
      runtimeSha256: artifact.plaintextSha256,
      expiresAt: exp,
      files,
    };
  },
});

export const verifyCouplingJobLicense = action({
  args: {
    apiSecret: v.string(),
    packageId: v.string(),
    machineFingerprint: v.string(),
    licenseToken: v.string(),
  },
  returns: v.object({
    success: v.boolean(),
    licenseSubject: v.optional(v.string()),
    error: v.optional(v.string()),
  }),
  handler: async (
    ctx,
    args
  ): Promise<{ success: boolean; licenseSubject?: string; error?: string }> => {
    requireApiSecret(args.apiSecret);

    if (!PACKAGE_ID_RE.test(args.packageId)) {
      return { success: false, error: 'Invalid packageId format' };
    }
    if (!MACHINE_FINGERPRINT_RE.test(args.machineFingerprint)) {
      return { success: false, error: 'Invalid machine fingerprint' };
    }

    const verified = await verifyCouplingJobLicenseClaims(args);
    if (!verified.success) {
      return { success: false, error: verified.error };
    }

    const registration = await ctx.runQuery(internal.packageRegistry.getRegistration, {
      packageId: args.packageId,
    });
    if (!registration) {
      return { success: false, error: 'Package not found' };
    }

    return { success: true, licenseSubject: verified.claims.sub };
  },
});

/**
 * API coupling gateway assembler. The public API (which alone can reach the private coupling
 * service) fetches the git-served runtime manifest + derives the placement seeds, then hands them
 * here. This action does the control-plane half: re-verify the machine-bound license, mint per-asset
 * tokens, record forensic traces, and sign the full-manifest runtime download token the coupling
 * service will validate. The runtime DLL never touches Convex, only its manifest metadata does.
 */
export const assembleCouplingJob = action({
  args: {
    apiSecret: v.string(),
    packageId: v.string(),
    projectId: v.string(),
    machineFingerprint: v.string(),
    licenseToken: v.string(),
    assetPaths: v.array(v.string()),
    runtimeManifest: v.object({
      artifactKey: v.string(),
      channel: v.string(),
      platform: v.string(),
      version: v.string(),
      metadataVersion: v.number(),
      deliveryName: v.string(),
      contentType: v.string(),
      envelopeCipher: v.string(),
      envelopeIvBase64: v.string(),
      ciphertextSha256: v.string(),
      ciphertextSize: v.number(),
      plaintextSha256: v.string(),
      plaintextSize: v.number(),
      codeSigningSubject: v.optional(v.string()),
      codeSigningThumbprint: v.optional(v.string()),
    }),
    seeds: v.array(v.object({ assetPath: v.string(), seedHex: v.string() })),
  },
  returns: v.object({
    success: v.boolean(),
    runtimeToken: v.optional(v.string()),
    runtimeSha256: v.optional(v.string()),
    expiresAt: v.optional(v.number()),
    skipReason: v.optional(v.string()),
    error: v.optional(v.string()),
    files: v.optional(
      v.array(v.object({ assetPath: v.string(), tokenHex: v.string(), seedHex: v.string() }))
    ),
  }),
  handler: async (
    ctx,
    args
  ): Promise<{
    success: boolean;
    runtimeToken?: string;
    runtimeSha256?: string;
    expiresAt?: number;
    skipReason?: string;
    error?: string;
    files?: { assetPath: string; tokenHex: string; seedHex: string }[];
  }> => {
    requireApiSecret(args.apiSecret);

    if (!PACKAGE_ID_RE.test(args.packageId)) {
      return { success: false, error: 'Invalid packageId format' };
    }
    if (!PROJECT_ID_RE.test(args.projectId)) {
      return { success: false, error: 'Invalid projectId format' };
    }
    if (!MACHINE_FINGERPRINT_RE.test(args.machineFingerprint)) {
      return { success: false, error: 'Invalid machine fingerprint' };
    }
    if (args.assetPaths.length === 0) {
      return { success: true, files: [], skipReason: 'no_assets' };
    }
    if (args.assetPaths.length > MAX_PROTECTED_ASSETS_PER_REQUEST) {
      return { success: false, error: 'Too many coupling asset paths' };
    }
    for (const assetPath of args.assetPaths) {
      if (!assetPath || assetPath.length > COUPLING_ASSET_PATH_MAX_LENGTH) {
        return { success: false, error: 'Invalid coupling asset path' };
      }
    }

    const verified = await verifyCouplingJobLicenseClaims(args);
    if (!verified.success) {
      return { success: false, error: verified.error };
    }
    const { claims, issuer } = verified;

    const registration = await ctx.runQuery(internal.packageRegistry.getRegistration, {
      packageId: args.packageId,
    });
    if (!registration) {
      return { success: false, error: 'Package not found' };
    }

    const manifest = args.runtimeManifest;
    if (manifest.artifactKey !== RELEASE_ARTIFACT_KEYS.couplingRuntime) {
      // The API only ever passes a coupling-runtime manifest; treat anything else as "no runtime".
      return { success: true, files: [], skipReason: 'no_runtime' };
    }

    const seedMap = new Map<string, string>();
    for (const seed of args.seeds) {
      if (seed?.assetPath && /^[0-9a-f]{64}$/i.test(seed.seedHex ?? '')) {
        seedMap.set(seed.assetPath, seed.seedHex.toLowerCase());
      }
    }

    const files: { assetPath: string; tokenHex: string; seedHex: string }[] = [];
    const entries: { assetPath: string; tokenHash: string; tokenLength: number }[] = [];
    for (const assetPath of args.assetPaths) {
      const seedHex = seedMap.get(assetPath);
      if (!seedHex) {
        continue; // no seed for this asset, cannot place a mark, skip it without blocking
      }
      const tokenBytes = crypto.getRandomValues(new Uint8Array(8));
      const tokenHex = Array.from(tokenBytes)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      files.push({ assetPath, tokenHex, seedHex });
      entries.push({
        assetPath,
        tokenHash: await sha256Hex(tokenHex),
        tokenLength: tokenBytes.length,
      });
    }

    if (files.length === 0) {
      return { success: true, files: [], skipReason: 'seed_unavailable' };
    }

    const signingRoot = await getPinnedSigningRoot(process.env.YUCP_ROOT_KEY_ID ?? null);
    const iat = Math.floor(Date.now() / 1000);
    const exp = iat + COUPLING_RUNTIME_TOKEN_TTL_SECONDS;
    const runtimeClaims: CouplingRuntimeArtifactClaims = {
      iss: issuer,
      aud: 'yucp-coupling-runtime',
      sub: claims.sub,
      jti: crypto.randomUUID(),
      package_id: args.packageId,
      machine_fingerprint: args.machineFingerprint,
      project_id: args.projectId,
      artifact_key: manifest.artifactKey,
      artifact_channel: manifest.channel,
      artifact_platform: manifest.platform,
      artifact_version: manifest.version,
      metadata_version: manifest.metadataVersion,
      delivery_name: manifest.deliveryName,
      content_type: manifest.contentType,
      envelope_cipher: manifest.envelopeCipher,
      envelope_iv_b64: manifest.envelopeIvBase64,
      ciphertext_sha256: manifest.ciphertextSha256,
      ciphertext_size: manifest.ciphertextSize,
      plaintext_sha256: manifest.plaintextSha256,
      plaintext_size: manifest.plaintextSize,
      ...(manifest.codeSigningSubject ? { code_signing_subject: manifest.codeSigningSubject } : {}),
      ...(manifest.codeSigningThumbprint
        ? { code_signing_thumbprint: manifest.codeSigningThumbprint }
        : {}),
      iat,
      exp,
    };
    const runtimeToken = await signCouplingRuntimeArtifactJwt(
      runtimeClaims,
      signingRoot.privateKeyBase64,
      signingRoot.keyId
    );

    const correlationId = crypto.randomUUID();
    await ctx.runMutation(internal.yucpLicenses.recordCouplingTraces, {
      authUserId: registration.yucpUserId,
      packageId: args.packageId,
      licenseSubject: claims.sub,
      provider: claims.provider,
      machineFingerprintHash: await sha256Hex(args.machineFingerprint),
      projectIdHash: await sha256Hex(args.projectId),
      runtimeArtifactVersion: manifest.version,
      runtimePlaintextSha256: manifest.plaintextSha256,
      correlationId,
      entries,
    });

    return {
      success: true,
      runtimeToken,
      runtimeSha256: manifest.plaintextSha256,
      expiresAt: exp,
      files,
    };
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

    const signingRoot = await getPinnedSigningRoot(process.env.YUCP_ROOT_KEY_ID ?? null);

    const issuer = buildPublicAuthIssuer(args.issuerBaseUrl);
    const licenseClaims = await verifyLicenseJwtAgainstPinnedRoots(args.licenseToken, issuer);

    if (!licenseClaims) {
      return { success: false, error: 'License token is invalid or expired' };
    }
    if (licenseClaims.package_id !== args.packageId) {
      return { success: false, error: 'License token package mismatch' };
    }
    if (licenseClaims.machine_fingerprint !== args.machineFingerprint) {
      return { success: false, error: 'License token machine mismatch' };
    }
    const machineFingerprintHash = await sha256Hex(args.machineFingerprint);

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
    if (!CONTENT_HASH_RE.test(protectedAsset.contentHash)) {
      return { success: false, error: 'Protected asset content hash is invalid' };
    }

    // Anti-ripper gate: refuse the unlock if this buyer resolves to an identity node that a confirmed
    // trace blocked. The attestation must be for the same machine fingerprint as this unlock token,
    // so a clean helper machine cannot satisfy the gate for a blocked current machine.
    const blockCheck = await ctx.runQuery(internal.attestation.isIdentityBlocked, {
      licenseSubject: licenseClaims.sub,
      machineFingerprintHash,
    });
    if (blockCheck.blocked) {
      return { success: false, error: 'This purchase is not eligible for unlock on this account' };
    }
    if (!blockCheck.attested) {
      return { success: false, error: 'Attestation is required before protected unlock' };
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
      content_hash: protectedAsset.contentHash,
      iat: nowSeconds,
      exp,
    };

    const unlockToken = await signProtectedUnlockJwt(
      claims,
      signingRoot.privateKeyBase64,
      signingRoot.keyId
    );
    return { success: true, unlockToken, expiresAt: exp };
  },
});

type ProtectedMaterializationGrantIssueResult =
  | {
      success: true;
      grant: string;
      expiresAt: number;
      error?: undefined;
    }
  | {
      success: false;
      grant?: undefined;
      expiresAt?: undefined;
      error: string;
    };

type ProtectedUnlockIssueResult = {
  success: boolean;
  unlockToken?: string;
  expiresAt?: number;
  error?: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// Phase 9, Grant revocation (forward-looking only)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check whether a grant has been revoked.
 * NOTE: revocation is forward-looking only. It cannot claw back already-materialized plaintext.
 */
export const isGrantRevoked = internalQuery({
  args: {
    grantId: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const record = await ctx.db
      .query('revoked_grants')
      .withIndex('by_grant_id', (q) => q.eq('grantId', args.grantId))
      .first();
    return record !== null;
  },
});

/**
 * Revoke a protected materialization grant.
 * NOTE: revocation is forward-looking only. It cannot claw back already-materialized plaintext.
 */
export const revokeGrant = internalMutation({
  args: {
    grantId: v.string(),
    reason: v.string(),
    revokedByUserId: v.string(),
  },
  returns: v.object({
    success: v.boolean(),
    error: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    // NOTE: revocation is forward-looking only. It cannot claw back already-materialized plaintext.
    const existing = await ctx.db
      .query('revoked_grants')
      .withIndex('by_grant_id', (q) => q.eq('grantId', args.grantId))
      .first();
    if (existing) {
      return { success: false, error: 'Grant is already revoked' };
    }
    const now = Date.now();
    await ctx.db.insert('revoked_grants', {
      grantId: args.grantId,
      revokedAt: now,
      reason: args.reason,
      revokedByUserId: args.revokedByUserId,
      createdAt: now,
    });
    await ctx.db.insert('audit_events', {
      authUserId: args.revokedByUserId,
      eventType: 'protected.materialization.grant.revoked',
      actorType: 'admin',
      metadata: {
        grantId: args.grantId,
        reason: args.reason,
      },
      correlationId: crypto.randomUUID(),
      createdAt: now,
    });
    return { success: true };
  },
});
