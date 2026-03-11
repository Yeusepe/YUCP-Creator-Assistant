import { describe, expect, it } from 'bun:test';
import { toBufferSource } from '../src/crypto/toBufferSource';

describe('toBufferSource', () => {
  it('preserves bytes for ArrayBuffer-backed Uint8Array', () => {
    const u8 = new Uint8Array([1, 2, 3, 4]);
    const res = toBufferSource(u8);
    const out = res instanceof ArrayBuffer ? new Uint8Array(res) : (res as Uint8Array);
    expect(Array.from(out)).toEqual([1, 2, 3, 4]);
    if (res instanceof Uint8Array) expect(res as Uint8Array<ArrayBuffer>).toBe(u8);
  });

  it('copies from SharedArrayBuffer into ArrayBuffer when SharedArrayBuffer is present', () => {
    if (typeof SharedArrayBuffer === 'undefined') return;
    const sab = new SharedArrayBuffer(4);
    const u8 = new Uint8Array(sab);
    u8[0] = 9;
    u8[1] = 8;
    u8[2] = 7;
    u8[3] = 6;
    const res = toBufferSource(u8);
    expect(res instanceof ArrayBuffer).toBe(true);
    const out = new Uint8Array(res as ArrayBuffer);
    expect(Array.from(out)).toEqual([9, 8, 7, 6]);
    // Not the same underlying buffer
    expect(Object.is(res, u8.buffer)).toBe(false);
  });
});
