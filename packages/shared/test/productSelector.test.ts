import { describe, expect, it } from 'bun:test';
import {
  type CatalogProductSelector,
  type CatalogTierSelector,
  isCatalogProductSelector,
  isCatalogTierSelector,
  legacyProductIdsToSelectors,
  normalizeProductSelector,
  normalizeProductSelectorList,
} from '../src/product/selector';

// ============================================================================
// normalizeProductSelector
// ============================================================================

describe('normalizeProductSelector', () => {
  describe('string shorthand (legacy catalog product selector)', () => {
    it('converts a non-empty string to a catalog product selector', () => {
      expect(normalizeProductSelector('prod-abc')).toEqual({
        kind: 'catalogProduct',
        catalogProductId: 'prod-abc',
      });
    });

    it('trims whitespace from a string value', () => {
      expect(normalizeProductSelector('  prod-abc  ')).toEqual({
        kind: 'catalogProduct',
        catalogProductId: 'prod-abc',
      });
    });

    it('returns null for an empty string', () => {
      expect(normalizeProductSelector('')).toBeNull();
    });

    it('returns null for a whitespace-only string', () => {
      expect(normalizeProductSelector('   ')).toBeNull();
    });
  });

  describe('catalogProduct object', () => {
    it('accepts a well-formed catalog product selector', () => {
      expect(
        normalizeProductSelector({ kind: 'catalogProduct', catalogProductId: 'prod-123' })
      ).toEqual({
        kind: 'catalogProduct',
        catalogProductId: 'prod-123',
      });
    });

    it('trims catalogProductId whitespace', () => {
      expect(
        normalizeProductSelector({ kind: 'catalogProduct', catalogProductId: '  abc  ' })
      ).toEqual({
        kind: 'catalogProduct',
        catalogProductId: 'abc',
      });
    });

    it('returns null when catalogProductId is empty', () => {
      expect(normalizeProductSelector({ kind: 'catalogProduct', catalogProductId: '' })).toBeNull();
    });

    it('returns null when catalogProductId is whitespace-only', () => {
      expect(
        normalizeProductSelector({ kind: 'catalogProduct', catalogProductId: '   ' })
      ).toBeNull();
    });

    it('returns null when catalogProductId is missing', () => {
      expect(normalizeProductSelector({ kind: 'catalogProduct' })).toBeNull();
    });

    it('returns null when catalogProductId is not a string', () => {
      expect(normalizeProductSelector({ kind: 'catalogProduct', catalogProductId: 42 })).toBeNull();
    });
  });

  describe('catalogTier object', () => {
    it('accepts a well-formed catalog tier selector', () => {
      expect(
        normalizeProductSelector({ kind: 'catalogTier', catalogTierId: 'tier-premium' })
      ).toEqual({
        kind: 'catalogTier',
        catalogTierId: 'tier-premium',
      });
    });

    it('trims catalogTierId whitespace', () => {
      expect(
        normalizeProductSelector({ kind: 'catalogTier', catalogTierId: '  tier-standard  ' })
      ).toEqual({
        kind: 'catalogTier',
        catalogTierId: 'tier-standard',
      });
    });

    it('returns null when catalogTierId is empty', () => {
      expect(normalizeProductSelector({ kind: 'catalogTier', catalogTierId: '' })).toBeNull();
    });

    it('returns null when catalogTierId is missing', () => {
      expect(normalizeProductSelector({ kind: 'catalogTier' })).toBeNull();
    });

    it('returns null when catalogTierId is not a string', () => {
      expect(normalizeProductSelector({ kind: 'catalogTier', catalogTierId: 99 })).toBeNull();
    });
  });

  describe('transitional compatibility', () => {
    it('accepts legacy product_id objects and normalizes them to catalogProduct', () => {
      expect(normalizeProductSelector({ type: 'product_id', productId: 'prod-legacy' })).toEqual({
        kind: 'catalogProduct',
        catalogProductId: 'prod-legacy',
      });
    });

    it('accepts legacy tier objects and normalizes them to catalogTier', () => {
      expect(normalizeProductSelector({ type: 'tier', tier: 'tier-legacy' })).toEqual({
        kind: 'catalogTier',
        catalogTierId: 'tier-legacy',
      });
    });
  });

  describe('invalid inputs', () => {
    it('returns null for null', () => {
      expect(normalizeProductSelector(null)).toBeNull();
    });

    it('returns null for undefined', () => {
      expect(normalizeProductSelector(undefined)).toBeNull();
    });

    it('returns null for a number', () => {
      expect(normalizeProductSelector(42)).toBeNull();
    });

    it('returns null for an array', () => {
      expect(normalizeProductSelector(['prod-abc'])).toBeNull();
    });

    it('returns null for an object with an unknown type', () => {
      expect(normalizeProductSelector({ type: 'catalog_item', id: 'x' })).toBeNull();
    });

    it('returns null for an empty object', () => {
      expect(normalizeProductSelector({})).toBeNull();
    });
  });
});

// ============================================================================
// normalizeProductSelectorList
// ============================================================================

describe('normalizeProductSelectorList', () => {
  it('returns an empty array for a non-array value', () => {
    expect(normalizeProductSelectorList('not-an-array')).toEqual([]);
    expect(normalizeProductSelectorList(null)).toEqual([]);
    expect(normalizeProductSelectorList(undefined)).toEqual([]);
  });

  it('returns an empty array for an empty array', () => {
    expect(normalizeProductSelectorList([])).toEqual([]);
  });

  it('normalizes a mixed list, silently dropping invalid entries', () => {
    const raw = [
      'prod-abc',
      { kind: 'catalogTier', catalogTierId: 'tier-premium' },
      null,
      '',
      { kind: 'catalogProduct', catalogProductId: 'prod-xyz' },
    ];
    expect(normalizeProductSelectorList(raw)).toEqual([
      { kind: 'catalogProduct', catalogProductId: 'prod-abc' },
      { kind: 'catalogTier', catalogTierId: 'tier-premium' },
      { kind: 'catalogProduct', catalogProductId: 'prod-xyz' },
    ]);
  });

  it('drops all entries that fail normalization', () => {
    expect(normalizeProductSelectorList([null, undefined, 42, {}])).toEqual([]);
  });

  it('handles a list of plain string product IDs', () => {
    expect(normalizeProductSelectorList(['a', 'b', 'c'])).toEqual([
      { kind: 'catalogProduct', catalogProductId: 'a' },
      { kind: 'catalogProduct', catalogProductId: 'b' },
      { kind: 'catalogProduct', catalogProductId: 'c' },
    ]);
  });
});

// ============================================================================
// legacyProductIdsToSelectors
// ============================================================================

describe('legacyProductIdsToSelectors', () => {
  it('converts an array of product ID strings to CatalogProductSelectors', () => {
    expect(legacyProductIdsToSelectors(['a', 'b'])).toEqual([
      { kind: 'catalogProduct', catalogProductId: 'a' },
      { kind: 'catalogProduct', catalogProductId: 'b' },
    ]);
  });

  it('trims whitespace from each ID', () => {
    expect(legacyProductIdsToSelectors(['  abc  ', 'def'])).toEqual([
      { kind: 'catalogProduct', catalogProductId: 'abc' },
      { kind: 'catalogProduct', catalogProductId: 'def' },
    ]);
  });

  it('drops empty or whitespace-only strings', () => {
    expect(legacyProductIdsToSelectors(['', '  ', 'ok'])).toEqual([
      { kind: 'catalogProduct', catalogProductId: 'ok' },
    ]);
  });

  it('returns an empty array for an empty input', () => {
    expect(legacyProductIdsToSelectors([])).toEqual([]);
  });
});

// ============================================================================
// type guards
// ============================================================================

describe('isCatalogProductSelector', () => {
  it('returns true for a catalogProduct selector', () => {
    const s: CatalogProductSelector = { kind: 'catalogProduct', catalogProductId: 'x' };
    expect(isCatalogProductSelector(s)).toBe(true);
  });

  it('returns false for a catalogTier selector', () => {
    const s: CatalogTierSelector = { kind: 'catalogTier', catalogTierId: 'tier-standard' };
    expect(isCatalogProductSelector(s)).toBe(false);
  });
});

describe('isCatalogTierSelector', () => {
  it('returns true for a catalogTier selector', () => {
    const s: CatalogTierSelector = { kind: 'catalogTier', catalogTierId: 'tier-premium' };
    expect(isCatalogTierSelector(s)).toBe(true);
  });

  it('returns false for a catalogProduct selector', () => {
    const s: CatalogProductSelector = { kind: 'catalogProduct', catalogProductId: 'y' };
    expect(isCatalogTierSelector(s)).toBe(false);
  });
});

// ============================================================================
// discriminated union narrowing (compile-time check)
// ============================================================================

describe('discriminated union narrowing', () => {
  it('switch on type narrows to the correct variant', () => {
    const inputs = normalizeProductSelectorList([
      'prod-1',
      { kind: 'catalogTier', catalogTierId: 'tier-premium' },
      { kind: 'catalogProduct', catalogProductId: 'prod-2' },
    ]);

    const productIds: string[] = [];
    const tiers: string[] = [];

    for (const selector of inputs) {
      switch (selector.kind) {
        case 'catalogProduct':
          productIds.push(selector.catalogProductId);
          break;
        case 'catalogTier':
          tiers.push(selector.catalogTierId);
          break;
      }
    }

    expect(productIds).toEqual(['prod-1', 'prod-2']);
    expect(tiers).toEqual(['tier-premium']);
  });
});
