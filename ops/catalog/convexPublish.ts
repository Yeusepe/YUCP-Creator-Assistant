import {
  type ApiActorBinding,
  createApiActorBinding,
  createServiceApiActor,
} from '@yucp/shared/apiActor';
import { ConvexHttpClient } from 'convex/browser';
import { api } from '../../convex/_generated/api';
import { normalizeVpmBootstrapMedia } from '../storage-core/vpmBootstrapMedia';
import { normalizeVpmBootstrapMetadata } from '../storage-core/vpmBootstrapMetadata';
import type { CatalogOutboxEvent } from './reconciler';

const READY_EVENT_TYPE = 'catalog.version.ready';
const DELETED_EVENT_TYPE = 'catalog.version.deleted';
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

interface ConvexQueryClient {
  query(functionReference: unknown, args: Record<string, unknown>): Promise<unknown>;
}

interface ConvexCatalogPublishDependencies {
  createClient?: (url: string) => ConvexMutationClient;
}

interface ConvexPackageCreatorResolverDependencies {
  createClient?: (url: string) => ConvexQueryClient;
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

function requiredNonNegativeInteger(payload: Record<string, unknown>, key: string): number {
  const value = payload[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`READY catalog event payload requires a non-negative safe ${key}`);
  }
  return value as number;
}

function requiredSha256(payload: Record<string, unknown>, key: string): string {
  const value = requiredPayloadString(payload, key);
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`READY catalog event payload requires lowercase SHA-256 ${key}`);
  }
  return value;
}

function optionalCatalogProductId(payload: Record<string, unknown>): string | undefined {
  const value = payload.catalogProductId;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function requiredProtectedFiles(payload: Record<string, unknown>) {
  const value = payload.protectedFiles;
  if (!Array.isArray(value) || value.length > 512) {
    throw new Error('READY catalog event payload requires protectedFiles');
  }
  return value.map((candidate, index) => {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
      throw new Error(`READY catalog event protectedFiles[${index}] is invalid`);
    }
    const file = candidate as Record<string, unknown>;
    const materializerType = requiredPayloadString(file, 'materializerType');
    const normalizedPath = requiredPayloadString(file, 'normalizedPath');
    const sourceSha256 = requiredSha256(file, 'sourceSha256');
    if (typeof file.required !== 'boolean') {
      throw new Error(`READY catalog event protectedFiles[${index}] requires a boolean required`);
    }
    return { materializerType, normalizedPath, required: file.required, sourceSha256 };
  });
}

function requiredVpmBootstrapMetadata(payload: Record<string, unknown>) {
  if (!('vpmDependencies' in payload) || !('vpmRepositories' in payload)) {
    throw new Error('READY catalog event payload requires VPM bootstrap metadata');
  }
  return normalizeVpmBootstrapMetadata({
    packageMetadata: payload.packageMetadata,
    vpmDependencies: payload.vpmDependencies,
    vpmRepositories: payload.vpmRepositories,
  });
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

async function createLegacyMigratorActor(secret: string): Promise<ApiActorBinding> {
  return await createApiActorBinding(
    createServiceApiActor({
      service: 'catalog-legacy-migrator',
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
    if (event.eventType !== READY_EVENT_TYPE && event.eventType !== DELETED_EVENT_TYPE) {
      return;
    }

    client ??=
      dependencies.createClient?.(config.convexUrl) ??
      (new ConvexHttpClient(config.convexUrl) as ConvexMutationClient);
    const actor = await createPublisherActor(config.internalServiceAuthSecret);
    if (event.eventType === DELETED_EVENT_TYPE) {
      await withTimeout(
        client.mutation(api.packageVersions.markVersionDeleted, {
          apiSecret: config.convexApiSecret,
          actor,
          versionId: requiredPayloadString(event.payload, 'versionId'),
          deletedAt: event.createdAt.getTime(),
        }),
        config.publishTimeoutMs ?? DEFAULT_CONVEX_PUBLISH_TIMEOUT_MS
      );
      return;
    }

    const catalogProductId = optionalCatalogProductId(event.payload);
    const bootstrapMetadata = requiredVpmBootstrapMetadata(event.payload);
    const bootstrapMedia = normalizeVpmBootstrapMedia(event.payload.bootstrapMedia);
    await withTimeout(
      client.mutation(api.packageVersions.upsertReadyVersion, {
        apiSecret: config.convexApiSecret,
        actor,
        activeContentDigest: requiredSha256(event.payload, 'activeContentDigest'),
        activePolicyVersion: requiredPayloadString(event.payload, 'activePolicyVersion'),
        bindingRoot: requiredSha256(event.payload, 'bindingRoot'),
        bootstrapMedia,
        commonRoot: requiredSha256(event.payload, 'commonRoot'),
        editionId: requiredPayloadString(event.payload, 'editionId'),
        logicalBytes: requiredNonNegativeInteger(event.payload, 'logicalBytes'),
        logicalFiles: requiredNonNegativeInteger(event.payload, 'logicalFiles'),
        packageId: requiredPayloadString(event.payload, 'packageId'),
        manifestSha256: requiredSha256(event.payload, 'manifestSha256'),
        protectedFiles: requiredProtectedFiles(event.payload),
        protectedSourceRoot: requiredSha256(event.payload, 'protectedSourceRoot'),
        protectionPolicyDigest: requiredSha256(event.payload, 'protectionPolicyDigest'),
        protectionPolicyId: requiredPayloadString(event.payload, 'protectionPolicyId'),
        releaseRoot: requiredSha256(event.payload, 'releaseRoot'),
        version: requiredPayloadString(event.payload, 'version'),
        versionId: requiredPayloadString(event.payload, 'versionId'),
        ...(bootstrapMetadata.packageMetadata
          ? { packageMetadata: bootstrapMetadata.packageMetadata }
          : {}),
        vpmDependencies: bootstrapMetadata.vpmDependencies,
        vpmRepositories: bootstrapMetadata.vpmRepositories,
        ...(catalogProductId ? { catalogProductId } : {}),
        createdAt: event.createdAt.getTime(),
      }),
      config.publishTimeoutMs ?? DEFAULT_CONVEX_PUBLISH_TIMEOUT_MS
    );
  };
}

export function createConvexPackageCreatorResolver(
  config: ConvexCatalogPublishConfig,
  dependencies: ConvexPackageCreatorResolverDependencies = {}
): (version: { packageId: string }) => Promise<string> {
  let client: ConvexQueryClient | undefined;

  return async (version) => {
    client ??=
      dependencies.createClient?.(config.convexUrl) ??
      (new ConvexHttpClient(config.convexUrl) as ConvexQueryClient);
    const actor = await createLegacyMigratorActor(config.internalServiceAuthSecret);
    const context = await withTimeout(
      client.query(api.packageRegistry.getBuyerAccessContextByPackageId, {
        actor,
        apiSecret: config.convexApiSecret,
        packageId: version.packageId,
      }),
      config.publishTimeoutMs ?? DEFAULT_CONVEX_PUBLISH_TIMEOUT_MS
    );
    const creatorAuthUserId =
      context && typeof context === 'object'
        ? Reflect.get(context, 'creatorAuthUserId')
        : undefined;
    if (typeof creatorAuthUserId !== 'string' || !creatorAuthUserId.trim()) {
      throw new Error(`Package ${version.packageId} has no active creator mapping`);
    }
    return creatorAuthUserId.trim();
  };
}
