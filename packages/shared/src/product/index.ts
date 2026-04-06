/**
 * Product module - canonical product domain types.
 */

export type { CatalogProductSelector, CatalogTierSelector, ProductSelector } from './selector';
export {
  isCatalogProductSelector,
  isCatalogTierSelector,
  legacyProductIdsToSelectors,
  normalizeProductSelector,
  normalizeProductSelectorList,
} from './selector';
