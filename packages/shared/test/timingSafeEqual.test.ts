import { describe, expect, it } from 'bun:test';
import { timingSafeStringEqual } from '../src/crypto/timingSafeEqual';

describe('timingSafeStringEqual', () => {
  it('returns true for equal ASCII strings', () => {
    expect(timingSafeStringEqual('secret-value', 'secret-value')).toBe(true);
  });

  it('returns false for different strings of the same length', () => {
    expect(timingSafeStringEqual('secret-value', 'secret-valuf')).toBe(false);
  });

  it('returns false for different strings of different lengths', () => {
    expect(timingSafeStringEqual('secret', 'secret-value')).toBe(false);
  });

  it('compares unicode strings by their UTF-8 bytes', () => {
    expect(timingSafeStringEqual('héllo', 'héllo')).toBe(true);
    expect(timingSafeStringEqual('héllo', 'hello')).toBe(false);
  });
});
