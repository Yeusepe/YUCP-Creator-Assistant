import { getProviderDescriptor } from '@yucp/providers/providerMetadata';
import type { Id } from '../../../../convex/_generated/dataModel';
import type { VerificationIntentRequirementInput } from './hostedIntents';
import { getVerificationConfig } from './verificationConfig';

export type BuyerAccessCatalogProduct = {
  catalogProductId: Id<'product_catalog'>;
  catalogProductIds?: Id<'product_catalog'>[];
  creatorAuthUserId: string;
  packageId?: string;
  aliasId?: string;
  productId: string;
  provider: string;
  providerProductRef: string;
  displayName?: string;
  canonicalSlug?: string;
  /** Canonical public storefront URL stored from provider API data at sync time. */
  productUrl?: string;
  thumbnailUrl?: string;
  status: 'active';
  storefronts: BuyerAccessStorefront[];
};

export type BuyerAccessStorefront = {
  catalogProductId: Id<'product_catalog'>;
  productId: string;
  provider: string;
  providerProductRef: string;
  displayName?: string;
  canonicalSlug?: string;
  /** Canonical public storefront URL stored from provider API data at sync time. */
  productUrl?: string;
  thumbnailUrl?: string;
};

export function getBuyerAccessStorefronts(
  product: BuyerAccessCatalogProduct
): BuyerAccessStorefront[] {
  return product.storefronts;
}

export function buildHostedVerificationRequirements(
  product: BuyerAccessCatalogProduct
): VerificationIntentRequirementInput[] {
  const requirements: VerificationIntentRequirementInput[] = [];
  for (const storefront of getBuyerAccessStorefronts(product)) {
    const descriptor = getProviderDescriptor(storefront.provider);
    const methodSuffix = String(storefront.catalogProductId);
    requirements.push({
      methodKey: `yucp-existing-entitlement-${methodSuffix}`,
      providerKey: 'yucp',
      kind: 'existing_entitlement',
      creatorAuthUserId: product.creatorAuthUserId,
      productId: storefront.productId,
    });

    if (
      descriptor?.buyerVerificationMethods.includes('account_link') &&
      descriptor.supportsBuyerOAuthLink === true &&
      Boolean(getVerificationConfig(storefront.provider))
    ) {
      requirements.push({
        methodKey: `${storefront.provider}-buyer-provider-link-${methodSuffix}`,
        providerKey: storefront.provider,
        kind: 'buyer_provider_link',
        creatorAuthUserId: product.creatorAuthUserId,
        productId: storefront.productId,
      });
    }

    if (descriptor?.buyerVerificationMethods.includes('license_key')) {
      requirements.push({
        methodKey: `${storefront.provider}-manual-license-${methodSuffix}`,
        providerKey: storefront.provider,
        kind: 'manual_license',
        creatorAuthUserId: product.creatorAuthUserId,
        productId: storefront.productId,
        providerProductRef: storefront.providerProductRef,
      });
    }
  }

  return requirements;
}
