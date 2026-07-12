import { describe, expect, it } from 'bun:test';

import { sign, verify } from './signing';

const SECRET = '11'.repeat(32);
const WRONG_SECRET = '22'.repeat(32);

function futurePayload() {
  return {
    typ: 'backstage-upload',
    authUserId: 'auth-user-1',
    exp: Math.floor(Date.now() / 1000) + 60,
  };
}

describe('backstage ingest signing', () => {
  it('round-trips a signed payload and preserves its type', async () => {
    const payload = futurePayload();

    const verified = await verify<typeof payload>(SECRET, await sign(SECRET, payload));

    expect(verified).toEqual(payload);
    expect(verified.typ).toBe('backstage-upload');
  });

  it('rejects a tampered payload', async () => {
    const token = await sign(SECRET, futurePayload());
    const [encodedPayload, encodedSignature] = token.split('.');
    const tamperedPayload = btoa(JSON.stringify({ ...futurePayload(), authUserId: 'attacker' }))
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');

    await expect(verify(SECRET, `${tamperedPayload}.${encodedSignature}`)).rejects.toThrow(
      'signature'
    );
    expect(encodedPayload).not.toBe(tamperedPayload);
  });

  it('rejects an expired token', async () => {
    const token = await sign(SECRET, {
      ...futurePayload(),
      exp: Math.floor(Date.now() / 1000) - 1,
    });

    await expect(verify(SECRET, token)).rejects.toThrow('expired');
  });

  it('rejects a token signed with a different secret', async () => {
    const token = await sign(SECRET, futurePayload());

    await expect(verify(WRONG_SECRET, token)).rejects.toThrow('signature');
  });
});
