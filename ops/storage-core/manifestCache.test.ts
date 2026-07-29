import { describe, expect, it } from 'bun:test';
import type { DeliveryManifest } from './deliveryManifest';
import { BoundedManifestCache } from './manifestCache';

const HOUR_MS = 60 * 60 * 1_000;

function entry(body: string) {
  return {
    bindingRoot: 'bb'.repeat(32),
    body,
    manifest: {} as DeliveryManifest,
    releaseRoot: 'aa'.repeat(32),
  };
}

function cache(options?: {
  maxBodyBytes?: number;
  maxEntries?: number;
  now?: () => number;
  ttlMs?: number;
}) {
  return new BoundedManifestCache({
    maxBodyBytes: options?.maxBodyBytes ?? 1_024,
    maxEntries: options?.maxEntries ?? 16,
    ttlMs: options?.ttlMs ?? HOUR_MS,
    ...(options?.now ? { now: options.now } : {}),
  });
}

describe('BoundedManifestCache', () => {
  it('returns cached entries and misses unknown versions', () => {
    const subject = cache();
    subject.set('v1', entry('manifest-body'));

    expect(subject.get('v1')?.body).toBe('manifest-body');
    expect(subject.get('v2')).toBeUndefined();
  });

  it('evicts the least recently used entry when the byte bound overflows', () => {
    const subject = cache({ maxBodyBytes: 10 });
    subject.set('v1', entry('aaaa'));
    subject.set('v2', entry('bbbb'));
    subject.get('v1');
    subject.set('v3', entry('cccc'));

    expect(subject.get('v2')).toBeUndefined();
    expect(subject.get('v1')?.body).toBe('aaaa');
    expect(subject.get('v3')?.body).toBe('cccc');
  });

  it('evicts the oldest entry when the entry cap overflows', () => {
    const subject = cache({ maxEntries: 2 });
    subject.set('v1', entry('a'));
    subject.set('v2', entry('b'));
    subject.set('v3', entry('c'));

    expect(subject.get('v1')).toBeUndefined();
    expect(subject.get('v2')?.body).toBe('b');
    expect(subject.get('v3')?.body).toBe('c');
  });

  it('expires entries after the configured lifetime', () => {
    let clock = 1_000;
    const subject = cache({ now: () => clock, ttlMs: 500 });
    subject.set('v1', entry('short-lived'));

    expect(subject.get('v1')?.body).toBe('short-lived');
    clock += 500;
    expect(subject.get('v1')).toBeUndefined();
  });

  it('never stores a body larger than the bound', () => {
    const subject = cache({ maxBodyBytes: 4 });
    subject.set('v1', entry('too-large-body'));

    expect(subject.get('v1')).toBeUndefined();
  });

  it('deletes entries and frees their budget', () => {
    const subject = cache({ maxBodyBytes: 8 });
    subject.set('v1', entry('aaaa'));
    subject.delete('v1');
    subject.set('v2', entry('bbbb'));
    subject.set('v3', entry('cccc'));

    expect(subject.get('v1')).toBeUndefined();
    expect(subject.get('v2')?.body).toBe('bbbb');
    expect(subject.get('v3')?.body).toBe('cccc');
  });

  it('rejects non-positive bounds', () => {
    expect(() => cache({ maxBodyBytes: 0 })).toThrow();
    expect(() => cache({ maxEntries: 0 })).toThrow();
    expect(() => cache({ ttlMs: 0 })).toThrow();
  });
});
