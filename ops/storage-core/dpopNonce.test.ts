import { describe, expect, it } from 'bun:test';
import { createDpopNonceManager } from './dpopNonce';

const secret = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const now = new Date('2033-05-18T03:33:20.000Z');

describe('DPoP server nonce', () => {
  it('issues an unpredictable opaque nonce tied to server time', async () => {
    const manager = createDpopNonceManager({
      lifetimeSeconds: 300,
      secret,
    });

    const first = await manager.issue(now);
    const second = await manager.issue(now);

    expect(first.nonce).not.toBe(second.nonce);
    expect(first.expiresAt).toEqual(new Date(now.getTime() + 300_000));
    expect(await manager.verify(first.nonce, now)).toEqual({
      expiresAt: first.expiresAt,
    });
  });

  it('rejects expired, tampered, and foreign-purpose nonces', async () => {
    const manager = createDpopNonceManager({ secret });
    const otherManager = createDpopNonceManager({
      purpose: 'yucp:another-dpop-resource:v1',
      secret,
    });
    const issued = await manager.issue(now);
    const segments = issued.nonce.split('.');
    const signature = segments[3] as string;
    const replacement = signature.startsWith('A') ? 'B' : 'A';
    const tampered = [...segments.slice(0, 3), `${replacement}${signature.slice(1)}`].join('.');

    await expect(manager.verify(tampered, now)).resolves.toBeNull();
    await expect(otherManager.verify(issued.nonce, now)).resolves.toBeNull();
    await expect(
      manager.verify(issued.nonce, new Date(now.getTime() + 300_000))
    ).resolves.toBeNull();
    await expect(
      manager.verify(issued.nonce, new Date(now.getTime() + 301_000))
    ).resolves.toBeNull();
  });

  it('rejects unsafe configuration and nonces issued beyond the future-skew allowance', async () => {
    expect(() => createDpopNonceManager({ secret: new Uint8Array(31) })).toThrow(
      'configuration is invalid'
    );

    const manager = createDpopNonceManager({ acceptedFutureSkewSeconds: 5, secret });
    const futureNonce = await manager.issue(new Date(now.getTime() + 6_000));

    await expect(manager.verify(futureNonce.nonce, now)).resolves.toBeNull();
  });
});
