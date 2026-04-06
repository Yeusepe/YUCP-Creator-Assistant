import { describe, expect, it } from 'bun:test';
import { detectLicenseFormat } from '../src/index';

describe('providers', () => {
  describe('detectLicenseFormat', () => {
    it('should detect Gumroad format (8-8-8-8 alphanumeric)', () => {
      expect(detectLicenseFormat('ABCD1234-EFGH5678-IJKL9012-MNOP3456')).toBe('gumroad');
      expect(detectLicenseFormat('abcdef12-34567890-abcdef12-34567890')).toBe('gumroad');
    });

    it('should detect Jinxxy UUID format (8-4-4-4-12)', () => {
      expect(detectLicenseFormat('550e8400-e29b-41d4-a716-446655440000')).toBe('jinxxy');
    });

    it('should detect Jinxxy short_key format (4-12)', () => {
      expect(detectLicenseFormat('ABCD-1234567890ab')).toBe('jinxxy');
    });

    it('should return unknown for invalid formats', () => {
      expect(detectLicenseFormat('')).toBe('unknown');
      expect(detectLicenseFormat('invalid')).toBe('unknown');
      expect(detectLicenseFormat('123-456')).toBe('unknown');
    });
  });
});
