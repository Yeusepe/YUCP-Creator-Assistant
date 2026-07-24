import { v } from 'convex/values';
import type { GenericId } from 'convex/values';
// Convex components require the component-safe paginator.
// https://docs.convex.dev/components/authoring#pagination
import { paginator } from 'convex-helpers/server/pagination';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { mutation, query } from './_generated/server';
import { deriveBetterAuthV17AccountIdentity } from './accountIdentityMigration';
import schema from './schema';

const migrationTable = v.union(v.literal('account'), v.literal('apikey'));
const migrationPhase = v.union(v.literal('backfill'), v.literal('cleanup'));
const migrationBlockerCode = v.union(
  v.literal('api_key_owner_conflict'),
  v.literal('credential_subject_mismatch'),
  v.literal('duplicate_legacy_identity'),
  v.literal('duplicate_target_identity'),
  v.literal('empty_api_key_config'),
  v.literal('empty_api_key_owner'),
  v.literal('empty_legacy_account_id'),
  v.literal('empty_provider_id'),
  v.literal('partial_target_identity'),
  v.literal('target_identity_collision'),
  v.literal('target_identity_mismatch')
);
const migrationBlocker = v.object({
  recordId: v.string(),
  code: migrationBlockerCode,
});
const migrationPageResult = {
  table: migrationTable,
  scanned: v.number(),
  current: v.number(),
  pendingBackfill: v.number(),
  pendingCleanup: v.number(),
  blockers: v.array(migrationBlocker),
  continueCursor: v.string(),
  isDone: v.boolean(),
};
const MAX_PAGE_SIZE = 200;
const DEFAULT_API_KEY_CONFIG_ID = 'default';

type MigrationTable = 'account' | 'apikey';
type MigrationPhase = 'backfill' | 'cleanup';
type MigrationBlockerCode =
  | 'api_key_owner_conflict'
  | 'credential_subject_mismatch'
  | 'duplicate_legacy_identity'
  | 'duplicate_target_identity'
  | 'empty_api_key_config'
  | 'empty_api_key_owner'
  | 'empty_legacy_account_id'
  | 'empty_provider_id'
  | 'partial_target_identity'
  | 'target_identity_collision'
  | 'target_identity_mismatch';

type MigrationBlocker = {
  recordId: string;
  code: MigrationBlockerCode;
};

type MigrationState = 'current' | 'pendingBackfill' | 'pendingCleanup';
type MigrationCtx = QueryCtx | MutationCtx;

type AccountMigrationDoc = {
  _id: GenericId<'account'>;
  accountId?: string;
  issuer?: string;
  providerAccountId?: string;
  providerId: string;
  userId: string;
  password?: string | null;
};

type ApiKeyMigrationDoc = {
  _id: GenericId<'apikey'>;
  configId?: string | null;
  referenceId?: string | null;
  userId?: string;
};

type MigrationAnalysis = {
  state: MigrationState;
  blockers: MigrationBlocker[];
  update?: Record<string, string>;
};

function normalizePageSize(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_PAGE_SIZE) {
    throw new Error(`Migration page size must be between 1 and ${MAX_PAGE_SIZE}`);
  }
  return value;
}

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

async function analyzeAccount(
  ctx: MigrationCtx,
  doc: AccountMigrationDoc
): Promise<MigrationAnalysis> {
  const blockers: MigrationBlocker[] = [];
  const hasIssuer = hasText(doc.issuer);
  const hasProviderAccountId = hasText(doc.providerAccountId);
  const hasLegacyAccountId = hasText(doc.accountId);

  if (!hasText(doc.providerId)) {
    blockers.push({ recordId: doc._id, code: 'empty_provider_id' });
  }
  if (!hasIssuer && !hasProviderAccountId && !hasLegacyAccountId) {
    blockers.push({ recordId: doc._id, code: 'empty_legacy_account_id' });
  }
  if (hasIssuer !== hasProviderAccountId) {
    blockers.push({ recordId: doc._id, code: 'partial_target_identity' });
  }

  const target = hasLegacyAccountId ? deriveBetterAuthV17AccountIdentity(doc) : null;
  if (target && (doc.providerId === 'credential' || hasText(doc.password))) {
    if (target.providerAccountId !== doc.userId) {
      blockers.push({ recordId: doc._id, code: 'credential_subject_mismatch' });
    }
  }
  if (
    target &&
    hasIssuer &&
    hasProviderAccountId &&
    (doc.issuer !== target.issuer || doc.providerAccountId !== target.providerAccountId)
  ) {
    blockers.push({ recordId: doc._id, code: 'target_identity_mismatch' });
  }

  const resolvedIssuer = hasIssuer ? doc.issuer : target?.issuer;
  const resolvedProviderAccountId = hasProviderAccountId
    ? doc.providerAccountId
    : target?.providerAccountId;

  if (resolvedIssuer && resolvedProviderAccountId) {
    const targetRows = await ctx.db
      .query('account')
      .withIndex('issuer_providerAccountId', (q) =>
        q.eq('issuer', resolvedIssuer).eq('providerAccountId', resolvedProviderAccountId)
      )
      .take(2);
    if (targetRows.some((candidate) => candidate._id !== doc._id)) {
      blockers.push({ recordId: doc._id, code: 'target_identity_collision' });
    }
    if (targetRows.length > 1) {
      blockers.push({ recordId: doc._id, code: 'duplicate_target_identity' });
    }
  }

  if (target) {
    const legacyRows = await ctx.db
      .query('account')
      .withIndex('accountId_providerId', (q) =>
        q.eq('accountId', target.providerAccountId).eq('providerId', doc.providerId)
      )
      .take(2);
    if (legacyRows.length > 1) {
      blockers.push({ recordId: doc._id, code: 'duplicate_legacy_identity' });
    }
  }

  if (blockers.length > 0) {
    return { state: hasIssuer && hasProviderAccountId ? 'pendingCleanup' : 'pendingBackfill', blockers };
  }
  if (!hasIssuer || !hasProviderAccountId) {
    if (!target) {
      return {
        state: 'pendingBackfill',
        blockers: [{ recordId: doc._id, code: 'empty_legacy_account_id' }],
      };
    }
    return {
      state: 'pendingBackfill',
      blockers: [],
      update: target,
    };
  }
  return {
    state: hasLegacyAccountId ? 'pendingCleanup' : 'current',
    blockers: [],
  };
}

function analyzeApiKey(doc: ApiKeyMigrationDoc): MigrationAnalysis {
  const blockers: MigrationBlocker[] = [];
  const hasLegacyOwner = hasText(doc.userId);
  const hasReferenceOwner = hasText(doc.referenceId);
  const hasConfig = hasText(doc.configId);

  if (doc.referenceId === '' || (!hasLegacyOwner && !hasReferenceOwner)) {
    blockers.push({ recordId: doc._id, code: 'empty_api_key_owner' });
  }
  if (doc.configId === '') {
    blockers.push({ recordId: doc._id, code: 'empty_api_key_config' });
  }
  if (hasLegacyOwner && hasReferenceOwner && doc.userId !== doc.referenceId) {
    blockers.push({ recordId: doc._id, code: 'api_key_owner_conflict' });
  }

  if (blockers.length > 0) {
    return {
      state: hasReferenceOwner && hasConfig ? 'pendingCleanup' : 'pendingBackfill',
      blockers,
    };
  }
  if (!hasReferenceOwner || !hasConfig) {
    const configId = hasText(doc.configId) ? doc.configId : DEFAULT_API_KEY_CONFIG_ID;
    const referenceId = hasText(doc.referenceId) ? doc.referenceId : (doc.userId as string);
    return {
      state: 'pendingBackfill',
      blockers: [],
      update: {
        configId,
        referenceId,
      },
    };
  }
  return {
    state: hasLegacyOwner ? 'pendingCleanup' : 'current',
    blockers: [],
  };
}

async function analyzeDocument(
  ctx: MigrationCtx,
  table: MigrationTable,
  doc: AccountMigrationDoc | ApiKeyMigrationDoc
): Promise<MigrationAnalysis> {
  if (table === 'account') {
    return await analyzeAccount(ctx, doc as AccountMigrationDoc);
  }
  return analyzeApiKey(doc as ApiKeyMigrationDoc);
}

async function readPage(
  ctx: MigrationCtx,
  table: MigrationTable,
  cursor: string | null,
  limit: number
) {
  return await paginator(ctx.db, schema).query(table).paginate({
    cursor,
    numItems: normalizePageSize(limit),
  });
}

function summarize(
  table: MigrationTable,
  page: Awaited<ReturnType<typeof readPage>>,
  analyses: MigrationAnalysis[]
) {
  return {
    table,
    scanned: page.page.length,
    current: analyses.filter((analysis) => analysis.state === 'current').length,
    pendingBackfill: analyses.filter((analysis) => analysis.state === 'pendingBackfill').length,
    pendingCleanup: analyses.filter((analysis) => analysis.state === 'pendingCleanup').length,
    blockers: analyses.flatMap((analysis) => analysis.blockers),
    continueCursor: page.continueCursor,
    isDone: page.isDone,
  };
}

export const auditPage = query({
  args: {
    table: migrationTable,
    cursor: v.union(v.null(), v.string()),
    limit: v.number(),
  },
  returns: v.object(migrationPageResult),
  handler: async (ctx, args) => {
    const page = await readPage(ctx, args.table, args.cursor, args.limit);
    const analyses = [];
    for (const doc of page.page) {
      analyses.push(await analyzeDocument(ctx, args.table, doc));
    }
    return summarize(args.table, page, analyses);
  },
});

export const migratePage = mutation({
  args: {
    table: migrationTable,
    phase: migrationPhase,
    cursor: v.union(v.null(), v.string()),
    limit: v.number(),
  },
  returns: v.object({
    ...migrationPageResult,
    phase: migrationPhase,
    migrated: v.number(),
  }),
  handler: async (ctx, args) => {
    const phase: MigrationPhase = args.phase;
    const page = await readPage(ctx, args.table, args.cursor, args.limit);
    const analyses = [];
    for (const doc of page.page) {
      analyses.push(await analyzeDocument(ctx, args.table, doc));
    }
    const summary = summarize(args.table, page, analyses);
    if (summary.blockers.length > 0) {
      const codes = Array.from(new Set(summary.blockers.map((blocker) => blocker.code)));
      throw new Error(`Better Auth 1.7 migration page has blockers: ${codes.join(', ')}`);
    }
    if (
      phase === 'cleanup' &&
      analyses.some((analysis) => analysis.state === 'pendingBackfill')
    ) {
      throw new Error('Better Auth 1.7 cleanup requires a completed backfill');
    }

    let migrated = 0;
    for (const [index, doc] of page.page.entries()) {
      const analysis = analyses[index];
      if (!analysis) {
        throw new Error('Better Auth 1.7 migration analysis is missing');
      }
      if (phase === 'backfill' && analysis.state === 'pendingBackfill' && analysis.update) {
        await ctx.db.patch(doc._id, analysis.update);
        migrated += 1;
      }
      if (phase === 'cleanup' && analysis.state === 'pendingCleanup') {
        if (args.table === 'account') {
          await ctx.db.patch(doc._id, { accountId: undefined });
        } else {
          await ctx.db.patch(doc._id, { userId: undefined });
        }
        migrated += 1;
      }
    }

    return {
      ...summary,
      phase,
      migrated,
    };
  },
});
