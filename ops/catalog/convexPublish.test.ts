import { describe, expect, it, mock } from 'bun:test';
import { verifyApiActorBinding } from '@yucp/shared/apiActor';
import { getFunctionName } from 'convex/server';
import { api } from '../../convex/_generated/api';
import { createConvexCatalogPublish, loadConvexCatalogPublishConfig } from './convexPublish';
import type { CatalogOutboxEvent } from './reconciler';

const config = {
  convexApiSecret: 'test-convex-api-secret',
  convexUrl: 'https://catalog-publisher.convex.cloud',
  internalServiceAuthSecret: 'test-internal-service-auth-secret',
} as const;

describe('createConvexCatalogPublish', () => {
  it('loads an optional publish timeout with a 15-second default', () => {
    const env = {
      CONVEX_API_SECRET: config.convexApiSecret,
      CONVEX_URL: config.convexUrl,
      INTERNAL_SERVICE_AUTH_SECRET: config.internalServiceAuthSecret,
    };

    expect(loadConvexCatalogPublishConfig(env).publishTimeoutMs).toBe(15_000);
    expect(
      loadConvexCatalogPublishConfig({
        ...env,
        CATALOG_CONVEX_PUBLISH_TIMEOUT_MS: '25',
      }).publishTimeoutMs
    ).toBe(25);
  });

  it('maps a READY outbox event to one authenticated Convex upsert', async () => {
    const mutation = mock(async (_reference: unknown, _args: unknown) => 'version-ref-id');
    const createClient = mock((url: string) => {
      expect(url).toBe(config.convexUrl);
      return { mutation };
    });
    const publish = createConvexCatalogPublish(config, { createClient });
    const createdAt = new Date('2026-07-17T15:30:00.000Z');
    const event: CatalogOutboxEvent = {
      id: 'outbox-ready-1',
      aggregateId: 'version-123',
      eventType: 'catalog.version.ready',
      payload: {
        versionId: 'version-123',
        packageId: 'com.yucp.avatar-tools',
        catalogProductId: 'catalog-product-123',
        version: '1.2.3',
        byteLength: 1_048_576,
        contentType: 'application/zip',
        previousState: 'PROMOTING',
        state: 'READY',
        verification: 'full-reassembly',
      },
      createdAt,
    };

    await publish(event);

    expect(createClient).toHaveBeenCalledTimes(1);
    expect(mutation).toHaveBeenCalledTimes(1);
    const [reference, args] = mutation.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(getFunctionName(reference as never)).toBe(
      getFunctionName(api.packageVersions.upsertReadyVersion)
    );
    expect(args).toMatchObject({
      apiSecret: config.convexApiSecret,
      packageId: 'com.yucp.avatar-tools',
      catalogProductId: 'catalog-product-123',
      version: '1.2.3',
      versionId: 'version-123',
      totalSize: 1_048_576,
      contentType: 'application/zip',
      createdAt: createdAt.getTime(),
    });
    await expect(
      verifyApiActorBinding(
        args.actor as { payload: string; signature: string },
        config.internalServiceAuthSecret
      )
    ).resolves.toMatchObject({
      kind: 'service',
      service: 'catalog-ready-publisher',
      scopes: ['downloads:service'],
    });
  });

  it('does not call Convex for non-ready outbox events', async () => {
    const mutation = mock(async (_reference: unknown, _args: unknown) => undefined);
    const createClient = mock(() => ({ mutation }));
    const publish = createConvexCatalogPublish(config, {
      createClient,
    });

    await publish({
      id: 'outbox-assembled-1',
      aggregateId: 'version-123',
      eventType: 'catalog.version.assembled',
      payload: {},
      createdAt: new Date('2026-07-17T15:00:00.000Z'),
    });

    expect(createClient).not.toHaveBeenCalled();
    expect(mutation).not.toHaveBeenCalled();
  });

  it('rejects a hung Convex publish within the configured timeout', async () => {
    const mutation = mock(() => new Promise<never>(() => undefined));
    const publish = createConvexCatalogPublish(
      { ...config, publishTimeoutMs: 10 },
      { createClient: () => ({ mutation }) }
    );
    const event: CatalogOutboxEvent = {
      id: 'outbox-ready-hung',
      aggregateId: 'version-hung',
      eventType: 'catalog.version.ready',
      payload: {
        versionId: 'version-hung',
        packageId: 'com.yucp.hung',
        version: '1.0.0',
        byteLength: 1,
      },
      createdAt: new Date('2026-07-17T15:30:00.000Z'),
    };
    const testGuard = new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error('test guard expired')), 250);
    });

    await expect(Promise.race([publish(event), testGuard])).rejects.toThrow(
      'Convex catalog publish timed out after 10ms'
    );
    expect(mutation).toHaveBeenCalledTimes(1);
  });
});
