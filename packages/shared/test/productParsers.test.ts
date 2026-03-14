import { describe, expect, it } from 'bun:test';
import { parseProductId } from '../src/productParsers';

describe('parseProductId', () => {
  describe('gumroad', () => {
    it('accepts a standard URL slug', () => {
      const r = parseProductId('gumroad', 'https://gumroad.com/l/abc123');
      expect(r).toEqual({ ok: true, productId: 'abc123' });
    });

    it('accepts a subdomain URL', () => {
      const r = parseProductId('gumroad', 'https://user.gumroad.com/l/myproduct');
      expect(r).toEqual({ ok: true, productId: 'myproduct' });
    });

    it('accepts a dashboard /products/ URL', () => {
      const r = parseProductId('gumroad', 'https://app.gumroad.com/products/abc123');
      expect(r).toEqual({ ok: true, productId: 'abc123' });
    });

    it('accepts a raw alphanumeric slug', () => {
      const r = parseProductId('gumroad', 'abc123');
      expect(r).toEqual({ ok: true, productId: 'abc123' });
    });

    it('accepts a base64-encoded product ID with equals padding', () => {
      // Gumroad API returns base64-encoded IDs for products created after Jan 2023
      const r = parseProductId('gumroad', 'QAJc7ErxdAC815P5P8R89g==');
      expect(r).toEqual({ ok: true, productId: 'QAJc7ErxdAC815P5P8R89g==' });
    });

    it('accepts a base64 ID with + and / characters', () => {
      const r = parseProductId('gumroad', 'AB+/cd==');
      expect(r).toEqual({ ok: true, productId: 'AB+/cd==' });
    });

    it('rejects an empty string', () => {
      const r = parseProductId('gumroad', '');
      expect(r.ok).toBe(false);
    });

    it('rejects a two-character slug (too short)', () => {
      const r = parseProductId('gumroad', 'ab');
      expect(r.ok).toBe(false);
    });
  });

  describe('jinxxy', () => {
    it('accepts any non-empty string', () => {
      expect(parseProductId('jinxxy', 'some-product-id')).toEqual({
        ok: true,
        productId: 'some-product-id',
      });
    });

    it('rejects empty string', () => {
      expect(parseProductId('jinxxy', '').ok).toBe(false);
    });
  });

  describe('lemonsqueezy', () => {
    it('extracts numeric ID from URL', () => {
      const r = parseProductId('lemonsqueezy', 'https://mystore.lemonsqueezy.com/products/123456');
      expect(r).toEqual({ ok: true, productId: '123456' });
    });

    it('accepts a raw product ID', () => {
      expect(parseProductId('lemonsqueezy', '123456')).toEqual({ ok: true, productId: '123456' });
    });

    it('rejects empty string', () => {
      expect(parseProductId('lemonsqueezy', '').ok).toBe(false);
    });
  });

  describe('payhip', () => {
    it('extracts code from URL', () => {
      const r = parseProductId('payhip', 'https://payhip.com/b/RGsF');
      expect(r).toEqual({ ok: true, productId: 'RGsF' });
    });

    it('accepts a raw permalink', () => {
      expect(parseProductId('payhip', 'RGsF')).toEqual({ ok: true, productId: 'RGsF' });
    });

    it('rejects empty string', () => {
      expect(parseProductId('payhip', '').ok).toBe(false);
    });
  });

  describe('vrchat', () => {
    it('extracts avatar ID from URL', () => {
      const r = parseProductId(
        'vrchat',
        'https://vrchat.com/home/avatar/avtr_12345678-1234-1234-1234-123456789abc'
      );
      expect(r).toEqual({ ok: true, productId: 'avtr_12345678-1234-1234-1234-123456789abc' });
    });

    it('accepts a raw avatar ID', () => {
      const r = parseProductId('vrchat', 'avtr_12345678-1234-1234-1234-123456789abc');
      expect(r).toEqual({ ok: true, productId: 'avtr_12345678-1234-1234-1234-123456789abc' });
    });

    it('rejects a non-avatar ID', () => {
      expect(parseProductId('vrchat', 'not-an-avatar-id').ok).toBe(false);
    });
  });

  describe('unknown provider', () => {
    it('returns error for unknown provider', () => {
      const r = parseProductId('nonexistent', 'anything');
      expect(r).toEqual({ ok: false, error: 'Unknown provider: nonexistent' });
    });
  });
});
