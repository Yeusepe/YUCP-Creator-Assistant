import { ConvexError, v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc } from './_generated/dataModel';
import { mutation, query } from './_generated/server';
import { requireApiSecret } from './lib/apiAuth';
import { BILLING_CAPABILITY_KEYS } from './lib/billingCapabilities';

const PACKAGE_ID_RE = /^[a-z0-9\-_./:]{1,128}$/;
const TOKEN_HASH_RE = /^[0-9a-f]{64}$/;

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
    tokenHashes: v.array(v.string()),
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
      })
    ),
    unmatchedTokenHashes: v.array(v.string()),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    assertPackageId(args.packageId);
    const tokenHashes = normalizeTokenHashes(args.tokenHashes);

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
      };
    }

    const registration = await ctx.runQuery(internal.packageRegistry.getRegistration, {
      packageId: args.packageId,
    });
    if (!registration || registration.yucpUserId !== args.authUserId || isArchivedPackage(registration)) {
      return {
        capabilityEnabled: true,
        packageOwned: false,
        matches: [],
        unmatchedTokenHashes: tokenHashes,
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
    }> = [];
    const matchedTokenHashes = new Set<string>();

    for (const tokenHash of tokenHashes) {
      const rows = await ctx.db
        .query('coupling_trace_records')
        .withIndex('by_package_token', (q) =>
          q.eq('packageId', args.packageId).eq('tokenHash', tokenHash)
        )
        .collect();

      const scopedRows = rows
        .filter((row) => row.authUserId === args.authUserId)
        .sort((left, right) => right.createdAt - left.createdAt);

      for (const row of scopedRows) {
        matchedTokenHashes.add(tokenHash);
        matches.push({
          tokenHash,
          licenseSubject: row.licenseSubject,
          assetPath: row.assetPath,
          correlationId: row.correlationId,
          createdAt: row.createdAt,
          runtimeArtifactVersion: row.runtimeArtifactVersion,
          runtimePlaintextSha256: row.runtimePlaintextSha256,
        });
      }
    }

    return {
      capabilityEnabled: true,
      packageOwned: true,
      matches,
      unmatchedTokenHashes: tokenHashes.filter((tokenHash) => !matchedTokenHashes.has(tokenHash)),
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
