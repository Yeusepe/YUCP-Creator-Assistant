import { resolveSharedYucpAliasIdFromCatalogProducts } from '@yucp/shared';

export type CatalogProductAliasSource = {
  _id: string;
  aliases?: string[] | null;
  canonicalSlug?: string | null;
  displayName?: string | null;
  providerProductRef?: string | null;
};

export type SyntheticAliasMetadataSeed = {
  aliasId: string;
  catalogProductIds: string[];
  channel: string;
};

export function buildSyntheticAliasMetadataSeed(
  catalogProducts: ReadonlyArray<CatalogProductAliasSource>,
  channel: string
): SyntheticAliasMetadataSeed | undefined {
  const uniqueProducts = Array.from(
    new Map(catalogProducts.map((product) => [String(product._id), product])).values()
  ).sort((left, right) => String(left._id).localeCompare(String(right._id)));
  const aliasId = resolveSharedYucpAliasIdFromCatalogProducts(uniqueProducts);
  if (!aliasId) {
    return undefined;
  }

  return {
    aliasId,
    catalogProductIds: uniqueProducts.map((product) => String(product._id)),
    channel,
  };
}
