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
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from './_generated/server';
import { PII_PURPOSES } from './lib/credentialKeys';
import { upsertLicenseSubjectLink } from './lib/licenseSubjectLink';
import { encryptPii } from './lib/piiCrypto';
import { resolveProtectedAssetUnlockMode } from './lib/protectedAssetUnlockMode';
import { enqueueExistingRoleOutboxJobInWorkpool } from './lib/roleSyncWorkpoolDispatch';
import {
  detectCanonicalAuthResolutionForSubject,
  ensureCanonicalAuthUserIdForSubject,
  upsertBuyerProviderLinkRecord,
} from './subjects';

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
type SubjectOwnershipResolution = 'better_auth' | 'existing_light' | 'new_light' | 'ambiguous';
type SubjectOwnershipRelatedBinding = {
  id: Id<'bindings'>;
  authUserId: string;
  status: Doc<'bindings'>['status'];
  createdAt: number;
  updatedAt: number;
  externalAccountId: Id<'external_accounts'>;
  provider?: Doc<'external_accounts'>['provider'];
  providerUserId?: string;
  providerUsername?: string;
};
type SubjectOwnershipCandidate = {
  subjectId: Id<'subjects'>;
  currentAuthUserId: string;
  discordUserId: string;
  subjectDisplayName?: string;
  expectedAuthUserId?: string;
  expectedLightAuthMarker?: string;
  ambiguousAuthUserIds?: string[];
  resolution: SubjectOwnershipResolution;
  relatedBuyerProviderLinks: BuyerAttributionRelatedBuyerProviderLink[];
  relatedVerificationBindings: SubjectOwnershipRelatedBinding[];
  repairable: boolean;
};
const DEFAULT_BUYER_ATTRIBUTION_REPORT_LIMIT = 50;
const DEFAULT_SUBJECT_OWNERSHIP_REPORT_LIMIT = 50;
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

function isProviderScopedSubjectIdentity(primaryDiscordUserId: string): boolean {
  return primaryDiscordUserId.includes(':');
}

function normalizeProviderTierRefs(providerTierRefs: Array<string | undefined>): string[] {
  return Array.from(
    new Set(
      providerTierRefs
        .map((providerTierRef) => providerTierRef?.trim())
        .filter((providerTierRef): providerTierRef is string => Boolean(providerTierRef))
    )
  );
}

function parseEntitlementPurchaseReference(
  provider: Doc<'entitlements'>['sourceProvider'],
  sourceReference: string
): { externalOrderId: string } | null {
  const trimmed = sourceReference.trim();
  if (!trimmed) {
    return null;
  }

  const parts = trimmed.split(':');
  if (parts.length >= 2 && parts[0] === provider && parts[1]) {
    return {
      externalOrderId: parts[1],
    };
  }

  return { externalOrderId: trimmed };
}

async function entitlementHasActiveTierEvidence(
  ctx: Pick<QueryCtx, 'db'>,
  entitlement: Doc<'entitlements'>
): Promise<boolean> {
  const evidenceRows = await ctx.db
    .query('entitlement_evidence')
    .withIndex('by_source_reference', (q) =>
      q
        .eq('providerKey', entitlement.sourceProvider)
        .eq('sourceReference', entitlement.sourceReference)
    )
    .filter((q) => q.eq(q.field('authUserId'), entitlement.authUserId))
    .filter((q) => q.eq(q.field('subjectId'), entitlement.subjectId))
    .filter((q) => q.eq(q.field('productId'), entitlement.productId))
    .collect();

  return evidenceRows.some(
    (evidence) =>
      evidence.status === 'active' &&
      Array.isArray(evidence.providerTierRefs) &&
      evidence.providerTierRefs.some((providerTierRef) => providerTierRef.trim().length > 0)
  );
}

function purchaseFactMatchesEntitlementProduct(args: {
  purchaseFact: Doc<'purchase_facts'>;
  entitlement: Doc<'entitlements'>;
  catalogProduct: Doc<'product_catalog'> | null;
}): boolean {
  const allowedProviderProductRefs = new Set<string>();
  allowedProviderProductRefs.add(args.entitlement.productId);
  if (args.catalogProduct?.providerProductRef) {
    allowedProviderProductRefs.add(args.catalogProduct.providerProductRef);
  }
  if (args.catalogProduct?.productId) {
    allowedProviderProductRefs.add(args.catalogProduct.productId);
  }
  return allowedProviderProductRefs.has(args.purchaseFact.providerProductId);
}

async function findRepairPurchaseFactForEntitlement(
  ctx: Pick<QueryCtx, 'db'>,
  entitlement: Doc<'entitlements'>
): Promise<Doc<'purchase_facts'> | null> {
  const purchaseRef = parseEntitlementPurchaseReference(
    entitlement.sourceProvider,
    entitlement.sourceReference
  );
  if (!purchaseRef) {
    return null;
  }

  const catalogProduct = entitlement.catalogProductId
    ? await ctx.db.get(entitlement.catalogProductId)
    : null;
  const purchaseFacts = await ctx.db
    .query('purchase_facts')
    .withIndex('by_auth_user_provider_order', (q) =>
      q
        .eq('authUserId', entitlement.authUserId)
        .eq('provider', entitlement.sourceProvider)
        .eq('externalOrderId', purchaseRef.externalOrderId)
    )
    .collect();

  const matchingPurchaseFacts = purchaseFacts.filter((purchaseFact) => {
    if (purchaseFact.lifecycleStatus !== 'active') {
      return false;
    }
    if (
      entitlement.subjectId &&
      purchaseFact.subjectId &&
      purchaseFact.subjectId !== entitlement.subjectId
    ) {
      return false;
    }
    return purchaseFactMatchesEntitlementProduct({
      purchaseFact,
      entitlement,
      catalogProduct,
    });
  });

  return matchingPurchaseFacts.length === 1 ? matchingPurchaseFacts[0] : null;
}

async function listRelatedBuyerProviderLinks(
  ctx: Pick<QueryCtx, 'db'>,
  subjectId: Id<'subjects'>,
  externalAccountId?: Id<'external_accounts'>
): Promise<BuyerAttributionRelatedBuyerProviderLink[]> {
  const links = externalAccountId
    ? ((await ctx.db
        .query('buyer_provider_links')
        .withIndex('by_subject_external', (q) =>
          q.eq('subjectId', subjectId).eq('externalAccountId', externalAccountId)
        )
        .collect()) as Doc<'buyer_provider_links'>[])
    : ((await ctx.db
        .query('buyer_provider_links')
        .withIndex('by_subject', (q) => q.eq('subjectId', subjectId))
        .collect()) as Doc<'buyer_provider_links'>[]);

  return links.map((link) => ({
    id: link._id,
    subjectId: link.subjectId,
    status: link.status,
    verificationMethod: link.verificationMethod,
    linkedAt: link.linkedAt,
    createdAt: link.createdAt,
    updatedAt: link.updatedAt,
  }));
}

async function listAllRelatedVerificationBindings(
  ctx: Pick<QueryCtx, 'db'>,
  subjectId: Id<'subjects'>
): Promise<SubjectOwnershipRelatedBinding[]> {
  const bindings = (await ctx.db.query('bindings').collect()) as Doc<'bindings'>[];

  const relatedBindings: SubjectOwnershipRelatedBinding[] = [];
  for (const binding of bindings) {
    if (
      binding.subjectId !== subjectId ||
      binding.bindingType !== 'verification' ||
      !REPORTABLE_BINDING_STATUSES.has(binding.status)
    ) {
      continue;
    }

    const externalAccount = await ctx.db.get(binding.externalAccountId);
    relatedBindings.push({
      id: binding._id,
      authUserId: binding.authUserId,
      status: binding.status,
      createdAt: binding.createdAt,
      updatedAt: binding.updatedAt,
      externalAccountId: binding.externalAccountId,
      provider: externalAccount?.provider,
      providerUserId: externalAccount?.providerUserId,
      providerUsername: externalAccount?.providerUsername,
    });
  }

  return relatedBindings;
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

  const relatedBuyerProviderLinks = await listRelatedBuyerProviderLinks(
    ctx,
    binding.subjectId,
    binding.externalAccountId
  );

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
  const bindings = ((await ctx.db.query('bindings').collect()) as Doc<'bindings'>[]).reverse();

  for (const binding of bindings) {
    const candidate = await buildBuyerAttributionCandidate(ctx, binding);
    if (!candidate) {
      continue;
    }
    candidates.push(candidate);
    if (candidates.length >= limit) {
      break;
    }
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

async function buildSubjectOwnershipCandidate(
  ctx: Pick<QueryCtx, 'db' | 'runQuery'>,
  subject: Doc<'subjects'>
): Promise<SubjectOwnershipCandidate | null> {
  if (!subject.authUserId || subject.status !== 'active') {
    return null;
  }

  const relatedBuyerProviderLinks = await listRelatedBuyerProviderLinks(ctx, subject._id);
  const relatedVerificationBindings = await listAllRelatedVerificationBindings(ctx, subject._id);

  if (isProviderScopedSubjectIdentity(subject.primaryDiscordUserId)) {
    const conflictingAuthUserIds = Array.from(
      new Set(
        relatedVerificationBindings
          .map((binding) => binding.authUserId)
          .filter((authUserId) => authUserId !== subject.authUserId)
      )
    );

    if (conflictingAuthUserIds.length === 0) {
      return null;
    }

    return {
      subjectId: subject._id,
      currentAuthUserId: subject.authUserId,
      discordUserId: subject.primaryDiscordUserId,
      subjectDisplayName: subject.displayName,
      ambiguousAuthUserIds: [subject.authUserId, ...conflictingAuthUserIds].sort(),
      resolution: 'ambiguous',
      relatedBuyerProviderLinks,
      relatedVerificationBindings,
      repairable: false,
    };
  }

  const resolution = await detectCanonicalAuthResolutionForSubject(ctx, subject);
  if (resolution.kind === 'resolved' && resolution.authUserId === subject.authUserId) {
    return null;
  }
  if (resolution.kind === 'ambiguous' && resolution.authUserIds.includes(subject.authUserId)) {
    return null;
  }

  return {
    subjectId: subject._id,
    currentAuthUserId: subject.authUserId,
    discordUserId: subject.primaryDiscordUserId,
    subjectDisplayName: subject.displayName,
    expectedAuthUserId: resolution.kind === 'resolved' ? resolution.authUserId : undefined,
    expectedLightAuthMarker:
      resolution.kind === 'materialize_light' ? resolution.marker : undefined,
    ambiguousAuthUserIds: resolution.kind === 'ambiguous' ? resolution.authUserIds : undefined,
    resolution:
      resolution.kind === 'resolved'
        ? resolution.source
        : resolution.kind === 'materialize_light'
          ? 'new_light'
          : 'ambiguous',
    relatedBuyerProviderLinks,
    relatedVerificationBindings,
    repairable: resolution.kind !== 'ambiguous',
  };
}

async function listSubjectOwnershipCandidates(
  ctx: Pick<QueryCtx, 'db' | 'runQuery'>,
  limit: number
) {
  const candidates: SubjectOwnershipCandidate[] = [];
  const subjects = ((await ctx.db.query('subjects').collect()) as Doc<'subjects'>[]).reverse();

  for (const subject of subjects) {
    const candidate = await buildSubjectOwnershipCandidate(ctx, subject);
    if (!candidate) {
      continue;
    }
    candidates.push(candidate);
    if (candidates.length >= limit) {
      break;
    }
  }

  return {
    scannedAt: Date.now(),
    summary: {
      candidateSubjects: candidates.length,
      repairableSubjects: candidates.filter((candidate) => candidate.repairable).length,
      reviewOnlySubjects: candidates.filter((candidate) => !candidate.repairable).length,
      buyerProviderLinksForReview: candidates.reduce(
        (total, candidate) => total + candidate.relatedBuyerProviderLinks.length,
        0
      ),
      followUpVerificationBindings: candidates.reduce(
        (total, candidate) => total + candidate.relatedVerificationBindings.length,
        0
      ),
    },
    candidates,
  };
}

async function repairBuyerAttributionBindingIds(
  ctx: Pick<MutationCtx, 'db'>,
  bindingIds: readonly Id<'bindings'>[]
) {
  const uniqueBindingIds = Array.from(new Set(bindingIds));
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
        q.eq('authUserId', candidate.expectedBuyerAuthUserId).eq('subjectId', candidate.subjectId)
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
 * Detection-first remediation report for subjects whose auth owner no longer
 * matches the canonical Discord account owner from Better Auth.
 */
export const listSubjectOwnershipRemediationCandidates = internalQuery({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const requestedLimit = args.limit ?? DEFAULT_SUBJECT_OWNERSHIP_REPORT_LIMIT;
    const limit = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(500, Math.trunc(requestedLimit)))
      : DEFAULT_SUBJECT_OWNERSHIP_REPORT_LIMIT;
    return await listSubjectOwnershipCandidates(ctx, limit);
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
  handler: async (ctx, args) => await repairBuyerAttributionBindingIds(ctx, args.bindingIds),
});

/**
 * Explicit, opt-in repair for selected subjects with wrong auth ownership.
 * After re-homing each subject, this reuses the existing buyer-attribution
 * repair flow for any verification bindings that become newly suspect.
 */
export const repairSubjectOwnershipCandidates = internalMutation({
  args: {
    subjectIds: v.array(v.id('subjects')),
  },
  handler: async (ctx, args) => {
    const uniqueSubjectIds = Array.from(new Set(args.subjectIds));
    const skippedSubjects: Array<{ subjectId: Id<'subjects'>; reason: string }> = [];
    const followUpBindingIds = new Set<Id<'bindings'>>();
    let repairedSubjects = 0;
    let createdLightAuthUsers = 0;

    for (const subjectId of uniqueSubjectIds) {
      const subject = (await ctx.db.get(subjectId)) as Doc<'subjects'> | null;
      if (!subject) {
        skippedSubjects.push({ subjectId, reason: 'Subject no longer exists' });
        continue;
      }

      const candidate = await buildSubjectOwnershipCandidate(ctx, subject);
      if (!candidate) {
        skippedSubjects.push({
          subjectId,
          reason: 'Subject is no longer a repairable ownership candidate',
        });
        continue;
      }
      if (!candidate.repairable) {
        skippedSubjects.push({
          subjectId,
          reason: 'Subject ownership is ambiguous and requires manual review',
        });
        continue;
      }

      const resolved = await ensureCanonicalAuthUserIdForSubject(ctx, subject);
      if (resolved.source === 'new_light') {
        createdLightAuthUsers += 1;
      }

      await ctx.db.patch(subject._id, {
        authUserId: resolved.authUserId,
        updatedAt: Date.now(),
      });
      repairedSubjects += 1;

      const relatedBindings = (await ctx.db
        .query('bindings')
        .withIndex('by_auth_user_subject', (q) =>
          q.eq('authUserId', candidate.currentAuthUserId).eq('subjectId', subject._id)
        )
        .collect()) as Doc<'bindings'>[];
      for (const binding of relatedBindings) {
        if (
          binding.bindingType !== 'verification' ||
          !REPORTABLE_BINDING_STATUSES.has(binding.status)
        ) {
          continue;
        }
        followUpBindingIds.add(binding._id);
      }
    }

    const bindingRepairResult =
      followUpBindingIds.size > 0
        ? await repairBuyerAttributionBindingIds(ctx, Array.from(followUpBindingIds))
        : {
            repairedBindings: 0,
            repairedLicenseSubjectLinks: 0,
            createdBuyerProviderLinks: 0,
            skippedBindings: [],
          };

    return {
      repairedSubjects,
      createdLightAuthUsers,
      skippedSubjects,
      ...bindingRepairResult,
    };
  },
});

export const repairEntitlementEvidenceTierRefs = internalMutation({
  args: {
    cursor: v.optional(v.union(v.string(), v.null())),
    limit: v.optional(v.number()),
  },
  returns: v.object({
    scanned: v.number(),
    repaired: v.number(),
    skipped: v.number(),
    remaining: v.number(),
    continueCursor: v.optional(v.union(v.string(), v.null())),
    isDone: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const limit = Math.max(1, Math.min(args.limit ?? 100, 500));
    const page = await ctx.db
      .query('entitlements')
      .withIndex('by_status', (q) => q.eq('status', 'active'))
      .paginate({ cursor: args.cursor ?? null, numItems: limit });
    const now = Date.now();

    let scanned = 0;
    let repaired = 0;
    let skipped = 0;

    for (const entitlement of page.page) {
      if (await entitlementHasActiveTierEvidence(ctx, entitlement)) {
        continue;
      }

      scanned++;
      const purchaseFact = await findRepairPurchaseFactForEntitlement(ctx, entitlement);
      if (!purchaseFact) {
        skipped++;
        continue;
      }

      const providerTierRefs = normalizeProviderTierRefs([
        purchaseFact.providerProductVersionId,
        purchaseFact.externalVariantId,
      ]);
      if (providerTierRefs.length === 0) {
        skipped++;
        continue;
      }

      const existing = await ctx.db
        .query('entitlement_evidence')
        .withIndex('by_source_reference', (q) =>
          q
            .eq('providerKey', entitlement.sourceProvider)
            .eq('sourceReference', entitlement.sourceReference)
        )
        .filter((q) => q.eq(q.field('authUserId'), entitlement.authUserId))
        .filter((q) => q.eq(q.field('subjectId'), entitlement.subjectId))
        .filter((q) => q.eq(q.field('productId'), entitlement.productId))
        .first();

      if (existing) {
        await ctx.db.patch(existing._id, {
          subjectId: entitlement.subjectId,
          status: 'active',
          productId: entitlement.productId,
          catalogProductId: entitlement.catalogProductId ?? existing.catalogProductId,
          providerTierRefs,
          observedAt: now,
          updatedAt: now,
        });
      } else {
        await ctx.db.insert('entitlement_evidence', {
          authUserId: entitlement.authUserId,
          subjectId: entitlement.subjectId,
          providerKey: entitlement.sourceProvider,
          sourceReference: entitlement.sourceReference,
          evidenceType: 'purchase_fact_remediation',
          status: 'active',
          productId: entitlement.productId,
          catalogProductId: entitlement.catalogProductId,
          providerTierRefs,
          observedAt: now,
          createdAt: now,
          updatedAt: now,
        });
      }

      repaired++;
    }

    return {
      scanned,
      repaired,
      skipped,
      remaining: page.isDone ? 0 : 1,
      continueCursor: page.continueCursor,
      isDone: page.isDone,
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

/**
 * Re-drive dead-lettered role_sync / role_removal jobs through the Workpool.
 *
 * The legacy bot poller burned these into dead_letter in ~22s by ignoring
 * backoff. This resets each row to pending and re-enqueues it so it runs again
 * with proper retry handling. Run with:
 *   npx convex run migrations:redriveDeadLetterRoleSync --prod
 * Re-run until `remaining` reaches 0. Idempotent: only re-picks rows that are
 * still in dead_letter.
 */
export const redriveDeadLetterRoleSync = internalMutation({
  args: {
    limit: v.optional(v.number()),
  },
  returns: v.object({
    processed: v.number(),
    skipped: v.number(),
    remaining: v.number(),
  }),
  handler: async (ctx, args) => {
    if (process.env.ROLE_SYNC_VIA_WORKPOOL !== 'true') {
      throw new Error('ROLE_SYNC_VIA_WORKPOOL must be enabled to redrive role sync jobs');
    }

    const limit = Math.max(1, Math.min(args.limit ?? 100, 500));
    const pageSize = limit + 1;
    const roleSyncTargets = await ctx.db
      .query('outbox_jobs')
      .withIndex('by_status_job_type', (q) =>
        q.eq('status', 'dead_letter').eq('jobType', 'role_sync')
      )
      .take(pageSize);
    const roleRemovalTargets = await ctx.db
      .query('outbox_jobs')
      .withIndex('by_status_job_type', (q) =>
        q.eq('status', 'dead_letter').eq('jobType', 'role_removal')
      )
      .take(pageSize);
    const targets = [...roleSyncTargets, ...roleRemovalTargets].sort(
      (a, b) => a.createdAt - b.createdAt
    );
    const batch = targets.slice(0, limit);

    let processed = 0;
    let skipped = 0;
    const now = Date.now();

    for (const job of batch) {
      const dispatch = await enqueueExistingRoleOutboxJobInWorkpool(ctx, job);
      if (!dispatch.enqueued) {
        skipped++;
        continue;
      }

      // Reset the projection row only after Workpool accepts the durable work.
      await ctx.db.patch(job._id, {
        status: 'pending',
        retryCount: 0,
        lastError: undefined,
        nextRetryAt: undefined,
        workpoolEnqueuedAt: now,
        updatedAt: now,
      });
      processed++;
    }

    return {
      processed,
      skipped,
      // This is a bounded page signal, not a full backlog count. Keep re-running until it is 0.
      remaining: Math.max(targets.length - processed - skipped, 0),
    };
  },
});
