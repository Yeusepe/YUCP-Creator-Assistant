/**
 * Security invariants for crypto helpers and setup-session tokens.
 *
 * Sources from plan.md:
 * - https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html
 * - https://cheatsheetseries.owasp.org/cheatsheets/OAuth2_Cheat_Sheet.html
 * - https://cheatsheetseries.owasp.org/cheatsheets/Input_Validation_Cheat_Sheet.html
 */

import { afterEach, describe, expect, it } from 'bun:test';

const { decrypt, encrypt } = await import('./encrypt');
const { createSetupSession, deleteSetupSession, resolveSetupSession } = await import(
  './setupSession'
);

const originalNow = Date.now;
const createdTokens = new Set<string>();

function tamperOpaqueValue(value: string): string {
  const last = value.at(-1);
  if (!last) {
    throw new Error('Cannot tamper with an empty value');
  }
  const replacement = last === 'A' ? 'B' : 'A';
  return `${value.slice(0, -1)}${replacement}`;
}

afterEach(async () => {
  Date.now = originalNow;
  for (const token of createdTokens) {
    await deleteSetupSession(token);
  }
  createdTokens.clear();
});

describe('crypto/token security invariants', () => {
  it('given tampered ciphertext, when decrypted, then decryption fails closed', async () => {
    const secret = 'enc-secret';
    const purpose = 'gumroad-oauth-access-token';
    const ciphertext = await encrypt('top-secret-token', secret, purpose);

    await expect(decrypt(tamperOpaqueValue(ciphertext), secret, purpose)).rejects.toThrow();
  });

  it('given wrong secret or purpose, when decrypting, then it fails closed', async () => {
    const ciphertext = await encrypt('refresh-token', 'enc-secret', 'gumroad-oauth-refresh-token');

    await expect(
      decrypt(ciphertext, 'different-secret', 'gumroad-oauth-refresh-token')
    ).rejects.toThrow();
    await expect(decrypt(ciphertext, 'enc-secret', 'discord-oauth-access-token')).rejects.toThrow();
  });

  it('given tampered setup-session token, when resolved, then it is rejected without invalidating the original token', async () => {
    const secret = 'setup-secret';
    const token = await createSetupSession('auth-user-1', 'guild-1', 'discord-1', secret);
    createdTokens.add(token);

    expect(await resolveSetupSession(tamperOpaqueValue(token), secret)).toBeNull();

    const resolved = await resolveSetupSession(token, secret);
    expect(resolved).toMatchObject({
      authUserId: 'auth-user-1',
      guildId: 'guild-1',
      discordUserId: 'discord-1',
    });
  });

  it('given exact expiry cutoff and just-past cutoff, when resolving, then exact cutoff succeeds and just past fails', async () => {
    const secret = 'setup-secret';
    const issuedAt = 1_700_000_000_000;

    Date.now = () => issuedAt;
    const validAtCutoffToken = await createSetupSession(
      'auth-user-2',
      'guild-2',
      'discord-2',
      secret
    );
    createdTokens.add(validAtCutoffToken);

    Date.now = () => issuedAt + 60 * 60 * 1000;
    const resolvedAtCutoff = await resolveSetupSession(validAtCutoffToken, secret);
    expect(resolvedAtCutoff).toMatchObject({
      authUserId: 'auth-user-2',
      guildId: 'guild-2',
      discordUserId: 'discord-2',
    });

    Date.now = () => issuedAt;
    const expiredToken = await createSetupSession('auth-user-3', 'guild-3', 'discord-3', secret);
    createdTokens.add(expiredToken);

    Date.now = () => issuedAt + 60 * 60 * 1000 + 1;
    expect(await resolveSetupSession(expiredToken, secret)).toBeNull();
  });

  it('given the same untampered token and secret, when resolved repeatedly, then verification remains stable', async () => {
    const secret = 'setup-secret';
    const token = await createSetupSession('auth-user-4', 'guild-4', 'discord-4', secret);
    createdTokens.add(token);

    const first = await resolveSetupSession(token, secret);
    const second = await resolveSetupSession(token, secret);

    expect(first).toMatchObject({
      authUserId: 'auth-user-4',
      guildId: 'guild-4',
      discordUserId: 'discord-4',
    });
    expect(second).toMatchObject({
      authUserId: 'auth-user-4',
      guildId: 'guild-4',
      discordUserId: 'discord-4',
    });
  });
});
