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
  type ProviderLicenseVerificationResult,
  verifyLicenseWithProviderRuntime,
} from './lib/providerLicenseVerification';
import { buildPublicAuthIssuer, resolveConfiguredPublicApiBaseUrl } from './lib/publicAuthIssuer';
import {
  type LicenseClaims,
  resolvePinnedYucpSigningRoot,
  signLicenseJwt,
  verifyLicenseJwtAgainstPinnedRoots,
} from './lib/yucpCrypto';

const TOKEN_TTL_SECONDS = 3600; // 1 hour -- kept short; disk cache handles offline re-use
const MAX_MANUAL_LICENSE_KEY_LENGTH = 4_096;
const PACKAGE_ID_RE = /^[a-z0-9\-_./:]{1,128}$/;
const MACHINE_FINGERPRINT_RE = /^[a-z0-9:_-]{16,256}$/i;

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
  providerUserId?: string;
  externalOrderId?: string;
  externalLicenseId?: string;
  providerProductId?: string;
  providerTierRef?: string;
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

export const lookupProductByProviderRefForCreator = query({
  args: {
    apiSecret: v.string(),
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
    requireApiSecret(args.apiSecret);
    return await ctx.runQuery(internal.yucpLicenses.getProductByProviderRefForCreator, {
      authUserId: args.authUserId,
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
    providerUserId: v.optional(v.string()),
    externalOrderId: v.optional(v.string()),
    externalLicenseId: v.optional(v.string()),
    providerProductId: v.optional(v.string()),
    providerTierRef: v.optional(v.string()),
  }),
  handler: async (ctx, args): Promise<LicenseProofResult> => {
    if (!args.packageId || !args.licenseKey || !args.provider || !args.productPermalink) {
      return { success: false, error: 'Missing required fields' };
    }
    if (args.provider === 'manual' && args.licenseKey.length > MAX_MANUAL_LICENSE_KEY_LENGTH) {
      return { success: false, error: 'License verification failed' };
    }

    let verifyResult: ProviderLicenseVerificationResult | null = null;

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

    if (!verifyResult?.valid || !product) {
      return { success: false, error: verifyResult?.reason ?? 'License verification failed' };
    }

    let verifiedProduct = product;
    const returnedProviderProductId = verifyResult.providerProductId?.trim();
    if (
      returnedProviderProductId &&
      returnedProviderProductId !== args.productPermalink.trim()
    ) {
      const returnedProduct = await ctx.runQuery(
        internal.yucpLicenses.getProductByProviderRefForCreator,
        {
          authUserId: product.authUserId,
          provider: args.provider,
          providerProductRef: returnedProviderProductId,
        }
      );
      if (!returnedProduct || returnedProduct.productId !== product.productId) {
        return {
          success: false,
          error: 'License does not belong to the requested product',
        };
      }
      verifiedProduct = returnedProduct;
    }

    return {
      success: true,
      creatorAuthUserId: verifiedProduct.authUserId,
      productId: verifiedProduct.productId,
      catalogProductId: verifiedProduct.catalogProductId,
      providerUserId: verifyResult.providerUserId,
      externalOrderId: verifyResult.externalOrderId,
      externalLicenseId: verifyResult.externalLicenseId,
      providerProductId: verifyResult.providerProductId,
      providerTierRef: verifyResult.providerTierRef,
    };
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
