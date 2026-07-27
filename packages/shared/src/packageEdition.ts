const CATALOG_TIER_ID_PATTERN = /^[a-z0-9]+$/;
const MAX_CATALOG_TIER_ID_LENGTH = 58;
const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const MAX_ENCODED_CATALOG_TIER_BYTES = 35;

export const STANDARD_PACKAGE_EDITION_ID = 'standard';

function base32Encode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  if (bytes.length > MAX_ENCODED_CATALOG_TIER_BYTES) {
    throw new Error('Catalog tier ID cannot form a package edition ID');
  }
  let accumulator = 0;
  let bits = 0;
  let encoded = '';
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      encoded += BASE32_ALPHABET[(accumulator >>> bits) & 31];
    }
  }
  if (bits > 0) {
    encoded += BASE32_ALPHABET[(accumulator << (5 - bits)) & 31];
  }
  return encoded;
}

export function catalogTierPackageEditionId(catalogTierId: string): string {
  const normalizedCatalogTierId = catalogTierId.trim();
  if (!normalizedCatalogTierId) {
    throw new Error('Catalog tier ID cannot form a package edition ID');
  }
  if (
    CATALOG_TIER_ID_PATTERN.test(normalizedCatalogTierId) &&
    normalizedCatalogTierId.length <= MAX_CATALOG_TIER_ID_LENGTH
  ) {
    return `tier-${normalizedCatalogTierId}`;
  }
  return `tier-x-${base32Encode(normalizedCatalogTierId)}`;
}
