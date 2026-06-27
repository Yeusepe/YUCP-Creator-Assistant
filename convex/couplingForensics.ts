import { ConvexError, v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc } from './_generated/dataModel';
import { mutation, type QueryCtx, query } from './_generated/server';
import { requireApiSecret } from './lib/apiAuth';
import { BILLING_CAPABILITY_KEYS } from './lib/billingCapabilities';

const PACKAGE_ID_RE = /^[a-z0-9\-_./:]{1,128}$/;
const TOKEN_HASH_RE = /^[0-9a-f]{64}$/;
const COUPLING_TRACE_CANDIDATE_LIMIT = 512;
const COUPLING_TRACE_MATCHES_PER_TOKEN_LIMIT = 64;
const COUPLING_TRACE_MATCH_TOTAL_LIMIT = 512;
const COUPLING_TRACE_ROW_PAGE_SIZE = 512;
const COUPLING_TRACE_ROW_SCAN_LIMIT = COUPLING_TRACE_CANDIDATE_LIMIT * 4;

function assertPackageId(packageId: string): void {
  if (!PACKAGE_ID_RE.test(packageId)) {
    throw new ConvexError(`Invalid packageId format: ${packageId}`);
  }
}

function normalizeTokenHashes(tokenHashes: string[]): string[] {
  const normalized = Array.from(
    new Set(tokenHashes.map((value) => value.trim().toLowerCase()).filter(Boolean))
  );
  if (normalized.length === 0) {
    throw new ConvexError('At least one token hash is required');
  }
  if (normalized.length > 512) {
    throw new ConvexError('Too many coupling token hashes');
  }
  for (const tokenHash of normalized) {
    if (!TOKEN_HASH_RE.test(tokenHash)) {
      throw new ConvexError(`Invalid coupling token hash: ${tokenHash}`);
    }
  }
  return normalized;
}

type TraceMatchCandidate = {
  assetPath: string;
  licenseSubject: string;
  tokenHash: string;
};

function normalizeTraceMatchCandidates(candidates: TraceMatchCandidate[]): TraceMatchCandidate[] {
  if (candidates.length > COUPLING_TRACE_CANDIDATE_LIMIT) {
    throw new ConvexError('Too many coupling trace match candidates');
  }

  const normalized: TraceMatchCandidate[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const assetPath = candidate.assetPath.trim();
    const licenseSubject = candidate.licenseSubject.trim().toLowerCase();
    const tokenHash = candidate.tokenHash.trim().toLowerCase();
    if (!assetPath) {
      throw new ConvexError('Invalid match candidate assetPath');
    }
    if (!TOKEN_HASH_RE.test(licenseSubject)) {
      throw new ConvexError('Invalid match candidate licenseSubject');
    }
    if (!TOKEN_HASH_RE.test(tokenHash)) {
      throw new ConvexError('Invalid match candidate tokenHash');
    }

    const key = `${assetPath}\0${licenseSubject}\0${tokenHash}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    normalized.push({ assetPath, licenseSubject, tokenHash });
  }
  return normalized;
}

function isArchivedPackage(
  registration: Pick<Doc<'package_registry'>, 'status'> | null | undefined
): boolean {
  return registration?.status === 'archived';
}

/**
 * Non-secret license identifier for the forensics list view: the provider plus a short,
 * stable fingerprint of the license subject (SHA-256 of the key). Identifies *which* license
 * without revealing it.
 */
function buildLicenseMaskedLabel(provider: string | undefined, licenseSubject: string): string {
  const fingerprint = licenseSubject.slice(0, 10);
  return provider ? `${provider} · ${fingerprint}` : fingerprint;
}

type ResolvedBuyerIdentity = {
  buyerProviderUserId?: string;
  buyerProviderUsername?: string;
  buyerSubjectDisplayName?: string;
  buyerSubjectDiscordUserId?: string;
};

async function resolveBuyerIdentityFromProviderRefs(
  ctx: Pick<QueryCtx, 'db'>,
  args: {
    authUserId: string;
    provider: string;
    providerUserId?: string;
    externalOrderId?: string;
  }
): Promise<ResolvedBuyerIdentity | null> {
  let buyerProviderUserId = args.providerUserId;
  let buyerProviderUsername: string | undefined;
  let buyerSubjectDisplayName: string | undefined;
  let buyerSubjectDiscordUserId: string | undefined;

  const hydrateFromProviderAccount = async (providerUserId: string) => {
    const externalAccount = await ctx.db
      .query('external_accounts')
      .withIndex('by_provider_user', (q) =>
        q
          .eq('provider', args.provider as Doc<'external_accounts'>['provider'])
          .eq('providerUserId', providerUserId)
      )
      .filter((q) => q.eq(q.field('status'), 'active'))
      .first();

    if (!externalAccount) {
      return;
    }

    buyerProviderUsername = externalAccount.providerUsername;
    const binding = await ctx.db
      .query('bindings')
      .withIndex('by_auth_user_external', (q) =>
        q.eq('authUserId', args.authUserId).eq('externalAccountId', externalAccount._id)
      )
      .filter((q) => q.eq(q.field('status'), 'active'))
      .first();

    if (!binding) {
      return;
    }

    const subject = await ctx.db.get(binding.subjectId);
    buyerSubjectDisplayName = subject?.displayName;
    buyerSubjectDiscordUserId = subject?.primaryDiscordUserId;
  };

  if (buyerProviderUserId) {
    await hydrateFromProviderAccount(buyerProviderUserId);
  }

  if (!buyerSubjectDisplayName && !buyerSubjectDiscordUserId && args.externalOrderId) {
    const purchaseFact = await ctx.db
      .query('purchase_facts')
      .withIndex('by_auth_user_provider_order', (q) =>
        q
          .eq('authUserId', args.authUserId)
          .eq('provider', args.provider as Doc<'purchase_facts'>['provider'])
          .eq('externalOrderId', args.externalOrderId as string)
      )
      .first();

    buyerProviderUserId ??= purchaseFact?.providerUserId;
    if (purchaseFact?.subjectId) {
      const subject = await ctx.db.get(purchaseFact.subjectId);
      buyerSubjectDisplayName = subject?.displayName;
      buyerSubjectDiscordUserId = subject?.primaryDiscordUserId;
    }

    if (buyerProviderUserId && !buyerProviderUsername) {
      await hydrateFromProviderAccount(buyerProviderUserId);
    }
  }

  if (
    !buyerProviderUserId &&
    !buyerProviderUsername &&
    !buyerSubjectDisplayName &&
    !buyerSubjectDiscordUserId
  ) {
    return null;
  }

  return {
    buyerProviderUserId,
    buyerProviderUsername,
    buyerSubjectDisplayName,
    buyerSubjectDiscordUserId,
  };
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
        .sort((left: string, right: string) => left.localeCompare(right)),
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
            leftLabel.localeCompare(rightLabel) || left.packageId.localeCompare(right.packageId)
          );
        }),
    };
  },
});

export const lookupTraceMatchesForAuthUser = query({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    packageId: v.string(),
    tokenHashes: v.optional(v.array(v.string())),
    matchedCandidates: v.optional(
      v.array(
        v.object({
          assetPath: v.string(),
          licenseSubject: v.string(),
          tokenHash: v.string(),
        })
      )
    ),
  },
  returns: v.object({
    capabilityEnabled: v.boolean(),
    packageOwned: v.boolean(),
    matches: v.array(
      v.object({
        tokenHash: v.string(),
        licenseSubject: v.string(),
        assetPath: v.string(),
        correlationId: v.string(),
        createdAt: v.number(),
        runtimeArtifactVersion: v.string(),
        runtimePlaintextSha256: v.string(),
        machineFingerprintHash: v.string(),
        projectIdHash: v.string(),
        grantId: v.optional(v.string()),
        packFamily: v.optional(v.string()),
        packVersion: v.optional(v.string()),
        provider: v.optional(v.string()),
        licenseMasked: v.optional(v.string()),
        licenseKeyEncrypted: v.optional(v.string()),
        providerProductId: v.optional(v.string()),
        buyerProviderUserId: v.optional(v.string()),
        buyerProviderUsername: v.optional(v.string()),
        buyerSubjectDisplayName: v.optional(v.string()),
        buyerSubjectDiscordUserId: v.optional(v.string()),
      })
    ),
    unmatchedTokenHashes: v.array(v.string()),
    truncated: v.boolean(),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    assertPackageId(args.packageId);
    const matchedCandidates = normalizeTraceMatchCandidates(args.matchedCandidates ?? []);
    const tokenHashes =
      args.tokenHashes !== undefined
        ? normalizeTokenHashes(args.tokenHashes)
        : Array.from(new Set(matchedCandidates.map((candidate) => candidate.tokenHash)));
    if (tokenHashes.length === 0 && matchedCandidates.length === 0) {
      throw new ConvexError('At least one coupling trace match candidate is required');
    }

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
        matches: [],
        unmatchedTokenHashes: tokenHashes,
        truncated: false,
      };
    }

    const registration = await ctx.runQuery(internal.packageRegistry.getRegistration, {
      packageId: args.packageId,
    });
    if (
      !registration ||
      registration.yucpUserId !== args.authUserId ||
      isArchivedPackage(registration)
    ) {
      return {
        capabilityEnabled: true,
        packageOwned: false,
        matches: [],
        unmatchedTokenHashes: tokenHashes,
        truncated: false,
      };
    }

    const matches: Array<{
      tokenHash: string;
      licenseSubject: string;
      assetPath: string;
      correlationId: string;
      createdAt: number;
      runtimeArtifactVersion: string;
      runtimePlaintextSha256: string;
      machineFingerprintHash: string;
      projectIdHash: string;
      grantId?: string;
      packFamily?: string;
      packVersion?: string;
      provider?: string;
      licenseMasked?: string;
      licenseKeyEncrypted?: string;
      providerProductId?: string;
      buyerProviderUserId?: string;
      buyerProviderUsername?: string;
      buyerSubjectDisplayName?: string;
      buyerSubjectDiscordUserId?: string;
    }> = [];
    const matchedTokenHashes = new Set<string>();
    const resolvedIdentityBySubject = new Map<
      string,
      Promise<{
        provider?: string;
        licenseKeyEncrypted?: string;
        providerProductId?: string;
        buyerProviderUserId?: string;
        buyerProviderUsername?: string;
        buyerSubjectDisplayName?: string;
        buyerSubjectDiscordUserId?: string;
      } | null>
    >();

    const resolveIdentityForSubject = (
      licenseSubject: string
    ): Promise<{
      provider?: string;
      licenseKeyEncrypted?: string;
      providerProductId?: string;
      buyerProviderUserId?: string;
      buyerProviderUsername?: string;
      buyerSubjectDisplayName?: string;
      buyerSubjectDiscordUserId?: string;
    } | null> => {
      const existing = resolvedIdentityBySubject.get(licenseSubject);
      if (existing) {
        return existing;
      }

      const pending = (async () => {
        const identity = await ctx.db
          .query('license_subject_links')
          .withIndex('by_auth_user_subject', (q) =>
            q.eq('authUserId', args.authUserId).eq('licenseSubject', licenseSubject)
          )
          .first();
        if (!identity) {
          return null;
        }
        const resolved = await resolveBuyerIdentityFromProviderRefs(ctx, {
          authUserId: args.authUserId,
          provider: identity.provider,
          providerUserId: identity.providerUserId,
          externalOrderId: identity.externalOrderId,
        });

        return {
          provider: identity.provider,
          licenseKeyEncrypted: identity.licenseKeyEncrypted,
          providerProductId: identity.providerProductId,
          buyerProviderUserId: resolved?.buyerProviderUserId ?? identity.providerUserId,
          buyerProviderUsername: resolved?.buyerProviderUsername,
          buyerSubjectDisplayName: resolved?.buyerSubjectDisplayName,
          buyerSubjectDiscordUserId: resolved?.buyerSubjectDiscordUserId,
        };
      })();

      resolvedIdentityBySubject.set(licenseSubject, pending);
      return pending;
    };

    const unmatchedTokenHashSet = new Set<string>();
    let truncated = false;

    const appendTraceMatch = async (row: Doc<'coupling_trace_records'>) => {
      matchedTokenHashes.add(row.tokenHash);

      const identity = await resolveIdentityForSubject(row.licenseSubject);

      matches.push({
        tokenHash: row.tokenHash,
        licenseSubject: row.licenseSubject,
        assetPath: row.assetPath,
        correlationId: row.correlationId,
        createdAt: row.createdAt,
        runtimeArtifactVersion: row.runtimeArtifactVersion,
        runtimePlaintextSha256: row.runtimePlaintextSha256,
        machineFingerprintHash: row.machineFingerprintHash,
        projectIdHash: row.projectIdHash,
        grantId: row.grantId,
        packFamily: row.packFamily,
        packVersion: row.packVersion,
        provider: identity?.provider ?? row.provider,
        licenseMasked: buildLicenseMaskedLabel(identity?.provider ?? row.provider, row.licenseSubject),
        licenseKeyEncrypted: identity?.licenseKeyEncrypted,
        providerProductId: identity?.providerProductId,
        buyerProviderUserId: identity?.buyerProviderUserId,
        buyerProviderUsername: identity?.buyerProviderUsername,
        buyerSubjectDisplayName: identity?.buyerSubjectDisplayName,
        buyerSubjectDiscordUserId: identity?.buyerSubjectDiscordUserId,
      });
    };

    if (matchedCandidates.length > 0) {
      for (const candidate of matchedCandidates) {
        if (matches.length >= COUPLING_TRACE_MATCH_TOTAL_LIMIT) {
          truncated = true;
          break;
        }
        const row = await ctx.db
          .query('coupling_trace_records')
          .withIndex('by_auth_package_token_subject_asset_created', (q) =>
            q
              .eq('authUserId', args.authUserId)
              .eq('packageId', args.packageId)
              .eq('tokenHash', candidate.tokenHash)
              .eq('licenseSubject', candidate.licenseSubject)
              .eq('assetPath', candidate.assetPath)
          )
          .order('desc')
          .first();

        if (!row) {
          unmatchedTokenHashSet.add(candidate.tokenHash);
          continue;
        }

        await appendTraceMatch(row);
      }
    } else {
      for (const tokenHash of tokenHashes) {
        const remainingMatchBudget = COUPLING_TRACE_MATCH_TOTAL_LIMIT - matches.length;
        if (remainingMatchBudget <= 0) {
          truncated = true;
          break;
        }
        const matchLimit = Math.min(COUPLING_TRACE_MATCHES_PER_TOKEN_LIMIT, remainingMatchBudget);
        const rows = await ctx.db
          .query('coupling_trace_records')
          .withIndex('by_auth_package_token_created', (q) =>
            q
              .eq('authUserId', args.authUserId)
              .eq('packageId', args.packageId)
              .eq('tokenHash', tokenHash)
          )
          .order('desc')
          .take(matchLimit);

        if (rows.length === 0) {
          unmatchedTokenHashSet.add(tokenHash);
          continue;
        }

        for (const row of rows) {
          await appendTraceMatch(row);
        }
      }
    }

    return {
      capabilityEnabled: true,
      packageOwned: true,
      matches,
      unmatchedTokenHashes: Array.from(unmatchedTokenHashSet).filter(
        (tokenHash) => !matchedTokenHashes.has(tokenHash)
      ),
      truncated,
    };
  },
});

export const resolveBuyerIdentityForAuthUser = query({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    provider: v.string(),
    providerUserId: v.optional(v.string()),
    externalOrderId: v.optional(v.string()),
  },
  returns: v.union(
    v.null(),
    v.object({
      buyerProviderUserId: v.optional(v.string()),
      buyerProviderUsername: v.optional(v.string()),
      buyerSubjectDisplayName: v.optional(v.string()),
      buyerSubjectDiscordUserId: v.optional(v.string()),
    })
  ),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    return await resolveBuyerIdentityFromProviderRefs(ctx, args);
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
      v.literal('matched'),
      v.literal('no_match'),
      v.literal('tampered_suspected'),
      v.literal('hostile_unknown'),
      v.literal('no_candidate_assets'),
      v.literal('denied'),
      v.literal('error')
    ),
    requestedTokenCount: v.number(),
    matchedTokenCount: v.number(),
    uploadSha256: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    assertPackageId(args.packageId);
    await ctx.db.insert('audit_events', {
      authUserId: args.authUserId,
      eventType: 'coupling.lookup.performed',
      actorType: 'system',
      metadata: {
        packageId: args.packageId,
        source: args.source,
        status: args.status,
        requestedTokenCount: args.requestedTokenCount,
        matchedTokenCount: args.matchedTokenCount,
        uploadSha256: args.uploadSha256,
      },
      correlationId: `${args.source}:${args.packageId}:${Date.now()}`,
      createdAt: Date.now(),
    });
  },
});

/**
 * Returns the per-(asset, buyer) candidate set the forensic attribution resolver needs to re-derive
 * placement seeds for a leaked asset: {assetPath, licenseSubject, tokenHash} for every trace of the
 * package. Same gates as lookupTraceMatchesForAuthUser (api secret + couplingTraceability capability
 * + package ownership). The closed coupling service derives a seed per candidate and decodes.
 */
export const listCouplingTraceCandidatesForAuthUser = query({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    packageId: v.string(),
  },
  returns: v.object({
    capabilityEnabled: v.boolean(),
    packageOwned: v.boolean(),
    truncated: v.boolean(),
    candidateLimit: v.number(),
    candidates: v.array(
      v.object({
        assetPath: v.string(),
        licenseSubject: v.string(),
        tokenHash: v.string(),
      })
    ),
  }),
  handler: async (ctx, args) => {
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
        truncated: false,
        candidateLimit: COUPLING_TRACE_CANDIDATE_LIMIT,
        candidates: [],
      };
    }

    const registration = await ctx.runQuery(internal.packageRegistry.getRegistration, {
      packageId: args.packageId,
    });
    if (
      !registration ||
      registration.yucpUserId !== args.authUserId ||
      isArchivedPackage(registration)
    ) {
      return {
        capabilityEnabled: true,
        packageOwned: false,
        truncated: false,
        candidateLimit: COUPLING_TRACE_CANDIDATE_LIMIT,
        candidates: [],
      };
    }

    const seen = new Set<string>();
    const candidates: Array<{ assetPath: string; licenseSubject: string; tokenHash: string }> = [];
    let truncated = false;
    let cursor: string | null = null;
    let isDone = false;
    let rowsScanned = 0;
    while (!isDone && !truncated && rowsScanned < COUPLING_TRACE_ROW_SCAN_LIMIT) {
      const page = await ctx.db
        .query('coupling_trace_records')
        .withIndex('by_package_token', (q) => q.eq('packageId', args.packageId))
        .paginate({
          cursor,
          numItems: Math.min(
            COUPLING_TRACE_ROW_PAGE_SIZE,
            COUPLING_TRACE_ROW_SCAN_LIMIT - rowsScanned
          ),
        });
      rowsScanned += page.page.length;

      for (const row of page.page) {
        if (row.authUserId !== args.authUserId) {
          continue;
        }
        const key = JSON.stringify([row.assetPath, row.licenseSubject, row.tokenHash]);
        if (seen.has(key)) {
          continue;
        }
        if (candidates.length >= COUPLING_TRACE_CANDIDATE_LIMIT) {
          truncated = true;
          break;
        }
        seen.add(key);
        candidates.push({
          assetPath: row.assetPath,
          licenseSubject: row.licenseSubject,
          tokenHash: row.tokenHash,
        });
      }

      cursor = page.continueCursor;
      isDone = page.isDone;
      if (!isDone && rowsScanned >= COUPLING_TRACE_ROW_SCAN_LIMIT) {
        truncated = true;
      }
    }

    return {
      capabilityEnabled: true,
      packageOwned: true,
      truncated,
      candidateLimit: COUPLING_TRACE_CANDIDATE_LIMIT,
      candidates,
    };
  },
});
