/**
 * Setup-session security tests.
 *
 * References:
 * - https://cheatsheetseries.owasp.org/cheatsheets/OAuth2_Cheat_Sheet.html
 * - https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html
 * - https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html
 */

import { beforeEach, describe, expect, it } from 'bun:test';
import {
  createSetupSession,
  deleteSetupSession,
  resolveSetupSession,
} from '../src/lib/setupSession';
import { getStateStore } from '../src/lib/stateStore';

const SECRET = 'test-encryption-secret-32-chars!!';

function sessionKey(signedToken: string): string {
  return `setup_session:${signedToken}`;
}

function tamperTokenSignature(signedToken: string): string {
  const [token, signature] = signedToken.split('.', 2);
  const replacement = signature.endsWith('a') ? 'b' : 'a';
  return `${token}.${signature.slice(0, -1)}${replacement}`;
}

describe('setup session security', () => {
  beforeEach(() => {
    delete process.env.DRAGONFLY_URI;
    delete process.env.REDIS_URL;
  });

  it('given a valid signed token, when resolved, then the original setup principal is returned', async () => {
    const signedToken = await createSetupSession(
      'auth-valid',
      'guild-valid',
      'discord-valid',
      SECRET
    );

    const result = await resolveSetupSession(signedToken, SECRET);

    expect(result).toMatchObject({
      authUserId: 'auth-valid',
      guildId: 'guild-valid',
      discordUserId: 'discord-valid',
    });
    expect(result?.expiresAt).toBeGreaterThan(Date.now());

    await deleteSetupSession(signedToken);
  });

  it('given a tampered signature, when resolved, then it is rejected and no session data is returned', async () => {
    const signedToken = await createSetupSession(
      'auth-tampered',
      'guild-tampered',
      'discord-tampered',
      SECRET
    );

    const result = await resolveSetupSession(tamperTokenSignature(signedToken), SECRET);

    expect(result).toBeNull();

    await deleteSetupSession(signedToken);
  });

  it('given the wrong secret, when resolved, then it is rejected without revealing session data', async () => {
    const signedToken = await createSetupSession(
      'auth-secret',
      'guild-secret',
      'discord-secret',
      SECRET
    );

    const result = await resolveSetupSession(signedToken, 'wrong-test-encryption-secret-32-ch');

    expect(result).toBeNull();

    await deleteSetupSession(signedToken);
  });

  it('given an expired stored session, when resolved, then it is rejected and deleted', async () => {
    const signedToken = await createSetupSession(
      'auth-expired',
      'guild-expired',
      'discord-expired',
      SECRET
    );
    const store = getStateStore();
    await store.set(
      sessionKey(signedToken),
      JSON.stringify({
        authUserId: 'auth-expired',
        guildId: 'guild-expired',
        discordUserId: 'discord-expired',
        createdAt: Date.now() - 5_000,
        expiresAt: Date.now() - 1,
      }),
      60_000
    );

    const result = await resolveSetupSession(signedToken, SECRET);

    expect(result).toBeNull();
    expect(await store.get(sessionKey(signedToken))).toBeNull();
  });
});
