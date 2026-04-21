import { describe, expect, it } from 'bun:test';
import { getClientAddress } from './clientAddress';

describe('getClientAddress', () => {
  it('uses the Cloudflare connecting IP even when cf-ray is absent', () => {
    const request = new Request('https://api.example.com/test', {
      headers: {
        'cf-connecting-ip': '203.0.113.10',
      },
    });

    expect(getClientAddress(request)).toBe('203.0.113.10');
  });

  it('falls back to unknown when no trusted proxy IP is present', () => {
    const request = new Request('https://api.example.com/test', {
      headers: {
        'x-forwarded-for': '198.51.100.10',
        'x-real-ip': '198.51.100.11',
      },
    });

    expect(getClientAddress(request)).toBe('unknown');
  });
});
