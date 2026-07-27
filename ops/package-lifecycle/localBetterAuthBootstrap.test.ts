import { describe, expect, it } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  mintBetterAuthOneTimeEnrollmentCapability,
  signBetterAuthSessionToken,
} from './localBetterAuthBootstrap';

describe('local Better Auth bootstrap', () => {
  it('signs the real session token with the configured Better Auth secret', async () => {
    const signed = await signBetterAuthSessionToken('session-token', 'better-auth-secret');
    const [token, signature] = signed.split('.');
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode('better-auth-secret'),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );

    expect(token).toBe('session-token');
    expect(
      await crypto.subtle.verify(
        'HMAC',
        key,
        Uint8Array.from(atob(signature ?? ''), (character) => character.charCodeAt(0)),
        new TextEncoder().encode(token)
      )
    ).toBeTrue();
  });

  it('does not depend on Bun test lifecycle hooks', async () => {
    const source = await readFile(join(import.meta.dir, 'localBetterAuthBootstrap.ts'), 'utf8');

    expect(source).not.toContain("from 'bun:test'");
  });

  it('exchanges the host session for a bounded one-time enrollment capability', async () => {
    const requests: Array<{ input: string; init?: RequestInit }> = [];
    const capability = await mintBetterAuthOneTimeEnrollmentCapability({
      fetch: async (input, init) => {
        requests.push({ input: String(input), init });
        return Response.json({ token: 'one-time-capability' });
      },
      sessionToken: 'host-only-reusable-session',
      webUrl: 'http://localhost:3000',
    });

    expect(capability).toBe('one-time-capability');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.input).toBe('http://localhost:3000/api/auth/one-time-token/generate');
    expect(requests[0]?.input).not.toContain('host-only-reusable-session');
    expect(requests[0]?.init?.headers).toEqual({
      accept: 'application/json',
      cookie: 'yucp.session_token=host-only-reusable-session',
      origin: 'http://localhost:3000',
    });
  });
});
