import type { ApiActorBinding } from '@yucp/shared/apiActor';
import {
  createApiActorBinding,
  createServiceApiActor,
  isApiActorProtectedFunction,
} from '@yucp/shared/apiActor';
import type { FunctionArgs, FunctionReference, FunctionReturnType } from 'convex/server';
import { getFunctionName } from 'convex/server';
import { convexTest, type TestConvex } from 'convex-test';
import type { Doc, Id } from './_generated/dataModel';
import schema from './schema';

export type ConvexTestInstance = TestConvex<typeof schema>;
type ConvexTestModuleMap = Record<string, () => Promise<unknown>>;
type ImportMetaWithGlob = ImportMeta & {
  glob: (pattern: string) => ConvexTestModuleMap;
};
type AnyFunctionReference = FunctionReference<
  'query' | 'mutation' | 'action',
  'public' | 'internal',
  Record<string, unknown>,
  unknown,
  string | undefined
>;
type OptionalActorArgs<Args> = Args extends { actor: ApiActorBinding }
  ? Omit<Args, 'actor'> & { actor?: ApiActorBinding }
  : Args;
type OptionalActorRestArgs<FuncRef extends AnyFunctionReference> =
  keyof FunctionArgs<FuncRef> extends never
    ? [args?: OptionalActorArgs<FunctionArgs<FuncRef>>]
    : [args: OptionalActorArgs<FunctionArgs<FuncRef>>];

export type ActorAwareConvexTestInstance = ConvexTestInstance & {
  query<FuncRef extends FunctionReference<'query'>>(
    functionReference: FuncRef,
    ...args: OptionalActorRestArgs<FuncRef>
  ): Promise<FunctionReturnType<FuncRef>>;
  mutation<FuncRef extends FunctionReference<'mutation'>>(
    functionReference: FuncRef,
    ...args: OptionalActorRestArgs<FuncRef>
  ): Promise<FunctionReturnType<FuncRef>>;
  action<FuncRef extends FunctionReference<'action'>>(
    functionReference: FuncRef,
    ...args: OptionalActorRestArgs<FuncRef>
  ): Promise<FunctionReturnType<FuncRef>>;
};

let cachedTestActor: {
  binding: ApiActorBinding;
  expiresAt: number;
} | null = null;

function describeFunctionReference(functionReference: unknown): string {
  try {
    return getFunctionName(functionReference as never);
  } catch {
    // Fall through to ad hoc inspection for simple string mocks.
  }
  if (typeof functionReference === 'string') {
    return functionReference;
  }
  if (!functionReference || typeof functionReference !== 'object') {
    return 'unknown';
  }

  const candidate = functionReference as {
    name?: unknown;
    _name?: unknown;
    functionName?: unknown;
    canonicalReference?: unknown;
  };

  if (typeof candidate.name === 'string') return candidate.name;
  if (typeof candidate._name === 'string') return candidate._name;
  if (typeof candidate.functionName === 'string') return candidate.functionName;
  if (typeof candidate.canonicalReference === 'string') return candidate.canonicalReference;
  return 'unknown';
}

async function getTestActorBinding(): Promise<ApiActorBinding> {
  const secret = process.env.INTERNAL_SERVICE_AUTH_SECRET ?? 'test-internal-service-secret';
  const now = Date.now();
  if (cachedTestActor && cachedTestActor.expiresAt > now + 30_000) {
    return cachedTestActor.binding;
  }

  const actor = createServiceApiActor({
    service: 'convex-test',
    scopes: [
      'creator:delegate',
      'downloads:service',
      'entitlements:service',
      'manual-licenses:service',
      'subjects:service',
      'verification-intents:service',
      'verification-sessions:service',
    ],
    now,
  });
  const binding = await createApiActorBinding(actor, secret);
  cachedTestActor = {
    binding,
    expiresAt: actor.expiresAt,
  };
  return binding;
}

function mergeActorArg(args: unknown, actor: ApiActorBinding): unknown {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return { actor };
  }

  return {
    ...(args as Record<string, unknown>),
    actor,
  };
}

function shouldAttachActor(functionReference: unknown, args: unknown): boolean {
  return (
    isApiActorProtectedFunction(describeFunctionReference(functionReference)) &&
    !!args &&
    typeof args === 'object' &&
    !Array.isArray(args) &&
    'apiSecret' in (args as Record<string, unknown>)
  );
}

export function makeTestConvex(
  options: { injectActor?: boolean } = {}
): ActorAwareConvexTestInstance {
  // import.meta.glob is a Vite-specific API required by convex-test.
  const rawTestInstance = convexTest(schema, (import.meta as ImportMetaWithGlob).glob('./**/*.ts'));
  const testInstance = rawTestInstance as ActorAwareConvexTestInstance;
  if (options.injectActor === false) {
    return testInstance;
  }

  const rawQuery = rawTestInstance.query.bind(rawTestInstance);
  const rawMutation = rawTestInstance.mutation.bind(rawTestInstance);
  const rawAction = rawTestInstance.action.bind(rawTestInstance);

  testInstance.query = (async (functionReference: unknown, args?: unknown) => {
    const actor = shouldAttachActor(functionReference, args)
      ? await getTestActorBinding()
      : undefined;
    return await rawQuery(
      functionReference as never,
      actor ? (mergeActorArg(args, actor) as never) : (args as never)
    );
  }) as ActorAwareConvexTestInstance['query'];

  testInstance.mutation = (async (functionReference: unknown, args?: unknown) => {
    const actor = shouldAttachActor(functionReference, args)
      ? await getTestActorBinding()
      : undefined;
    return await rawMutation(
      functionReference as never,
      actor ? (mergeActorArg(args, actor) as never) : (args as never)
    );
  }) as ActorAwareConvexTestInstance['mutation'];

  testInstance.action = (async (functionReference: unknown, args?: unknown) => {
    const actor = shouldAttachActor(functionReference, args)
      ? await getTestActorBinding()
      : undefined;
    return await rawAction(
      functionReference as never,
      actor ? (mergeActorArg(args, actor) as never) : (args as never)
    );
  }) as ActorAwareConvexTestInstance['action'];

  return testInstance;
}

// ---------------------------------------------------------------------------
// Seed helpers, insert minimal valid records and return their IDs.
// All required (non-optional) fields are included; optional fields may be
// passed via the `overrides` parameter.
// ---------------------------------------------------------------------------

export async function seedSubject(
  t: ConvexTestInstance,
  overrides: {
    primaryDiscordUserId?: string;
    status?: 'active' | 'suspended' | 'quarantined' | 'deleted';
    authUserId?: string;
    displayName?: string;
    avatarUrl?: string;
  } = {}
): Promise<Id<'subjects'>> {
  return await t.run(async (ctx) => {
    return await ctx.db.insert('subjects', {
      primaryDiscordUserId: overrides.primaryDiscordUserId ?? `discord-test-${Date.now()}`,
      status: overrides.status ?? 'active',
      authUserId: overrides.authUserId,
      displayName: overrides.displayName,
      avatarUrl: overrides.avatarUrl,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
}

export async function seedCreatorProfile(
  t: ConvexTestInstance,
  overrides: {
    authUserId?: string;
    name?: string;
    ownerDiscordUserId?: string;
    status?: 'active' | 'suspended' | 'quarantined' | 'deleted';
  } = {}
): Promise<Id<'creator_profiles'>> {
  return await t.run(async (ctx) => {
    return await ctx.db.insert('creator_profiles', {
      authUserId: overrides.authUserId ?? `auth-test-${Date.now()}`,
      name: overrides.name ?? 'Test Creator',
      ownerDiscordUserId: overrides.ownerDiscordUserId ?? `discord-creator-${Date.now()}`,
      status: overrides.status ?? 'active',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
}

export async function seedEntitlement(
  t: ConvexTestInstance,
  subjectId: Id<'subjects'>,
  overrides: {
    authUserId?: string;
    productId?: string;
    sourceProvider?: Doc<'entitlements'>['sourceProvider'];
    sourceReference?: string;
    status?: 'active' | 'revoked' | 'expired' | 'refunded' | 'disputed';
  } = {}
): Promise<Id<'entitlements'>> {
  return await t.run(async (ctx) => {
    return await ctx.db.insert('entitlements', {
      authUserId: overrides.authUserId ?? `auth-test-${Date.now()}`,
      subjectId,
      productId: overrides.productId ?? `product-test-${Date.now()}`,
      sourceProvider: overrides.sourceProvider ?? 'gumroad',
      sourceReference: overrides.sourceReference ?? `ref-${Date.now()}`,
      status: overrides.status ?? 'active',
      grantedAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
}

export async function seedGuildLink(
  t: ConvexTestInstance,
  overrides: {
    authUserId?: string;
    discordGuildId?: string;
    installedByAuthUserId?: string;
    botPresent?: boolean;
    status?: 'active' | 'uninstalled' | 'suspended';
  } = {}
): Promise<Id<'guild_links'>> {
  return await t.run(async (ctx) => {
    return await ctx.db.insert('guild_links', {
      authUserId: overrides.authUserId ?? `auth-test-${Date.now()}`,
      discordGuildId: overrides.discordGuildId ?? `guild-${Date.now()}`,
      installedByAuthUserId: overrides.installedByAuthUserId ?? `auth-installer-${Date.now()}`,
      botPresent: overrides.botPresent ?? true,
      status: overrides.status ?? 'active',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
}

export async function seedRoleRule(
  t: ConvexTestInstance,
  guildLinkId: Id<'guild_links'>,
  overrides: {
    authUserId?: string;
    guildId?: string;
    productId?: string;
    verifiedRoleId?: string;
    removeOnRevoke?: boolean;
    priority?: number;
    enabled?: boolean;
  } = {}
): Promise<Id<'role_rules'>> {
  return await t.run(async (ctx) => {
    return await ctx.db.insert('role_rules', {
      authUserId: overrides.authUserId ?? `auth-test-${Date.now()}`,
      guildId: overrides.guildId ?? `guild-${Date.now()}`,
      guildLinkId,
      productId: overrides.productId ?? `product-${Date.now()}`,
      verifiedRoleId: overrides.verifiedRoleId ?? `role-${Date.now()}`,
      removeOnRevoke: overrides.removeOnRevoke ?? true,
      priority: overrides.priority ?? 0,
      enabled: overrides.enabled ?? true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
}

export async function seedCertificateBillingCatalog(
  t: ConvexTestInstance,
  input: {
    productId?: string;
    slug?: string;
    displayName?: string;
    description?: string;
    sortOrder?: number;
    recurringInterval?: string;
    recurringPriceIds?: string[];
    displayBadge?: string;
    highlights?: string[];
    meteredPrices?: Array<{
      priceId: string;
      meterId: string;
      meterName: string;
    }>;
    benefitId?: string;
    benefitType?: string;
    benefitDescription?: string;
    benefitMetadata?: Record<string, string | number | boolean>;
    featureFlags?: Record<string, string | number | boolean>;
    capabilityKeys?: string[];
    capabilityKey?: string;
    deviceCap?: number;
    signQuotaPerPeriod?: number;
    auditRetentionDays?: number;
    supportTier?: string;
    tierRank?: number;
    metadata?: Record<string, string | number | boolean>;
  } = {}
): Promise<{ productId: string; benefitId: string }> {
  const now = Date.now();
  const productId = input.productId ?? 'prod_test_certificate';
  const benefitId = input.benefitId ?? 'benefit_test_certificate';

  await t.run(async (ctx) => {
    await ctx.db.insert('creator_billing_catalog_products', {
      productId,
      slug: input.slug ?? 'test-certificate',
      displayName: input.displayName ?? 'Test Certificate',
      description: input.description ?? 'Test certificate billing product',
      status: 'active',
      sortOrder: input.sortOrder ?? 1,
      displayBadge: input.displayBadge,
      recurringInterval: input.recurringInterval ?? 'month',
      recurringPriceIds: input.recurringPriceIds ?? ['price_test_certificate_monthly'],
      meteredPrices: input.meteredPrices ?? [],
      benefitIds: [benefitId],
      highlights: input.highlights ?? ['Test certificate plan'],
      metadata: {
        yucp_domain: 'certificate_billing',
        ...(input.metadata ?? {}),
      },
      syncedAt: now,
      createdAt: now,
      updatedAt: now,
    });

    await ctx.db.insert('creator_billing_catalog_benefits', {
      benefitId,
      type: input.benefitType ?? 'feature_flag',
      description: input.benefitDescription ?? 'Test certificate features',
      metadata: input.benefitMetadata ?? {},
      featureFlags: input.featureFlags ?? {},
      capabilityKeys: input.capabilityKeys ?? [],
      capabilityKey: input.capabilityKey,
      deviceCap: input.deviceCap,
      signQuotaPerPeriod: input.signQuotaPerPeriod,
      auditRetentionDays: input.auditRetentionDays,
      supportTier: input.supportTier,
      tierRank: input.tierRank,
      syncedAt: now,
      createdAt: now,
      updatedAt: now,
    });
  });

  return { productId, benefitId };
}
