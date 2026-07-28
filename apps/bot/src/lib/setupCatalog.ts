import { providerLabel } from '@yucp/providers/providerMetadata';
import type { ProviderKey } from '@yucp/providers/types';

export type SetupCatalogProduct = {
  aliases?: string[];
  canonicalSlug?: string;
  id: string;
  name: string;
  provider: ProviderKey;
  productUrl?: string;
  thumbnailUrl?: string;
};

export type SetupCatalogProviderResult = {
  provider: ProviderKey;
  products: Array<{
    aliases?: string[];
    canonicalSlug?: string;
    id: string;
    name: string;
    productUrl?: string;
    thumbnailUrl?: string;
  }>;
  error?: string;
};

export type SetupCatalogSummary = {
  products: SetupCatalogProduct[];
  sessionExpiredProviders: ProviderKey[];
  providerErrors: Array<{ provider: ProviderKey; error: string }>;
};

export function summarizeSetupCatalogResults(
  results: SetupCatalogProviderResult[]
): SetupCatalogSummary {
  const seen = new Set<string>();
  const expiredProviderSet = new Set<ProviderKey>();
  const products: SetupCatalogProduct[] = [];
  const sessionExpiredProviders: ProviderKey[] = [];
  const providerErrors: Array<{ provider: ProviderKey; error: string }> = [];

  for (const result of results) {
    if (result.error) {
      providerErrors.push({ provider: result.provider, error: result.error });
      if (result.error === 'session_expired' && !expiredProviderSet.has(result.provider)) {
        expiredProviderSet.add(result.provider);
        sessionExpiredProviders.push(result.provider);
      }
    }

    for (const product of result.products) {
      const key = `${result.provider}:${product.id}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      products.push({
        aliases: product.aliases,
        canonicalSlug: product.canonicalSlug,
        id: product.id,
        name: product.name,
        provider: result.provider,
        productUrl: product.productUrl,
        thumbnailUrl: product.thumbnailUrl,
      });
    }
  }

  return {
    products,
    sessionExpiredProviders,
    providerErrors,
  };
}

function formatProviderLabels(providers: ProviderKey[]): string {
  const labels = providers.map((provider) => providerLabel(provider));
  if (labels.length <= 1) {
    return labels[0] ?? 'your store';
  }
  if (labels.length === 2) {
    return `${labels[0]} and ${labels[1]}`;
  }
  return `${labels.slice(0, -1).join(', ')}, and ${labels.at(-1)}`;
}

function getDistinctNonSessionErrorProviders(summary: SetupCatalogSummary): ProviderKey[] {
  const seen = new Set<ProviderKey>();
  const providers: ProviderKey[] = [];
  for (const error of summary.providerErrors) {
    if (error.error === 'session_expired' || seen.has(error.provider)) {
      continue;
    }
    seen.add(error.provider);
    providers.push(error.provider);
  }
  return providers;
}

export function buildMigrationEmptyCatalogReason(summary: SetupCatalogSummary): string {
  if (summary.sessionExpiredProviders.length > 0) {
    const providers = formatProviderLabels(summary.sessionExpiredProviders);
    const noun = summary.sessionExpiredProviders.length === 1 ? 'store session' : 'store sessions';
    return `YUCP could not read products from ${providers} because the ${noun} expired. Reconnect ${summary.sessionExpiredProviders.length === 1 ? 'that store' : 'those stores'}, then run migration again.`;
  }

  const errorProviders = getDistinctNonSessionErrorProviders(summary);
  if (errorProviders.length > 0) {
    const providers = formatProviderLabels(errorProviders);
    return `YUCP could not read products from ${providers} because those store connections returned errors. Resolve those provider errors, then run migration again.`;
  }

  return 'YUCP did not find any active products it could analyze. If your stores are already connected, reconnect them and try migration again.';
}

export function buildMigrationEmptyCatalogEventMessage(summary: SetupCatalogSummary): string {
  if (summary.sessionExpiredProviders.length > 0) {
    const providers = formatProviderLabels(summary.sessionExpiredProviders);
    return `Migration analysis could not read products because the connection expired for ${providers}.`;
  }

  const errorProviders = getDistinctNonSessionErrorProviders(summary);
  if (errorProviders.length > 0) {
    const providers = formatProviderLabels(errorProviders);
    return `Migration analysis could not read products because provider errors were returned for ${providers}.`;
  }

  return 'Migration analysis completed, but no active store products were available to map.';
}
