import {
  API_ACTOR_TTL_MS,
  createApiActorBinding,
  createServiceApiActor,
} from '@yucp/shared/apiActor';
import { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference } from 'convex/server';
import { api } from '../../convex/_generated/api';

type AdminConvexClient = ConvexHttpClient & {
  setAdminAuth(token: string, actingAsIdentity?: unknown): void;
};

const insertReference = makeFunctionReference<
  'mutation',
  { table: string; doc: Record<string, unknown> },
  string
>('testHelpersReal:insert');
const deleteReference = makeFunctionReference<'mutation', { id: string }, void>(
  'testHelpersReal:deleteById'
);

export interface LocalProductSeed {
  catalogProductId: string;
  cleanup: () => Promise<void>;
  licenseKey: string;
  packageId: string;
  productId: string;
}

async function hmacHex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export async function seedLocalManualProduct(input: {
  adminKey: string;
  apiSecret: string;
  backendUrl: string;
  buyerAuthUserId: string;
  creatorAuthUserId: string;
  encryptionSecret: string;
  internalServiceAuthSecret: string;
}): Promise<LocalProductSeed> {
  const client = new ConvexHttpClient(input.backendUrl, {
    skipConvexDeploymentUrlCheck: true,
  }) as AdminConvexClient;
  client.setAdminAuth(input.adminKey);
  const insertedIds: string[] = [];
  const insert = async (table: string, doc: Record<string, unknown>): Promise<string> => {
    const id = await client.mutation(insertReference, { table, doc });
    insertedIds.push(id);
    return id;
  };
  const now = Date.now();
  const suffix = crypto.randomUUID();
  const packageId = `com.yucp.lifecycle.${suffix}`;
  const productId = `lifecycle-product-${suffix}`;
  await insert('subjects', {
    authUserId: input.buyerAuthUserId,
    createdAt: now,
    primaryDiscordUserId: `lifecycle-buyer-${suffix}`,
    status: 'active',
    updatedAt: now,
  });
  await insert('creator_profiles', {
    authUserId: input.creatorAuthUserId,
    createdAt: now,
    name: 'Lifecycle Creator',
    ownerDiscordUserId: `lifecycle-creator-${suffix}`,
    status: 'active',
    updatedAt: now,
  });
  const catalogProductId = await insert('product_catalog', {
    authUserId: input.creatorAuthUserId,
    createdAt: now,
    displayName: 'Lifecycle Product',
    productId,
    provider: 'manual',
    providerProductRef: productId,
    status: 'active',
    supportsAutoDiscovery: false,
    updatedAt: now,
  });
  const licenseKey = crypto.randomUUID();
  const actor = await createApiActorBinding(
    createServiceApiActor({
      authUserId: input.creatorAuthUserId,
      now,
      scopes: ['creator:delegate', 'manual-licenses:service'],
      service: 'package-lifecycle',
      ttlMs: API_ACTOR_TTL_MS,
    }),
    input.internalServiceAuthSecret
  );
  const license = await client.mutation(api.manualLicenses.create, {
    actor,
    apiSecret: input.apiSecret,
    authUserId: input.creatorAuthUserId,
    catalogProductId: catalogProductId as never,
    licenseKeyHash: await hmacHex(input.encryptionSecret, licenseKey),
    maxUses: 1,
    productId,
  });
  insertedIds.push(String(license.licenseId));

  return {
    catalogProductId,
    licenseKey,
    packageId,
    productId,
    cleanup: async () => {
      const failures: unknown[] = [];
      for (const id of insertedIds.reverse()) {
        try {
          await client.mutation(deleteReference, { id });
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, 'Local product seed cleanup failed');
      }
    },
  };
}
