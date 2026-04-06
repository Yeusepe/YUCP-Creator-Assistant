/**
 * Product Selector Domain Model
 *
 * A ProductSelector is the canonical type used to express "what is this
 * entitlement check targeting?" across the platform.
 *
 * Two canonical variants:
 *   - catalogProduct: matches a specific catalog product by canonical ID
 *   - catalogTier: matches a specific catalog tier by canonical ID
 *
 * This discriminated union is the shared seam between transport layers (e.g.,
 * API routes that accept productIds or selectors) and the application layer
 * (entitlement lookups, verification checks).
 *
 * Adding a new variant:
 *   1. Add a new `type` literal + shape interface below
 *   2. Add it to the `ProductSelector` union
 *   3. Add a `is<Variant>Selector` guard
 *   4. Handle it in `normalizeProductSelector`
 */

// ============================================================================
// VARIANTS
// ============================================================================

/** Target a specific catalog product by canonical ID. */
export interface CatalogProductSelector {
  readonly kind: 'catalogProduct';
  readonly catalogProductId: string;
}

/**
 * Target a specific catalog tier by canonical ID.
 */
export interface CatalogTierSelector {
  readonly kind: 'catalogTier';
  readonly catalogTierId: string;
}

// ============================================================================
// UNION
// ============================================================================

export type ProductSelector = CatalogProductSelector | CatalogTierSelector;

// ============================================================================
// TYPE GUARDS
// ============================================================================

export function isCatalogProductSelector(s: ProductSelector): s is CatalogProductSelector {
  return s.kind === 'catalogProduct';
}

export function isCatalogTierSelector(s: ProductSelector): s is CatalogTierSelector {
  return s.kind === 'catalogTier';
}

// ============================================================================
// NORMALIZATION
// ============================================================================

/**
 * Normalize a raw (unknown) value into a `ProductSelector`, or return `null`
 * if the value cannot be parsed as a valid selector.
 *
 * Accepted raw forms:
 *   - `{ kind: 'catalogProduct', catalogProductId: string }` → CatalogProductSelector
 *   - `{ kind: 'catalogTier', catalogTierId: string }` → CatalogTierSelector
 *   - `string` (non-empty) → CatalogProductSelector (legacy shorthand)
 *
 * Transitional compatibility:
 *   - `{ type: 'product_id', productId: string }`
 *   - `{ type: 'tier', tier: string }`
 */
export function normalizeProductSelector(raw: unknown): ProductSelector | null {
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    return { kind: 'catalogProduct', catalogProductId: trimmed };
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const obj = raw as Record<string, unknown>;

  if (obj.kind === 'catalogProduct' || obj.type === 'product_id') {
    const rawProductId =
      typeof obj.catalogProductId === 'string'
        ? obj.catalogProductId
        : typeof obj.productId === 'string'
          ? obj.productId
          : null;
    if (!rawProductId?.trim()) return null;
    return { kind: 'catalogProduct', catalogProductId: rawProductId.trim() };
  }

  if (obj.kind === 'catalogTier' || obj.type === 'tier') {
    const rawTierId =
      typeof obj.catalogTierId === 'string'
        ? obj.catalogTierId
        : typeof obj.tier === 'string'
          ? obj.tier
          : null;
    if (!rawTierId?.trim()) return null;
    return { kind: 'catalogTier', catalogTierId: rawTierId.trim() };
  }

  return null;
}

/**
 * Normalize an array of raw values into `ProductSelector[]`.
 * Entries that fail normalization are silently dropped.
 * Returns an empty array if `raw` is not an array.
 */
export function normalizeProductSelectorList(raw: unknown): ProductSelector[] {
  if (!Array.isArray(raw)) return [];
  const selectors: ProductSelector[] = [];
  for (const item of raw) {
    const s = normalizeProductSelector(item);
    if (s !== null) selectors.push(s);
  }
  return selectors;
}

/**
 * Convert a legacy `productIds: string[]` array into `CatalogProductSelector[]`.
 * Provided for backward-compatibility at API ingress points.
 */
export function legacyProductIdsToSelectors(productIds: string[]): CatalogProductSelector[] {
  return productIds
    .map((id) => id.trim())
    .filter(Boolean)
    .map((catalogProductId) => ({ kind: 'catalogProduct' as const, catalogProductId }));
}
