/**
 * One-time data migrations.
 * Run with:
 * - npx convex run migrations:purgeLegacyTenantDocuments
 * - npx convex run migrations:purgeGuildLinkVerifyPromptMessages
 * - npx convex run migrations:purgeLegacyOutboxVerifyPromptRefreshJobs
 * - npx convex run migrations:purgeRoleRuleSourceGuildNames
 * - npx convex run migrations:backfillProtectedAssetUnlockModes
 * - npx convex run migrations:migrateLegacyLicenseSubjectLinks
 * Re-run until the relevant migration returns 0 remaining records.
 */

import { v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import { internalMutation, internalQuery, type QueryCtx } from './_generated/server';
import { PII_PURPOSES } from './lib/credentialKeys';
import { upsertLicenseSubjectLink } from './lib/licenseSubjectLink';
import { encryptPii } from './lib/piiCrypto';
import { resolveProtectedAssetUnlockMode } from './lib/protectedAssetUnlockMode';
import { upsertBuyerProviderLinkRecord } from './subjects';

type LegacyMigrationDoc = Record<string, unknown>;
type BuyerAttributionCandidateConfidence = 'high' | 'medium';
type BuyerAttributionRelatedBuyerProviderLink = {
  id: Id<'buyer_provider_links'>;
  subjectId: Id<'subjects'>;
  status: Doc<'buyer_provider_links'>['status'];
  verificationMethod?: Doc<'buyer_provider_links'>['verificationMethod'];
  linkedAt: number;
  createdAt: number;
  updatedAt: number;
};
type BuyerAttributionRelatedLicenseSubjectLink = {
  id: Id<'license_subject_links'>;
  licenseSubject: string;
  authUserId: string;
  providerUserId?: string;
  providerProductId?: string;
  externalOrderId?: string;
  createdAt: number;
  confidence: BuyerAttributionCandidateConfidence;
  reason: string;
  proposedAuthUserId: string;
  repairable: boolean;
};
type BuyerAttributionCandidate = {
  bindingId: Id<'bindings'>;
  bindingStatus: Doc<'bindings'>['status'];
  bindingCreatedAt: number;
  currentAuthUserId: string;
  expectedBuyerAuthUserId: string;
  subjectId: Id<'subjects'>;
  subjectDisplayName?: string;
  provider: Doc<'external_accounts'>['provider'];
  externalAccountId: Id<'external_accounts'>;
  providerUserId: string;
  providerUsername?: string;
  relatedBuyerProviderLinks: BuyerAttributionRelatedBuyerProviderLink[];
  relatedLicenseSubjectLinks: BuyerAttributionRelatedLicenseSubjectLink[];
  repairable: boolean;
};

const DEFAULT_BUYER_ATTRIBUTION_REPORT_LIMIT = 50;
const REPORTABLE_BINDING_STATUSES = new Set<Doc<'bindings'>['status']>(['active', 'pending']);

const LEGACY_TABLES = [
  'bindings',
  'verification_sessions',
  'entitlements',
  'guild_links',
  'role_rules',
  'download_routes',
  'download_artifacts',
  'unity_installations',
  'runtime_assertions',
  'outbox_jobs',
  'audit_events',
  'product_catalog',
  'purchase_facts',
  'provider_connections',
  'provider_credentials',
  'provider_connection_capabilities',
  'provider_catalog_mappings',
  'provider_transactions',
  'provider_memberships',
  'provider_licenses',
  'entitlement_evidence',
  'creator_oauth_apps',
  'manual_licenses',
  'webhook_events',
  'collaborator_invites',
  'collaborator_connections',
  'creator_profiles',
] as const;

function uniqueById<T extends { id: string }>(items: T[]): T[] {
  return Array.from(new Map(items.map((item) => [item.id, item])).values());
}

async function buildBuyerAttributionCandidate(
  ctx: Pick<QueryCtx, 'db'>,
  binding: Doc<'bindings'>
): Promise<BuyerAttributionCandidate | null> {
  if (binding.bindingType !== 'verification' || !REPORTABLE_BINDING_STATUSES.has(binding.status)) {
    return null;
  }

  const subject = await ctx.db.get(binding.subjectId);
  if (!subject?.authUserId || subject.authUserId === binding.authUserId) {
    return null;
  }

  const externalAccount = await ctx.db.get(binding.externalAccountId);
  if (!externalAccount?.provider || !externalAccount.providerUserId) {
    return null;
  }

  const providerUserCollision = await hasProviderUserCollision(ctx, binding, externalAccount);

  const relatedBuyerProviderLinks = (
    (await ctx.db
      .query('buyer_provider_links')
      .withIndex('by_subject_external', (q) =>
        q.eq('subjectId', binding.subjectId).eq('externalAccountId', binding.externalAccountId)
      )
      .collect()) as Doc<'buyer_provider_links'>[]
  ).map((link) => ({
    id: link._id,
    subjectId: link.subjectId,
    status: link.status,
    verificationMethod: link.verificationMethod,
    linkedAt: link.linkedAt,
    createdAt: link.createdAt,
    updatedAt: link.updatedAt,
  }));

  const highConfidenceMatches: BuyerAttributionRelatedLicenseSubjectLink[] = [];
  const mediumConfidenceMatches: BuyerAttributionRelatedLicenseSubjectLink[] = [];
  const licenseLinks = (await ctx.db
    .query('license_subject_links')
    .withIndex('by_auth_user', (q) => q.eq('authUserId', binding.authUserId))
    .collect()) as Doc<'license_subject_links'>[];

  for (const licenseLink of licenseLinks) {
    if (licenseLink.provider !== externalAccount.provider) {
      continue;
    }

    if (
      licenseLink.providerUserId &&
      licenseLink.providerUserId === externalAccount.providerUserId
    ) {
      highConfidenceMatches.push({
        id: licenseLink._id,
        licenseSubject: licenseLink.licenseSubject,
        authUserId: licenseLink.authUserId,
        providerUserId: licenseLink.providerUserId,
        providerProductId: licenseLink.providerProductId,
        externalOrderId: licenseLink.externalOrderId,
        createdAt: licenseLink.createdAt,
        confidence: 'high',
        reason: providerUserCollision
          ? 'providerUserId matches more than one suspect buyer subject; manual review required'
          : 'providerUserId matches the external account linked by the suspect binding',
        proposedAuthUserId: subject.authUserId,
        repairable: !providerUserCollision,
      });
      continue;
    }

    if (licenseLink.createdAt === binding.createdAt) {
      mediumConfidenceMatches.push({
        id: licenseLink._id,
        licenseSubject: licenseLink.licenseSubject,
        authUserId: licenseLink.authUserId,
        providerUserId: licenseLink.providerUserId,
        providerProductId: licenseLink.providerProductId,
        externalOrderId: licenseLink.externalOrderId,
        createdAt: licenseLink.createdAt,
        confidence: 'medium',
        reason: 'same provider and createdAt as the suspect verification binding',
        proposedAuthUserId: subject.authUserId,
        repairable: false,
      });
    }
  }

  return {
    bindingId: binding._id,
    bindingStatus: binding.status,
    bindingCreatedAt: binding.createdAt,
    currentAuthUserId: binding.authUserId,
    expectedBuyerAuthUserId: subject.authUserId,
    subjectId: binding.subjectId,
    subjectDisplayName: subject.displayName,
    provider: externalAccount.provider,
    externalAccountId: binding.externalAccountId,
    providerUserId: externalAccount.providerUserId,
    providerUsername: externalAccount.providerUsername,
    relatedBuyerProviderLinks,
    relatedLicenseSubjectLinks: uniqueById([...highConfidenceMatches, ...mediumConfidenceMatches]),
    repairable: true,
  };
}

async function hasProviderUserCollision(
  ctx: Pick<QueryCtx, 'db'>,
  binding: Doc<'bindings'>,
  externalAccount: Doc<'external_accounts'>
): Promise<boolean> {
  const suspectBindings = (await ctx.db
    .query('bindings')
    .withIndex('by_auth_user', (q) => q.eq('authUserId', binding.authUserId))
    .collect()) as Doc<'bindings'>[];
  const candidateBuyerAuthUserIds = new Set<string>();

  for (const suspectBinding of suspectBindings) {
    if (
      suspectBinding.bindingType !== 'verification' ||
      !REPORTABLE_BINDING_STATUSES.has(suspectBinding.status)
    ) {
      continue;
    }

    const suspectSubject = await ctx.db.get(suspectBinding.subjectId);
    if (!suspectSubject?.authUserId || suspectSubject.authUserId === suspectBinding.authUserId) {
      continue;
    }

    const suspectExternalAccount =
      suspectBinding.externalAccountId === binding.externalAccountId
        ? externalAccount
        : ((await ctx.db.get(suspectBinding.externalAccountId)) as Doc<'external_accounts'> | null);
    if (
      !suspectExternalAccount?.providerUserId ||
      suspectExternalAccount.provider !== externalAccount.provider ||
      suspectExternalAccount.providerUserId !== externalAccount.providerUserId
    ) {
      continue;
    }

    candidateBuyerAuthUserIds.add(suspectSubject.authUserId);
    if (candidateBuyerAuthUserIds.size > 1) {
      return true;
    }
  }

  return false;
}

async function listBuyerAttributionCandidates(ctx: Pick<QueryCtx, 'db'>, limit: number) {
  const candidates: BuyerAttributionCandidate[] = [];
  let cursor: string | null = null;
  const batchSize = Math.max(50, Math.min(200, limit * 2));

  while (candidates.length < limit) {
    const pageResult = await ctx.db.query('bindings').paginate({
      numItems: batchSize,
      cursor,
    });
    const page = (pageResult.page as Doc<'bindings'>[]).sort(
      (left, right) => right.createdAt - left.createdAt
    );

    for (const binding of page) {
      const candidate = await buildBuyerAttributionCandidate(ctx, binding);
      if (!candidate) {
        continue;
      }
      candidates.push(candidate);
      if (candidates.length >= limit) {
        break;
      }
    }

    if (pageResult.isDone) {
      break;
    }
    cursor = pageResult.continueCursor;
  }

  return {
    scannedAt: Date.now(),
    summary: {
      candidateBindings: candidates.length,
      repairableBindings: candidates.filter((candidate) => candidate.repairable).length,
      buyerProviderLinksForReview: candidates.reduce(
        (total, candidate) => total + candidate.relatedBuyerProviderLinks.length,
        0
      ),
      repairableLicenseSubjectLinks: candidates.reduce(
        (total, candidate) =>
          total + candidate.relatedLicenseSubjectLinks.filter((link) => link.repairable).length,
        0
      ),
      reviewOnlyLicenseSubjectLinks: candidates.reduce(
        (total, candidate) =>
          total + candidate.relatedLicenseSubjectLinks.filter((link) => !link.repairable).length,
        0
      ),
    },
    candidates,
  };
}

/**
 * Delete up to 200 legacy tenant documents per table (plus up to 200
 * catalog_product_links) per call. Re-run until it returns { deleted: 0 }.
 */
export const purgeLegacyTenantDocuments = internalMutation({
  args: {},
  handler: async (ctx) => {
    let deleted = 0;
    const PER_TABLE = 200;

    for (const table of LEGACY_TABLES) {
      // Filter to only fetch docs that still have a legacy tenantId field,
      // so .take() selects from the right pool regardless of insertion order.
      const docs = await ctx.db
        .query(table)
        .filter((q) => q.neq(q.field('tenantId'), null))
        .take(PER_TABLE);
      for (const doc of docs) {
        const fields = doc as LegacyMigrationDoc;
        const hasAuthUserId =
          ('authUserId' in fields && fields.authUserId != null) ||
          ('ownerAuthUserId' in fields && fields.ownerAuthUserId != null) ||
          ('submittedByAuthUserId' in fields && fields.submittedByAuthUserId != null);
        const hasLegacyTenantId =
          ('tenantId' in fields && fields.tenantId != null) ||
          ('ownerTenantId' in fields && fields.ownerTenantId != null) ||
          ('submittedByTenantId' in fields && fields.submittedByTenantId != null);
        if (hasLegacyTenantId && !hasAuthUserId) {
          await ctx.db.delete(doc._id);
          deleted++;
        }
      }
    }

    // Also purge catalog_product_links with submittedByTenantId
    const catalogLinks = await ctx.db
      .query('catalog_product_links')
      .filter((q) => q.neq(q.field('submittedByTenantId'), null))
      .take(PER_TABLE);
    for (const doc of catalogLinks) {
      const fields = doc as LegacyMigrationDoc;
      if (fields.submittedByTenantId != null && fields.submittedByAuthUserId == null) {
        await ctx.db.delete(doc._id);
        deleted++;
      }
    }

    return { deleted };
  },
});

/**
 * Remove legacy guild_links.verifyPromptMessage fields in batches.
 * Re-run until it returns { updated: 0 }.
 */
export const purgeGuildLinkVerifyPromptMessages = internalMutation({
  args: {},
  handler: async (ctx) => {
    const docs = await ctx.db
      .query('guild_links')
      .filter((q) => q.neq(q.field('verifyPromptMessage'), null))
      .take(200);

    let updated = 0;
    for (const doc of docs) {
      await ctx.db.patch(doc._id, {
        verifyPromptMessage: undefined,
      });
      updated++;
    }

    return { updated };
  },
});

/**
 * Remove legacy outbox_jobs rows for the retired verify_prompt_refresh workflow.
 * Re-run until it returns { deleted: 0 }.
 */
export const purgeLegacyOutboxVerifyPromptRefreshJobs = internalMutation({
  args: {},
  handler: async (ctx) => {
    const docs = await ctx.db
      .query('outbox_jobs')
      .filter((q) => q.eq(q.field('jobType'), 'verify_prompt_refresh'))
      .take(200);

    let deleted = 0;
    for (const doc of docs) {
      await ctx.db.delete(doc._id);
      deleted++;
    }

    return { deleted };
  },
});

/**
 * Remove legacy role_rules.sourceGuildName fields in batches.
 * Re-run until it returns { updated: 0 }.
 */
export const purgeRoleRuleSourceGuildNames = internalMutation({
  args: {},
  handler: async (ctx) => {
    const docs = await ctx.db
      .query('role_rules')
      .filter((q) => q.neq(q.field('sourceGuildName'), null))
      .take(200);

    let updated = 0;
    for (const doc of docs) {
      await ctx.db.patch(doc._id, {
        sourceGuildName: undefined,
      });
      updated++;
    }

    return { updated };
  },
});

/**
 * Backfill protected_assets.unlockMode for rows created before the unlock-mode split.
 * Re-run until it returns { updated: 0 }.
 */
export const backfillProtectedAssetUnlockModes = internalMutation({
  args: {},
  handler: async (ctx) => {
    const docs = await ctx.db.query('protected_assets').collect();

    let updated = 0;
    for (const doc of docs) {
      const unlockMode = resolveProtectedAssetUnlockMode(doc);
      if (doc.unlockMode !== unlockMode) {
        await ctx.db.patch(doc._id, { unlockMode });
        updated++;
      }
    }

    return { updated };
  },
});

/**
 * Encrypt legacy plaintext license keys and drop redundant purchaser emails.
 * Re-run until it returns { updated: 0 }.
 */
export const migrateLegacyLicenseSubjectLinks = internalMutation({
  args: {},
  handler: async (ctx) => {
    const docs = await ctx.db
      .query('license_subject_links')
      .filter((q) =>
        q.or(q.neq(q.field('licenseKey'), null), q.neq(q.field('purchaserEmail'), null))
      )
      .take(200);

    let updated = 0;
    for (const doc of docs) {
      const licenseKeyEncrypted =
        doc.licenseKeyEncrypted ??
        (doc.licenseKey
          ? await encryptPii(doc.licenseKey, PII_PURPOSES.forensicsLicenseKey)
          : undefined);
      await ctx.db.patch(doc._id, {
        licenseKey: undefined,
        licenseKeyEncrypted,
        purchaserEmail: undefined,
      });
      updated++;
    }

    return { updated };
  },
});

/**
 * Detection-first remediation report for buyer verification records that were
 * historically attributed to the creator auth user instead of the buyer.
 */
export const listBuyerAttributionRemediationCandidates = internalQuery({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const requestedLimit = args.limit ?? DEFAULT_BUYER_ATTRIBUTION_REPORT_LIMIT;
    const limit = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(500, Math.trunc(requestedLimit)))
      : DEFAULT_BUYER_ATTRIBUTION_REPORT_LIMIT;
    return await listBuyerAttributionCandidates(ctx, limit);
  },
});

/**
 * Explicit, opt-in repair for selected buyer-attribution candidates. This only
 * moves verification bindings plus high-confidence license subject links. Any
 * ambiguous license links remain in the report for operator review.
 */
export const repairBuyerAttributionCandidates = internalMutation({
  args: {
    bindingIds: v.array(v.id('bindings')),
  },
  handler: async (ctx, args) => {
    const uniqueBindingIds = Array.from(new Set(args.bindingIds));
    const skippedBindings: Array<{ bindingId: Id<'bindings'>; reason: string }> = [];
    const repairedLicenseLinkIds = new Set<string>();
    const initialCandidates = new Map<Id<'bindings'>, BuyerAttributionCandidate | null>();
    let repairedBindings = 0;
    let repairedLicenseSubjectLinks = 0;
    let createdBuyerProviderLinks = 0;

    for (const bindingId of uniqueBindingIds) {
      const binding = (await ctx.db.get(bindingId)) as Doc<'bindings'> | null;
      initialCandidates.set(
        bindingId,
        binding ? await buildBuyerAttributionCandidate(ctx, binding) : null
      );
    }

    for (const bindingId of uniqueBindingIds) {
      const binding = (await ctx.db.get(bindingId)) as Doc<'bindings'> | null;
      if (!binding) {
        skippedBindings.push({ bindingId, reason: 'Binding no longer exists' });
        continue;
      }

      const candidate = initialCandidates.get(bindingId) ?? null;
      if (!candidate) {
        skippedBindings.push({
          bindingId,
          reason: 'Binding is no longer a repairable buyer-attribution candidate',
        });
        continue;
      }

      const existingBuyerBinding = (await ctx.db
        .query('bindings')
        .withIndex('by_auth_user_subject', (q) =>
          q
            .eq('authUserId', candidate.expectedBuyerAuthUserId)
            .eq('subjectId', candidate.subjectId)
        )
        .filter((q) =>
          q.and(
            q.eq(q.field('externalAccountId'), candidate.externalAccountId),
            q.or(q.eq(q.field('status'), 'active'), q.eq(q.field('status'), 'pending'))
          )
        )
        .first()) as Doc<'bindings'> | null;

      if (existingBuyerBinding && existingBuyerBinding._id !== binding._id) {
        await ctx.db.patch(binding._id, {
          status: 'revoked',
          reason: 'Merged into buyer-scoped verification binding during remediation',
          version: binding.version + 1,
          updatedAt: Date.now(),
        });
      } else {
        await ctx.db.patch(binding._id, {
          authUserId: candidate.expectedBuyerAuthUserId,
          version: binding.version + 1,
          updatedAt: Date.now(),
        });
      }
      repairedBindings += 1;

      const hasActiveBuyerProviderLink = candidate.relatedBuyerProviderLinks.some(
        (link) => link.status === 'active'
      );
      if (!hasActiveBuyerProviderLink) {
        await upsertBuyerProviderLinkRecord(ctx, {
          subjectId: candidate.subjectId,
          provider: candidate.provider,
          externalAccountId: candidate.externalAccountId,
          verificationMethod: 'account_link',
        });
        if (candidate.relatedBuyerProviderLinks.length === 0) {
          createdBuyerProviderLinks += 1;
        }
      }

      for (const relatedLicenseLink of candidate.relatedLicenseSubjectLinks) {
        if (
          !relatedLicenseLink.repairable ||
          repairedLicenseLinkIds.has(String(relatedLicenseLink.id))
        ) {
          continue;
        }

        const source = (await ctx.db.get(
          relatedLicenseLink.id
        )) as Doc<'license_subject_links'> | null;
        if (!source) {
          continue;
        }

        const targetId = await upsertLicenseSubjectLink(ctx, {
          authUserId: candidate.expectedBuyerAuthUserId,
          licenseSubject: source.licenseSubject,
          packageId: source.packageId,
          provider: source.provider,
          licenseKeyEncrypted: source.licenseKeyEncrypted,
          providerUserId: source.providerUserId,
          externalOrderId: source.externalOrderId,
          providerProductId: source.providerProductId,
        });

        if (targetId !== source._id) {
          await ctx.db.delete(source._id);
        }

        repairedLicenseLinkIds.add(String(source._id));
        repairedLicenseSubjectLinks += 1;
      }
    }

    return {
      repairedBindings,
      repairedLicenseSubjectLinks,
      createdBuyerProviderLinks,
      skippedBindings,
    };
  },
});

/**
 * Destructive helper for reset workflows.
 * Deletes provider connection rows and their provider-scoped dependents for one auth user.
 */
export const dangerouslyResetProviderDataForAuthUser = internalMutation({
  args: {
    authUserId: v.string(),
  },
  handler: async (ctx, args) => {
    const connections = await ctx.db
      .query('provider_connections')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))
      .collect();

    const connectionIds = new Set(connections.map((doc) => doc._id));

    const providerCredentials = [];
    const providerConnectionCapabilities = [];
    const providerCatalogMappings = [];
    const providerTransactions = [];
    const providerMemberships = [];
    const providerLicenses = [];

    for (const connection of connections) {
      providerCredentials.push(
        ...(await ctx.db
          .query('provider_credentials')
          .withIndex('by_connection', (q) => q.eq('providerConnectionId', connection._id))
          .collect())
      );
      providerConnectionCapabilities.push(
        ...(await ctx.db
          .query('provider_connection_capabilities')
          .withIndex('by_connection', (q) => q.eq('providerConnectionId', connection._id))
          .collect())
      );
      providerCatalogMappings.push(
        ...(await ctx.db
          .query('provider_catalog_mappings')
          .withIndex('by_connection', (q) => q.eq('providerConnectionId', connection._id))
          .collect())
      );
      providerTransactions.push(
        ...(await ctx.db
          .query('provider_transactions')
          .withIndex('by_connection', (q) => q.eq('providerConnectionId', connection._id))
          .collect())
      );
      providerMemberships.push(
        ...(await ctx.db
          .query('provider_memberships')
          .withIndex('by_connection', (q) => q.eq('providerConnectionId', connection._id))
          .collect())
      );
      providerLicenses.push(
        ...(await ctx.db
          .query('provider_licenses')
          .withIndex('by_connection', (q) => q.eq('providerConnectionId', connection._id))
          .collect())
      );
    }

    const transactionIds = new Set(providerTransactions.map((doc) => doc._id));
    const membershipIds = new Set(providerMemberships.map((doc) => doc._id));
    const licenseIds = new Set(providerLicenses.map((doc) => doc._id));

    const entitlementEvidence = (await ctx.db.query('entitlement_evidence').collect()).filter(
      (doc) =>
        doc.authUserId === args.authUserId ||
        (doc.providerConnectionId != null && connectionIds.has(doc.providerConnectionId)) ||
        (doc.transactionId != null && transactionIds.has(doc.transactionId)) ||
        (doc.membershipId != null && membershipIds.has(doc.membershipId)) ||
        (doc.licenseId != null && licenseIds.has(doc.licenseId))
    );

    const webhookEvents = await ctx.db
      .query('webhook_events')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))
      .collect();

    let deletedEntitlementEvidence = 0;
    for (const doc of entitlementEvidence) {
      await ctx.db.delete(doc._id);
      deletedEntitlementEvidence++;
    }

    let deletedWebhookEvents = 0;
    for (const doc of webhookEvents) {
      if (doc.providerConnectionId == null || connectionIds.has(doc.providerConnectionId)) {
        await ctx.db.delete(doc._id);
        deletedWebhookEvents++;
      }
    }

    for (const doc of providerCredentials) {
      await ctx.db.delete(doc._id);
    }
    for (const doc of providerConnectionCapabilities) {
      await ctx.db.delete(doc._id);
    }
    for (const doc of providerCatalogMappings) {
      await ctx.db.delete(doc._id);
    }
    for (const doc of providerTransactions) {
      await ctx.db.delete(doc._id);
    }
    for (const doc of providerMemberships) {
      await ctx.db.delete(doc._id);
    }
    for (const doc of providerLicenses) {
      await ctx.db.delete(doc._id);
    }
    for (const doc of connections) {
      await ctx.db.delete(doc._id);
    }

    return {
      providerConnections: connections.length,
      providerCredentials: providerCredentials.length,
      providerConnectionCapabilities: providerConnectionCapabilities.length,
      providerCatalogMappings: providerCatalogMappings.length,
      providerTransactions: providerTransactions.length,
      providerMemberships: providerMemberships.length,
      providerLicenses: providerLicenses.length,
      entitlementEvidence: deletedEntitlementEvidence,
      webhookEvents: deletedWebhookEvents,
    };
  },
});
