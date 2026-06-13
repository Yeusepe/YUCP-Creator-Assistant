import type { StructuredLogger } from '@yucp/shared';
import type {
  LicenseVerificationPlugin,
  ProductRecord,
  ProviderContext,
  ProviderPurposes,
  ProviderRuntimeClient,
  ProviderRuntimeModule,
  ProviderTierRecord,
} from '../contracts';
import {
  ProviderRateLimitError,
  parseRetryAfterMs,
  withProviderRateLimitRetries,
} from '../core/rateLimit';
import type {
  GumroadProduct,
  GumroadProductsResponse,
  GumroadProductVariant,
  GumroadRecurrencePrice,
} from './types';
import { buildGumroadTierRef as createGumroadTierRef, normalizeGumroadWhitespace } from './types';

export const GUMROAD_PURPOSES = {
  credential: 'gumroad-oauth-access-token',
  refreshToken: 'gumroad-oauth-refresh-token',
} as const satisfies ProviderPurposes;

export const GUMROAD_DISPLAY_META = {
  dashboardSetupExperience: 'automatic',
  dashboardSetupHint: 'OAuth redirect plus managed webhook setup can continue automatically.',
  label: 'Gumroad',
  icon: 'Gumorad.png',
  color: '#ff90e8',
  shadowColor: '#ff90e8',
  textColor: '#000000',
  connectedColor: '#e269c9',
  confettiColors: ['#ff90e8', '#e269c9', '#ff70d0', '#ffffff'],
  description: 'Marketplace',
  dashboardConnectPath: '/api/connect/gumroad/begin',
  dashboardConnectParamStyle: 'camelCase',
  dashboardIconBg: '#0f0f12',
  dashboardQuickStartBg: 'rgba(255,255,255,0.05)',
  dashboardQuickStartBorder: 'rgba(255,255,255,0.1)',
  dashboardServerTileHint: 'Allow users to verify Gumroad purchases in this Discord server.',
} as const;

const GUMROAD_API_BASE = 'https://api.gumroad.com/v2';
const GUMROAD_PRODUCTS_URL = `${GUMROAD_API_BASE}/products`;
const MAX_PRODUCTS = 5000;

type GumroadRuntimeLogger = Pick<StructuredLogger, 'warn'>;

type GumroadFetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface GumroadVerificationPorts {
  fetchImpl?: GumroadFetchLike;
  getEncryptedCredential?(ctx: ProviderContext): Promise<string | null>;
  decryptCredential?(encryptedCredential: string, ctx: ProviderContext): Promise<string>;
}

export interface GumroadRuntimePorts<
  TClient extends ProviderRuntimeClient = ProviderRuntimeClient,
> {
  readonly logger: GumroadRuntimeLogger;
  getEncryptedCredential(ctx: ProviderContext<TClient>): Promise<string | null>;
  decryptCredential(encryptedCredential: string, ctx: ProviderContext<TClient>): Promise<string>;
  fetchImpl?: GumroadFetchLike;
}

export type GumroadProviderRuntime<TClient extends ProviderRuntimeClient = ProviderRuntimeClient> =
  Omit<ProviderRuntimeModule<never, TClient>, 'backfill' | 'buyerVerification'> & {
    readonly buyerVerification?: undefined;
  };

function getFetch(ports: GumroadVerificationPorts): GumroadFetchLike {
  return ports.fetchImpl ?? fetch;
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function fetchGumroadProducts(
  accessToken: string,
  ports: GumroadRuntimePorts
): Promise<GumroadProduct[]> {
  const products: GumroadProduct[] = [];
  let nextPageUrl: string | undefined = GUMROAD_PRODUCTS_URL;
  const fetchImpl = getFetch(ports);
  const seenPageUrls = new Set<string>();
  const seenCursors = new Set<string>();

  while (nextPageUrl && products.length < MAX_PRODUCTS) {
    const parsedUrl = normalizeGumroadProductsPageUrl(nextPageUrl, ports.logger);
    if (!parsedUrl) {
      break;
    }

    const normalizedUrl = parsedUrl.toString();
    if (seenPageUrls.has(normalizedUrl)) {
      ports.logger.warn('Ignoring Gumroad pagination link', {
        reason: 'repeated-link',
      });
      break;
    }

    const cursor = parsedUrl.searchParams.get('cursor');
    if (cursor && seenCursors.has(cursor)) {
      ports.logger.warn('Ignoring Gumroad pagination link', {
        reason: 'repeated-cursor',
      });
      break;
    }

    seenPageUrls.add(normalizedUrl);
    if (cursor) {
      seenCursors.add(cursor);
    }

    // Gumroad products API reference: https://gumroad.com/api#products
    const response = await withProviderRateLimitRetries({
      providerName: 'Gumroad',
      operation: async () => {
        const result = await fetchImpl(normalizedUrl, {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
        });

        if (result.status === 429) {
          throw new ProviderRateLimitError(
            'Gumroad',
            parseRetryAfterMs(result.headers.get('Retry-After'), 5_000)
          );
        }

        return result;
      },
      getRateLimitError: (error) => (error instanceof ProviderRateLimitError ? error : null),
      onRetry: ({ waitMs, retries }) => {
        ports.logger.warn('Gumroad rate limit fetching products', {
          waitMs,
          rateLimitRetries: retries + 1,
        });
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Gumroad API error: ${response.status} ${text}`);
    }

    const data = (await response.json()) as GumroadProductsResponse;

    if (!data.success) {
      throw new Error(data.message ?? 'Gumroad API returned an error');
    }

    for (const product of data.products ?? []) {
      if (product.id && product.name) {
        products.push(product);
      }
    }

    nextPageUrl = data.next_page_url;
    if (!nextPageUrl || (data.products ?? []).length === 0) {
      break;
    }
  }

  return products;
}

async function listGumroadProducts(
  accessToken: string,
  ports: GumroadRuntimePorts
): Promise<ProductRecord[]> {
  const products = await fetchGumroadProducts(accessToken, ports);
  return products.map((product) => ({
    id: product.id,
    name: product.name,
    ...(product.short_url ? { productUrl: product.short_url } : {}),
    ...(product.thumbnail_url ? { thumbnailUrl: product.thumbnail_url } : {}),
    ...(resolveGumroadCanonicalSlug(product)
      ? { canonicalSlug: resolveGumroadCanonicalSlug(product) }
      : {}),
  }));
}

function resolveGumroadCanonicalSlug(product: GumroadProduct): string | undefined {
  const customPermalink = product.custom_permalink?.trim();
  if (customPermalink) {
    return customPermalink;
  }

  const shortUrl = product.short_url?.trim();
  if (!shortUrl) {
    return undefined;
  }

  try {
    const parsed = new URL(shortUrl);
    const [, maybeSlug] = parsed.pathname.split('/l/');
    const normalized = maybeSlug?.split('/')[0]?.trim();
    return normalized || undefined;
  } catch {
    return undefined;
  }
}

function normalizeGumroadCurrency(currency: string | undefined): string | undefined {
  const normalized = currency?.trim();
  return normalized ? normalized.toUpperCase() : undefined;
}

function formatGumroadSelectionLabel(variantTitle: string, optionLabel: string): string {
  return `${variantTitle}: ${optionLabel}`;
}

function formatGumroadRecurrenceLabel(recurrence: string): string {
  const normalized = normalizeGumroadWhitespace(recurrence);
  return normalized.charAt(0).toUpperCase() + normalized.slice(1).toLowerCase();
}

function isGumroadProductActive(product: GumroadProduct): boolean {
  return product.published && !product.deleted_at;
}

function normalizeGumroadVariantTitle(variant: GumroadProductVariant): string | null {
  const title = variant.title ?? variant.name;
  if (!title) {
    return null;
  }
  const normalized = normalizeGumroadWhitespace(title);
  return normalized.length > 0 ? normalized : null;
}

function normalizeGumroadVariantOptions(
  variant: GumroadProductVariant
): Array<{ variantTitle: string; optionLabel: string }> {
  const variantTitle = normalizeGumroadVariantTitle(variant);
  if (!variantTitle) {
    return [];
  }

  return (variant.options ?? [])
    .map((option) => {
      const rawLabel =
        typeof option === 'string' ? option : (option.value ?? option.name ?? option.title ?? null);
      if (!rawLabel) {
        return null;
      }
      const optionLabel = normalizeGumroadWhitespace(rawLabel);
      if (optionLabel.length === 0) {
        return null;
      }
      return {
        variantTitle,
        optionLabel,
      };
    })
    .filter((option): option is { variantTitle: string; optionLabel: string } => option !== null);
}

function normalizeGumroadRecurrences(product: GumroadProduct): string[] {
  const values = [...(product.recurrences ?? []), ...Object.keys(product.recurrence_prices ?? {})]
    .map((value) => normalizeGumroadWhitespace(value))
    .filter((value) => value.length > 0);
  return Array.from(new Set(values));
}

function extractGumroadAmountCents(price: GumroadRecurrencePrice | undefined): number | undefined {
  if (typeof price === 'number' && Number.isFinite(price)) {
    return price;
  }
  if (typeof price === 'string') {
    const parsed = Number(price);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  if (!price || typeof price !== 'object') {
    return undefined;
  }
  if (typeof price.cents === 'number' && Number.isFinite(price.cents)) {
    return price.cents;
  }
  if (typeof price.amount_cents === 'number' && Number.isFinite(price.amount_cents)) {
    return price.amount_cents;
  }
  if (typeof price.price === 'number' && Number.isFinite(price.price)) {
    return price.price;
  }
  return undefined;
}

function extractGumroadFormattedPrice(
  price: GumroadRecurrencePrice | undefined
): string | undefined {
  if (!price || typeof price !== 'object' || typeof price === 'string') {
    return undefined;
  }
  return typeof price.formatted_price === 'string' ? price.formatted_price : undefined;
}

function buildMembershipTierRecords(product: GumroadProduct): ProviderTierRecord[] {
  const selections = (product.variants ?? []).flatMap((variant) =>
    normalizeGumroadVariantOptions(variant)
  );
  const membershipSelections =
    selections.length > 0
      ? selections
      : [
          {
            variantTitle: 'Tier',
            optionLabel: normalizeGumroadWhitespace(product.name),
          },
        ];
  const recurrences = normalizeGumroadRecurrences(product);
  const active = isGumroadProductActive(product);
  const currency = normalizeGumroadCurrency(product.currency) ?? 'USD';
  const recurrenceKeys = recurrences.length > 0 ? recurrences : [undefined];

  return membershipSelections.flatMap(({ variantTitle, optionLabel }) =>
    recurrenceKeys.map((recurrence) => {
      const recurrencePrice = recurrence ? product.recurrence_prices?.[recurrence] : undefined;
      const selection = formatGumroadSelectionLabel(variantTitle, optionLabel);
      return {
        id: createGumroadTierRef({
          productId: product.id,
          variantTitle,
          optionLabel,
          recurrence,
        }),
        productId: product.id,
        name: recurrence
          ? `${optionLabel} (${formatGumroadRecurrenceLabel(recurrence)})`
          : optionLabel,
        description: undefined,
        amountCents: extractGumroadAmountCents(recurrencePrice),
        currency,
        active,
        metadata: {
          provider: 'gumroad',
          isTieredMembership: true,
          selection,
          variantTitle,
          optionLabel,
          ...(recurrence ? { recurrence } : {}),
          ...(extractGumroadFormattedPrice(recurrencePrice)
            ? { formattedPrice: extractGumroadFormattedPrice(recurrencePrice) }
            : {}),
        },
      };
    })
  );
}

function buildVariantOptionTierRecords(product: GumroadProduct): ProviderTierRecord[] {
  const active = isGumroadProductActive(product);
  const currency = normalizeGumroadCurrency(product.currency) ?? 'USD';
  return (product.variants ?? []).flatMap((variant) =>
    normalizeGumroadVariantOptions(variant).map(({ variantTitle, optionLabel }) => ({
      id: createGumroadTierRef({
        productId: product.id,
        variantTitle,
        optionLabel,
      }),
      productId: product.id,
      name: formatGumroadSelectionLabel(variantTitle, optionLabel),
      description: undefined,
      amountCents: undefined,
      currency,
      active,
      metadata: {
        provider: 'gumroad',
        isTieredMembership: false,
        selection: formatGumroadSelectionLabel(variantTitle, optionLabel),
        variantTitle,
        optionLabel,
      },
    }))
  );
}

function listGumroadProductTiers(product: GumroadProduct): ProviderTierRecord[] {
  /**
   * Gumroad product payloads document `is_tiered_membership`, `recurrences`,
   * `recurrence_prices`, and `variants[].options[]`.
   * https://gumroad.com/api#products
   */
  if (product.is_tiered_membership) {
    return buildMembershipTierRecords(product);
  }
  return buildVariantOptionTierRecords(product);
}

function normalizeGumroadProductsPageUrl(rawUrl: string, logger: GumroadRuntimeLogger): URL | null {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl, GUMROAD_PRODUCTS_URL);
  } catch {
    logger.warn('Ignoring Gumroad pagination link', {
      reason: 'invalid-url',
    });
    return null;
  }

  if (parsedUrl.origin !== new URL(GUMROAD_API_BASE).origin) {
    logger.warn('Ignoring Gumroad pagination link', {
      reason: 'unexpected-origin',
    });
    return null;
  }

  if (parsedUrl.pathname !== new URL(GUMROAD_PRODUCTS_URL).pathname) {
    logger.warn('Ignoring Gumroad pagination link', {
      reason: 'unexpected-path',
    });
    return null;
  }

  parsedUrl.searchParams.delete('access_token');
  return parsedUrl;
}

export async function verifyGumroadLicense(
  licenseKey: string,
  productId: string,
  ports: GumroadVerificationPorts,
  accessToken?: string
): Promise<{
  valid: boolean;
  externalOrderId?: string;
  providerUserId?: string;
  error?: string;
}> {
  const fetchImpl = getFetch(ports);

  async function attemptVerification(identifierKey: 'product_id' | 'product_permalink') {
    // Gumroad licenses API reference: https://gumroad.com/api#licenses
    const requestBody = new URLSearchParams({
      [identifierKey]: productId,
      license_key: licenseKey,
      increment_uses_count: 'false',
    });
    if (accessToken) {
      requestBody.set('access_token', accessToken);
    }
    const response = await fetchImpl(`${GUMROAD_API_BASE}/licenses/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: requestBody.toString(),
    });

    const data = (await response.json()) as {
      success: boolean;
      message?: string;
      purchase?: {
        email?: string;
        sale_id?: string;
      };
    };

    if (!response.ok || !data.success) {
      return {
        valid: false as const,
        error: data.message ?? `HTTP ${response.status}`,
      };
    }

    return {
      valid: true as const,
      externalOrderId: data.purchase?.sale_id ?? undefined,
      providerUserId: data.purchase?.email ? await sha256Hex(data.purchase.email) : undefined,
    };
  }

  const productIdResult = await attemptVerification('product_id');
  if (productIdResult.valid) {
    return productIdResult;
  }

  return await attemptVerification('product_permalink');
}

export function createGumroadLicenseVerification<
  TClient extends ProviderRuntimeClient = ProviderRuntimeClient,
>(ports: GumroadVerificationPorts): LicenseVerificationPlugin<TClient> {
  return {
    async verifyLicense(licenseKey, productId, _authUserId, ctx) {
      if (!productId) {
        return { valid: false, error: 'Product ID is required for Gumroad verification' };
      }

      let accessToken: string | undefined;
      if (ports.getEncryptedCredential && ports.decryptCredential) {
        const encryptedCredential = await ports.getEncryptedCredential(ctx);
        if (encryptedCredential) {
          accessToken = await ports.decryptCredential(encryptedCredential, ctx);
        }
      }

      return await verifyGumroadLicense(licenseKey, productId, ports, accessToken);
    },
  };
}

export function createGumroadProviderModule<
  TClient extends ProviderRuntimeClient = ProviderRuntimeClient,
>(ports: GumroadRuntimePorts<TClient>): GumroadProviderRuntime<TClient> {
  return {
    id: 'gumroad',
    needsCredential: true,
    purposes: GUMROAD_PURPOSES,
    displayMeta: GUMROAD_DISPLAY_META,
    async getCredential(ctx) {
      const encryptedToken = await ports.getEncryptedCredential(ctx);
      if (!encryptedToken) {
        return null;
      }
      return await ports.decryptCredential(encryptedToken, ctx);
    },
    async fetchProducts(credential) {
      if (!credential) {
        return [];
      }

      return await listGumroadProducts(credential, ports);
    },
    tiers: {
      async listProductTiers(credential, productId): Promise<ProviderTierRecord[]> {
        if (!credential) {
          return [];
        }

        const products = await fetchGumroadProducts(credential, ports);
        const product = products.find((entry) => entry.id === productId);
        if (!product) {
          return [];
        }
        return listGumroadProductTiers(product);
      },
    },
    verification: createGumroadLicenseVerification(ports),
  };
}
