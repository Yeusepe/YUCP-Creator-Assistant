import { describe, expect, it } from 'bun:test';
import {
  createUserDataExportResponse,
  disconnectProviderConnectionsOrThrow,
} from './connectUserAccountSupport';

describe('connectUserAccountSupport', () => {
  it('creates a no-store JSON attachment response for data exports', async () => {
    const response = createUserDataExportResponse({ ok: true });

    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Content-Type')).toContain('application/json');
    expect(response.headers.get('Content-Disposition')).toBe(
      'attachment; filename="yucp-data-export.json"'
    );
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it('throws after disconnect failures so account deletion cannot continue', async () => {
    const disconnects: string[] = [];
    const failures: string[] = [];

    await expect(
      disconnectProviderConnectionsOrThrow({
        apiSecret: 'secret',
        authUserId: 'user-1',
        connections: [{ id: 'conn-1' }, { id: 'conn-2' }],
        runProviderDisconnectHook: async (_convex, connectionId) => {
          if (connectionId === 'conn-1') {
            throw new Error('provider refused');
          }
        },
        disconnectConnection: async (connectionId) => {
          disconnects.push(connectionId);
        },
        convex: {} as never,
        onDisconnectFailure: ({ connectionId }) => {
          failures.push(connectionId);
        },
      })
    ).rejects.toThrow('Failed to disconnect 1 provider connection');

    expect(failures).toEqual(['conn-1']);
    expect(disconnects).toEqual(['conn-2']);
  });
});
