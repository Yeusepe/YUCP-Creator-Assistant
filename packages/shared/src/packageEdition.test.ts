import { describe, expect, it } from 'bun:test';
import { catalogTierPackageEditionId } from './packageEdition';

describe('package edition identifiers', () => {
  it('keeps provider-neutral catalog tier editions stable and valid', () => {
    expect(catalogTierPackageEditionId('catalogtierpatreongold')).toBe(
      'tier-catalogtierpatreongold'
    );

    const encoded = catalogTierPackageEditionId('catalog_tier:provider/version');
    expect(encoded).toMatch(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])$/);
    expect(encoded).toBe(catalogTierPackageEditionId('catalog_tier:provider/version'));
    expect(encoded).not.toBe(catalogTierPackageEditionId('catalog-tier:provider/version'));
  });
});
