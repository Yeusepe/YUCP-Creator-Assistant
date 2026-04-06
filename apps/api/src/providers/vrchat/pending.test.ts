import { afterEach, describe, expect, it } from 'bun:test';
import { InMemoryStateStore } from '../../lib/stateStore';
import {
  clearConnectPendingState,
  createConnectPendingState,
  readConnectPendingState,
} from './pending';

const originalPendingSecret = process.env.VRCHAT_PENDING_STATE_SECRET;

afterEach(() => {
  process.env.VRCHAT_PENDING_STATE_SECRET = originalPendingSecret;
});

describe('vrchat connect pending state', () => {
  it('stores pending connect state server-side and resolves it from the opaque cookie', async () => {
    process.env.VRCHAT_PENDING_STATE_SECRET = 'pending-secret';
    const store = new InMemoryStateStore();
    const request = new Request('https://example.com/api/connect/vrchat');

    const setCookie = await createConnectPendingState(store, request, {
      authUserId: 'user-123',
      pendingState: '{"authToken":"cookie","requiresTwoFactorAuth":["emailOtp"]}',
      types: ['emailOtp'],
    });

    expect(setCookie).toContain('yucp_vrchat_connect_pending=');
    expect(setCookie).toContain('Path=/api/connect/vrchat');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).not.toContain('cookie');

    const cookieValue = setCookie.split(';', 1)[0];
    const followUpRequest = new Request('https://example.com/api/connect/vrchat', {
      headers: {
        cookie: cookieValue,
      },
    });

    const pending = await readConnectPendingState(store, followUpRequest);
    expect(pending?.state.authUserId).toBe('user-123');
    expect(pending?.state.pendingState).toBe(
      '{"authToken":"cookie","requiresTwoFactorAuth":["emailOtp"]}'
    );
    expect(pending?.state.types).toEqual(['emailOtp']);
  });

  it('clears connect pending state from the store and response cookies', async () => {
    process.env.VRCHAT_PENDING_STATE_SECRET = 'pending-secret';
    const store = new InMemoryStateStore();
    const request = new Request('https://example.com/api/connect/vrchat');
    const setCookie = await createConnectPendingState(store, request, {
      authUserId: 'user-123',
      pendingState: '{"authToken":"cookie","requiresTwoFactorAuth":["emailOtp"]}',
      types: ['emailOtp'],
    });

    const cookieValue = setCookie.split(';', 1)[0];
    const followUpRequest = new Request('https://example.com/api/connect/vrchat', {
      headers: {
        cookie: cookieValue,
      },
    });
    const headers = new Headers();

    await clearConnectPendingState(store, followUpRequest, headers);

    expect(headers.get('Set-Cookie')).toContain('Path=/api/connect/vrchat');
    expect(headers.get('Set-Cookie')).toContain('Max-Age=0');
    const pending = await readConnectPendingState(store, followUpRequest);
    expect(pending).toBeNull();
  });
});
