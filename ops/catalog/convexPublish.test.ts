import { describe, expect, it, mock } from 'bun:test';
import { verifyApiActorBinding } from '@yucp/shared/apiActor';
import { getFunctionName } from 'convex/server';
import { api } from '../../convex/_generated/api';
import { createConvexCatalogPublish } from './convexPublish';
import type { CatalogOutboxEvent } from './reconciler';

const config = {
  convexApiSecret: 'test-convex-api-secret',
  convexUrl: 'https://catalog-publisher.convex.cloud',
  internalServiceAuthSecret: 'test-internal-service-auth-secret',
} as const;

describe('createConvexCatalogPublish', () => {
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
});
