import { afterEach, describe, expect, it } from 'bun:test';
import { InMemoryStateStore } from '../lib/stateStore';
import {
  clearPendingVrchatState,
  createPendingVrchatState,
  readPendingVrchatState,
} from './vrchatPending';

const originalPendingSecret = process.env.VRCHAT_PENDING_STATE_SECRET;

afterEach(() => {
  process.env.VRCHAT_PENDING_STATE_SECRET = originalPendingSecret;
});

describe('vrchatPending', () => {
  it('stores pending state server-side and resolves it from the opaque cookie', async () => {
    process.env.VRCHAT_PENDING_STATE_SECRET = 'pending-secret';
    const store = new InMemoryStateStore();
    const request = new Request('https://example.com/api/verification/vrchat-verify');

    const setCookie = await createPendingVrchatState(store, request, {
      verificationToken: 'verify-token',
      pendingState: '{"authToken":"cookie","requiresTwoFactorAuth":["emailOtp"]}',
      types: ['emailOtp'],
    });

    expect(setCookie).toContain('yucp_vrchat_pending=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).not.toContain('cookie');

    const cookieValue = setCookie.split(';', 1)[0];
    const followUpRequest = new Request('https://example.com/api/verification/vrchat-verify', {
      headers: {
        cookie: cookieValue,
      },
    });

    const pending = await readPendingVrchatState(store, followUpRequest, 'verify-token');
    expect(pending?.state.pendingState).toBe('{"authToken":"cookie","requiresTwoFactorAuth":["emailOtp"]}');
    expect(pending?.state.types).toEqual(['emailOtp']);
  });

  it('clears pending state from the store and response cookies', async () => {
    process.env.VRCHAT_PENDING_STATE_SECRET = 'pending-secret';
    const store = new InMemoryStateStore();
    const request = new Request('https://example.com/api/verification/vrchat-verify');
    const setCookie = await createPendingVrchatState(store, request, {
      verificationToken: 'verify-token',
      pendingState: '{"authToken":"cookie","requiresTwoFactorAuth":["emailOtp"]}',
      types: ['emailOtp'],
    });

    const cookieValue = setCookie.split(';', 1)[0];
    const followUpRequest = new Request('https://example.com/api/verification/vrchat-verify', {
      headers: {
        cookie: cookieValue,
      },
    });
    const headers = new Headers();

    await clearPendingVrchatState(store, followUpRequest, headers);

    expect(headers.get('Set-Cookie')).toContain('Max-Age=0');
    const pending = await readPendingVrchatState(store, followUpRequest, 'verify-token');
    expect(pending).toBeNull();
  });
});
