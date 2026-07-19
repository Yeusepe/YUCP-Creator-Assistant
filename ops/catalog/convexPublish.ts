import {
  type ApiActorBinding,
  createApiActorBinding,
  createServiceApiActor,
} from '@yucp/shared/apiActor';
import { ConvexHttpClient } from 'convex/browser';
import { api } from '../../convex/_generated/api';
import type { CatalogOutboxEvent } from './reconciler';

const READY_EVENT_TYPE = 'catalog.version.ready';
const DEFAULT_CONVEX_PUBLISH_TIMEOUT_MS = 15_000;

export interface ConvexCatalogPublishConfig {
  convexApiSecret: string;
  convexUrl: string;
  internalServiceAuthSecret: string;
  publishTimeoutMs?: number;
}

interface ConvexMutationClient {
  mutation(functionReference: unknown, args: Record<string, unknown>): Promise<unknown>;
}

interface ConvexCatalogPublishDependencies {
  createClient?: (url: string) => ConvexMutationClient;
}

function requiredConfigValue(
  env: NodeJS.ProcessEnv,
  key: 'CONVEX_API_SECRET' | 'CONVEX_URL' | 'INTERNAL_SERVICE_AUTH_SECRET'
): string {
  const value = env[key]?.trim();
  if (!value) {
    throw new Error(`Missing required catalog publisher environment variable: ${key}`);
  }
  return value;
}

function publishTimeoutMs(env: NodeJS.ProcessEnv): number {
  const configured = env.CATALOG_CONVEX_PUBLISH_TIMEOUT_MS?.trim();
  const timeoutMs = configured ? Number(configured) : DEFAULT_CONVEX_PUBLISH_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(
      'Invalid catalog publisher environment variable: CATALOG_CONVEX_PUBLISH_TIMEOUT_MS'
    );
  }
  return timeoutMs;
}

export function loadConvexCatalogPublishConfig(
  env: NodeJS.ProcessEnv = process.env
): ConvexCatalogPublishConfig {
  return {
    convexApiSecret: requiredConfigValue(env, 'CONVEX_API_SECRET'),
    convexUrl: requiredConfigValue(env, 'CONVEX_URL'),
    internalServiceAuthSecret: requiredConfigValue(env, 'INTERNAL_SERVICE_AUTH_SECRET'),
    publishTimeoutMs: publishTimeoutMs(env),
  };
}

function requiredPayloadString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`READY catalog event payload requires ${key}`);
  }
  return value.trim();
}

function requiredByteLength(payload: Record<string, unknown>): number {
  const value = payload.byteLength;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error('READY catalog event payload requires a non-negative safe byteLength');
  }
  return value as number;
}

function optionalContentType(payload: Record<string, unknown>): string | undefined {
  const value = payload.contentType;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function optionalCatalogProductId(payload: Record<string, unknown>): string | undefined {
  const value = payload.catalogProductId;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

async function createPublisherActor(secret: string): Promise<ApiActorBinding> {
  return await createApiActorBinding(
    createServiceApiActor({
      service: 'catalog-ready-publisher',
      scopes: ['downloads:service'],
    }),
    secret
  );
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Convex catalog publish timed out after ${timeoutMs}ms`)),
      timeoutMs
    );
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/**
 * Convex clients can invoke only public functions, so the target mutation authenticates this
 * service boundary: https://docs.convex.dev/functions/internal-functions
 */
export function createConvexCatalogPublish(
  config: ConvexCatalogPublishConfig,
  dependencies: ConvexCatalogPublishDependencies = {}
): (event: CatalogOutboxEvent) => Promise<void> {
  let client: ConvexMutationClient | undefined;

  return async (event) => {
    // ponytail: This handles only READY events; at-least-once delivery relies on the upsert's
    // versionId idempotency.
    if (event.eventType !== READY_EVENT_TYPE) {
      return;
    }

    client ??=
      dependencies.createClient?.(config.convexUrl) ??
      (new ConvexHttpClient(config.convexUrl) as ConvexMutationClient);
    const actor = await createPublisherActor(config.internalServiceAuthSecret);
    const catalogProductId = optionalCatalogProductId(event.payload);
    const contentType = optionalContentType(event.payload);
    await withTimeout(
      client.mutation(api.packageVersions.upsertReadyVersion, {
        apiSecret: config.convexApiSecret,
        actor,
        packageId: requiredPayloadString(event.payload, 'packageId'),
        version: requiredPayloadString(event.payload, 'version'),
        versionId: requiredPayloadString(event.payload, 'versionId'),
        totalSize: requiredByteLength(event.payload),
        ...(catalogProductId ? { catalogProductId } : {}),
        ...(contentType ? { contentType } : {}),
        createdAt: event.createdAt.getTime(),
      }),
      config.publishTimeoutMs ?? DEFAULT_CONVEX_PUBLISH_TIMEOUT_MS
    );
  };
}
