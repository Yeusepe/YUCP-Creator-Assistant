import { sha256Hex } from '@yucp/shared/crypto';
import { ConvexError, v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc } from './_generated/dataModel';
import { mutation, query } from './_generated/server';
import { requireApiSecret } from './lib/apiAuth';
import { BILLING_CAPABILITY_KEYS } from './lib/billingCapabilities';

const PACKAGE_ID_RE = /^[a-z0-9\-_./:]{1,128}$/;

function assertPackageId(packageId: string): void {
  if (!PACKAGE_ID_RE.test(packageId)) {
    throw new ConvexError(`Invalid packageId format: ${packageId}`);
  }
}

function isArchivedPackage(
  registration: Pick<Doc<'package_registry'>, 'status'> | null | undefined
): boolean {
  return registration?.status === 'archived';
}

export const listOwnedPackagesForAuthUser = query({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
  },
  returns: v.object({
    packages: v.array(v.string()),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const registrations: Doc<'package_registry'>[] = await ctx.runQuery(
      internal.packageRegistry.getRegistrationsByYucpUser,
      {
        yucpUserId: args.authUserId,
      }
    );
    return {
      packages: registrations
        .filter((registration) => !isArchivedPackage(registration))
        .map((entry) => entry.packageId)
        .sort((left, right) => left.localeCompare(right)),
    };
  },
});

export const listOwnedPackageSummariesForAuthUser = query({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
  },
  returns: v.object({
    packages: v.array(
      v.object({
        packageId: v.string(),
        packageName: v.optional(v.string()),
        registeredAt: v.number(),
        updatedAt: v.number(),
      })
    ),
  }),
  handler: async (
    ctx,
    args
  ): Promise<{
    packages: Array<{
      packageId: string;
      packageName?: string;
      registeredAt: number;
      updatedAt: number;
    }>;
  }> => {
    requireApiSecret(args.apiSecret);
    const registrations: Doc<'package_registry'>[] = await ctx.runQuery(
      internal.packageRegistry.getRegistrationsByYucpUser,
      {
        yucpUserId: args.authUserId,
      }
    );
    return {
      packages: registrations
        .filter((registration) => !isArchivedPackage(registration))
        .map((registration) => ({
          packageId: registration.packageId,
          packageName: registration.packageName,
          registeredAt: registration.registeredAt,
          updatedAt: registration.updatedAt,
        }))
        .sort((left, right) => {
          const leftLabel = (left.packageName ?? left.packageId).toLowerCase();
          const rightLabel = (right.packageName ?? right.packageId).toLowerCase();
          return (
            leftLabel.localeCompare(rightLabel) ||
            left.packageId.localeCompare(right.packageId)
          );
        }),
    };
  },
});

export const authorizeCouplingForensicsLookupForAuthUser = query({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    packageId: v.string(),
  },
  returns: v.object({
    capabilityEnabled: v.boolean(),
    packageOwned: v.boolean(),
  }),
  handler: async (
    ctx,
    args
  ): Promise<{ capabilityEnabled: boolean; packageOwned: boolean }> => {
    requireApiSecret(args.apiSecret);
    assertPackageId(args.packageId);
    const capabilityEnabled = await ctx.runQuery(
      internal.certificateBilling.hasCapabilityForAuthUser,
      {
        authUserId: args.authUserId,
        capabilityKey: BILLING_CAPABILITY_KEYS.couplingTraceability,
      }
    );
    if (!capabilityEnabled) {
      return {
        capabilityEnabled: false,
        packageOwned: false,
      };
    }
    const registration: Doc<'package_registry'> | null = await ctx.runQuery(
      internal.packageRegistry.getRegistration,
      {
        packageId: args.packageId,
      }
    );
    return {
      capabilityEnabled: true,
      packageOwned:
        Boolean(registration) &&
        registration?.yucpUserId === args.authUserId &&
        !isArchivedPackage(registration),
    };
  },
});

export const recordLookupAudit = mutation({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    packageId: v.string(),
    source: v.union(v.literal('dashboard'), v.literal('discord')),
    status: v.union(
      v.literal('attributed'),
      v.literal('tampered_suspected'),
      v.literal('hostile_unknown'),
      v.literal('no_signal_found'),
      v.literal('no_candidate_assets'),
      v.literal('denied'),
      v.literal('error')
    ),
    requestedCandidateCount: v.number(),
    matchedAttributionCount: v.number(),
    uploadSha256: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    assertPackageId(args.packageId);
    if (
      !Number.isSafeInteger(args.requestedCandidateCount) ||
      args.requestedCandidateCount < 0 ||
      !Number.isSafeInteger(args.matchedAttributionCount) ||
      args.matchedAttributionCount < 0 ||
      args.matchedAttributionCount > args.requestedCandidateCount
    ) {
      throw new ConvexError('Attribution audit counts are invalid');
    }
    await ctx.db.insert('audit_events', {
      authUserId: args.authUserId,
      eventType: 'coupling.lookup.performed',
      actorType: 'system',
      metadata: {
        packageId: args.packageId,
        source: args.source,
        status: args.status,
        requestedCandidateCount: args.requestedCandidateCount,
        matchedAttributionCount: args.matchedAttributionCount,
        uploadSha256: args.uploadSha256,
      },
      correlationId: `${args.source}:${args.packageId}:${Date.now()}`,
      createdAt: Date.now(),
    });
  },
});

/**
 * Largest number of buyers one trace may de-anonymise. A lookup matches a
 * handful of assets to a handful of buyers; anything beyond this is a scrape
 * rather than an investigation.
 */
const TRACE_IDENTITY_RESOLUTION_LIMIT = 64;

function buildLicenseFingerprint(provider: string | undefined, licenseSubject: string): string {
  const fingerprint = licenseSubject.slice(0, 10);
  return provider ? `${provider} · ${fingerprint}` : fingerprint;
}

/**
 * Puts a name and a licence to the buyer behind a matched trace.
 *
 * The coupling records only ever carry a pseudonym, and the buyer id behind it
 * is sealed; the caller unseals that first and passes it here. This is the step
 * that turns it into something a creator can act on, so it is gated on the same
 * ownership check as the lookup itself: a creator may only resolve buyers of a
 * package they own, and only for the product the trace was run against.
 *
 * The licence key stays encrypted in transit - the decryption key lives with
 * the caller, not in the database.
 */
export const resolveTraceBuyerIdentitiesForAuthUser = query({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    buyerIds: v.array(v.string()),
    packageId: v.string(),
  },
  returns: v.object({
    identities: v.array(
      v.object({
        buyerId: v.string(),
        /** Where the join stops, so a wrong or missing answer is diagnosable. */
        subjectsMatched: v.optional(v.number()),
        hasEntitlement: v.optional(v.boolean()),
        hasLicenseSubject: v.optional(v.boolean()),
        hasLicenseLink: v.optional(v.boolean()),
        buyerProviderUserId: v.optional(v.string()),
        buyerProviderUsername: v.optional(v.string()),
        buyerSubjectDiscordUserId: v.optional(v.string()),
        buyerSubjectDisplayName: v.optional(v.string()),
        licenseFingerprint: v.optional(v.string()),
        licenseKeyEncrypted: v.optional(v.string()),
        /**
         * Licences written before the encrypted column existed are stored in
         * the clear. Returning them keeps older purchases traceable; they are
         * no more exposed here than they already are at rest.
         */
        licenseKeyLegacy: v.optional(v.string()),
        provider: v.optional(v.string()),
      })
    ),
    packageOwned: v.boolean(),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    assertPackageId(args.packageId);
    // Naming a buyer is a stronger disclosure than matching one, so it is
    // gated on exactly what the lookup is gated on - never less.
    const capabilityEnabled = await ctx.runQuery(
      internal.certificateBilling.hasCapabilityForAuthUser,
      {
        authUserId: args.authUserId,
        capabilityKey: BILLING_CAPABILITY_KEYS.couplingTraceability,
      }
    );
    if (!capabilityEnabled) {
      return { identities: [], packageOwned: false };
    }
    const registration: Doc<'package_registry'> | null = await ctx.runQuery(
      internal.packageRegistry.getRegistration,
      { packageId: args.packageId }
    );
    const packageOwned =
      Boolean(registration) &&
      registration?.yucpUserId === args.authUserId &&
      !isArchivedPackage(registration);
    if (!packageOwned) {
      return { identities: [], packageOwned: false };
    }

    const identities: Array<{
      buyerId: string;
      subjectsMatched?: number;
      hasEntitlement?: boolean;
      hasLicenseSubject?: boolean;
      hasLicenseLink?: boolean;
      buyerProviderUserId?: string;
      buyerProviderUsername?: string;
      buyerSubjectDiscordUserId?: string;
      buyerSubjectDisplayName?: string;
      licenseFingerprint?: string;
      licenseKeyEncrypted?: string;
      licenseKeyLegacy?: string;
      provider?: string;
    }> = [];
    // Entitlements are granted under the creator's catalog product, not the
    // package: the verification funnel writes the catalog's logical productId
    // and links catalogProductId, and packages join those products through
    // package_catalog_bindings - the same mapping the delivery path uses.
    // Comparing entitlement.productId against the package id compared two
    // different namespaces and silently dropped every licence.
    const packageBindings = await ctx.db
      .query('package_catalog_bindings')
      .withIndex('by_creator_package_status', (q) =>
        q
          .eq('creatorAuthUserId', args.authUserId)
          .eq('packageId', args.packageId)
          .eq('status', 'active')
      )
      .collect();
    const boundCatalogProductIds = new Set(
      packageBindings.map((binding) => String(binding.catalogProductId))
    );
    const boundProducts = await Promise.all(
      packageBindings.map((binding) => ctx.db.get(binding.catalogProductId))
    );
    // Entitlements written before catalogProductId existed carry only the
    // catalog's logical product id, so those ids are accepted as well.
    const boundLogicalProductIds = new Set(
      boundProducts.flatMap((product) =>
        product && product.authUserId === args.authUserId ? [product.productId] : []
      )
    );
    const entitlementMatchesPackage = (entitlement: Doc<'entitlements'>): boolean =>
      entitlement.authUserId === args.authUserId &&
      (entitlement.catalogProductId
        ? boundCatalogProductIds.has(String(entitlement.catalogProductId))
        : boundLogicalProductIds.has(entitlement.productId) ||
          entitlement.productId === args.packageId);

    // Resolved concurrently: a handful of reads per buyer, serialized across
    // 64 buyers, is hundreds of round trips inside one query, which approaches
    // Convex's execution limits and sits on the lookup's response path.
    const uniqueBuyerIds = [...new Set(args.buyerIds.filter(Boolean))].slice(
      0,
      TRACE_IDENTITY_RESOLUTION_LIMIT
    );
    const resolvedIdentities = await Promise.all(
      uniqueBuyerIds.map(async (buyerId) => {

      // The sealed buyer id is the buyer's account, which is what carries the
      // Discord handle a creator recognises.
      // authUserId is optional on subjects and the index is not unique, so a
      // buyer with more than one subject row (a re-link, a second Discord
      // account) made .first() return an arbitrary one - which is how a trace
      // can name the wrong person. Prefer an active row, then the most
      // recently updated, so the answer is at least deterministic, and report
      // how many matched so an ambiguous account is visible rather than
      // silently resolved.
      const subjectMatches = await ctx.db
        .query('subjects')
        .withIndex('by_auth_user', (q) => q.eq('authUserId', buyerId))
        .collect();
      const subject =
        subjectMatches
          .slice()
          .sort((left, right) => {
            const activeDelta =
              Number(right.status === 'active') - Number(left.status === 'active');
            return activeDelta !== 0 ? activeDelta : right.updatedAt - left.updatedAt;
          })[0] ?? null;
      if (!subject) {
        return { buyerId, subjectsMatched: 0 };
      }

      // Scoped to this package via its catalog bindings: owning a package does
      // not entitle a creator to the buyer's licences for anything else.
      // Searched across every subject row the buyer has, the way the delivery
      // path does - a re-linked account leaves the entitlement on an older
      // subject row than the one chosen above for display.
      const entitlementsBySubject = await Promise.all(
        subjectMatches.map((subjectMatch) =>
          ctx.db
            .query('entitlements')
            .withIndex('by_subject', (q) => q.eq('subjectId', subjectMatch._id))
            .collect()
        )
      );
      const packageEntitlements = entitlementsBySubject.flat().filter(entitlementMatchesPackage);
      // A buyer who bought through more than one store can hold several
      // matching entitlements, and not all of them recorded a licence. Prefer
      // the one that can actually name a licence; within that, active beats
      // terminal - a revoked or refunded purchase is still the answer to "who
      // bought this file".
      const pickOrder = (candidate: Doc<'entitlements'>): number =>
        (candidate.licenseSubject ? 0 : 2) + (candidate.status === 'active' ? 0 : 1);
      const entitlement =
        packageEntitlements.slice().sort((left, right) => pickOrder(left) - pickOrder(right))[0] ??
        null;
      let licenseSubject = entitlement?.licenseSubject;
      let licenseProviderFallback: string | undefined;
      if (entitlement && !licenseSubject && entitlement.sourceProvider === 'manual') {
        // Manual redemptions stamped no licenseSubject before
        // completeManualLicenseIntent started writing one, and the raw key is
        // never stored - only its hash on the creator's issued licence. The
        // redemption reference is the hash of that licence's id, so walk the
        // creator's issued keys for the product to recover the fingerprint.
        const manualLicenses = await ctx.db
          .query('manual_licenses')
          .withIndex('by_auth_user_product', (q) =>
            q.eq('authUserId', args.authUserId).eq('productId', entitlement.productId)
          )
          .collect();
        for (const manualLicense of manualLicenses) {
          const reference = `manual:${await sha256Hex(String(manualLicense._id))}`;
          if (reference === entitlement.sourceReference) {
            licenseSubject = manualLicense.licenseKeyHash;
            licenseProviderFallback = 'manual';
            break;
          }
        }
      }
      // licenseVerification writes this link under the BUYER's account
      // (upsertLicenseSubjectLink receives buyerAuthUserId), so keying it by
      // the creator finds nothing and silently drops the licence.
      const link = licenseSubject
        ? await ctx.db
            .query('license_subject_links')
            .withIndex('by_auth_user_subject', (q) =>
              q.eq('authUserId', buyerId).eq('licenseSubject', licenseSubject)
            )
            .first()
        : null;

      let buyerProviderUsername: string | undefined;
      if (link?.providerUserId) {
        const externalAccount = await ctx.db
          .query('external_accounts')
          .withIndex('by_provider_user', (q) =>
            q.eq('provider', link.provider).eq('providerUserId', link.providerUserId as string)
          )
          .filter((q) => q.eq(q.field('status'), 'active'))
          .first();
        buyerProviderUsername = externalAccount?.providerUsername;
      }

      return {
        buyerId,
        subjectsMatched: subjectMatches.length,
        hasEntitlement: Boolean(entitlement),
        hasLicenseSubject: Boolean(licenseSubject),
        hasLicenseLink: Boolean(link),
        ...(link?.providerUserId ? { buyerProviderUserId: link.providerUserId } : {}),
        ...(buyerProviderUsername ? { buyerProviderUsername } : {}),
        ...(subject.primaryDiscordUserId
          ? { buyerSubjectDiscordUserId: subject.primaryDiscordUserId }
          : {}),
        ...(subject.displayName ? { buyerSubjectDisplayName: subject.displayName } : {}),
        ...(licenseSubject
          ? {
              licenseFingerprint: buildLicenseFingerprint(
                link?.provider ?? licenseProviderFallback,
                licenseSubject
              ),
            }
          : {}),
        ...(link?.licenseKeyEncrypted ? { licenseKeyEncrypted: link.licenseKeyEncrypted } : {}),
        ...(!link?.licenseKeyEncrypted && link?.licenseKey
          ? { licenseKeyLegacy: link.licenseKey }
          : {}),
        ...(link?.provider ?? licenseProviderFallback
          ? { provider: link?.provider ?? licenseProviderFallback }
          : {}),
      };
      })
    );
    identities.push(...resolvedIdentities);
    return { identities, packageOwned: true };
  },
});
