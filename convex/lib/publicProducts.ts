import { resolveConfiguredApiBaseUrl } from '../../packages/shared/src/publicAuthority';

export type PublicProductProviderRef = {
  provider: string;
  providerProductRef: string;
};

export type PublicProductRecord = {
  productId: string;
  displayName?: string;
  providers: PublicProductProviderRef[];
  owner: string | null;
  configured: boolean;
  live: boolean;
};

export type ProviderProductsApiResponse = {
  products?: Array<{
    id?: string;
    name?: string;
    collaboratorName?: string;
  }>;
};

export type LiveProductSource = {
  authUserId: string;
  owner: string | null;
};

export type LiveProductFetchOptions = {
  env?: Record<string, string | undefined>;
  sources: LiveProductSource[];
  providerKeys: string[];
  fetchImpl?: typeof fetch;
  warn?: (message: string, ...args: unknown[]) => void;
};

let hasWarnedAboutMissingApiBaseUrl = false;

export function resolveLiveProductsApiBaseUrl(
  env: Record<string, string | undefined> = process.env
): string {
  return resolveConfiguredApiBaseUrl(env);
}

export async function fetchLiveProviderProductsForSources({
  env = process.env,
  sources,
  providerKeys,
  fetchImpl = fetch,
  warn = console.warn,
}: LiveProductFetchOptions): Promise<PublicProductRecord[]> {
  const apiBaseUrl = resolveLiveProductsApiBaseUrl(env);
  const apiSecret = env.CONVEX_API_SECRET;
  if (!apiBaseUrl) {
    if (!hasWarnedAboutMissingApiBaseUrl) {
      warn('[products] live provider fetch skipped because API_BASE_URL is missing or invalid');
      hasWarnedAboutMissingApiBaseUrl = true;
    }
    return [];
  }

  if (!apiSecret || sources.length === 0 || providerKeys.length === 0) {
    return [];
  }

  const liveProducts: PublicProductRecord[] = [];

  await Promise.all(
    sources.flatMap((source) =>
      providerKeys.map(async (providerKey) => {
        const providerUrl = `${apiBaseUrl}/api/${providerKey}/products`;
        try {
          const response = await fetchImpl(providerUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              apiSecret,
              authUserId: source.authUserId,
            }),
          });

          if (!response.ok) {
            return;
          }

          const payload = (await response.json()) as ProviderProductsApiResponse;
          for (const product of payload.products ?? []) {
            if (!product?.id) continue;
            liveProducts.push({
              productId: '',
              displayName: product.name ?? product.id,
              providers: [{ provider: providerKey, providerProductRef: product.id }],
              owner: (product.collaboratorName as string | undefined) ?? source.owner,
              configured: false,
              live: true,
            });
          }
        } catch (error) {
          warn(`[products] live provider fetch failed for ${providerKey} at ${providerUrl}`, error);
        }
      })
    )
  );

  return liveProducts;
}
