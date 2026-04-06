/**
 * Gumroad Provider Adapter
 *
 * Implements the ProviderAdapter interface for Gumroad OAuth and API integration.
 * Provides purchase verification through OAuth-based access to user's Gumroad sales.
 *
 * Usage:
 * ```ts
 * const adapter = new GumroadAdapter(config, encryptionService);
 * const authUrl = await adapter.beginVerification(authUserId, subjectId);
 * // Redirect user to authUrl, then handle callback
 * const result = await adapter.completeVerification(code, state);
 * ```
 */

import type { Verification } from '@yucp/shared';
import type { ProviderAdapter, ProviderConfig, PurchaseRecord } from '../legacyAdapter';
import { GumroadApiError, GumroadOAuthClient } from './oauth';
import type {
  AuthorizationUrlResult,
  GumroadAdapterConfig,
  GumroadLicenseVerifyResponse,
  GumroadProduct,
  GumroadProductResponse,
  GumroadPurchaseEvidence,
  GumroadSale,
  GumroadSaleResponse,
  GumroadSalesResponse,
  OAuthCompletionResult,
} from './types';
import { getSaleStatus, normalizeSaleToEvidence } from './types';

/**
 * Token storage interface (to be implemented by the application)
 */
export interface TokenStorage {
  /** Store encrypted tokens for a user */
  storeTokens(
    authUserId: string,
    gumroadUserId: string,
    accessToken: unknown,
    refreshToken: unknown,
    expiresAt: number
  ): Promise<void>;

  /** Retrieve tokens for a user */
  getTokens(
    authUserId: string,
    gumroadUserId: string
  ): Promise<{
    accessToken: unknown;
    refreshToken: unknown;
    expiresAt: number;
  } | null>;

  /** Delete tokens for a user */
  deleteTokens(authUserId: string, gumroadUserId: string): Promise<void>;
}

/**
 * Encryption service interface (uses envelope encryption from @yucp/shared)
 */
export interface EncryptionService {
  /** Encrypt a token using envelope encryption */
  encryptToken(
    token: string,
    authUserId: string,
    tokenType: 'access' | 'refresh'
  ): Promise<unknown>;

  /** Decrypt a token using envelope encryption */
  decryptToken(
    encryptedToken: unknown,
    authUserId: string,
    tokenType: 'access' | 'refresh'
  ): Promise<string>;
}

/**
 * State storage interface for OAuth state management
 */
export interface StateStorage {
  /** Store OAuth state */
  storeState(
    state: string,
    data: { authUserId: string; subjectId?: string; codeVerifier: string }
  ): Promise<void>;

  /** Retrieve and delete OAuth state */
  consumeState(
    state: string
  ): Promise<{ authUserId: string; subjectId?: string; codeVerifier: string } | null>;
}

/**
 * In-memory state storage (for development/testing only)
 */
export class InMemoryStateStorage implements StateStorage {
  private states = new Map<
    string,
    { authUserId: string; subjectId?: string; codeVerifier: string; createdAt: number }
  >();
  private readonly maxAgeMs = 600000; // 10 minutes

  async storeState(
    state: string,
    data: { authUserId: string; subjectId?: string; codeVerifier: string }
  ): Promise<void> {
    this.states.set(state, { ...data, createdAt: Date.now() });
    // Clean up expired states
    for (const [key, value] of this.states.entries()) {
      if (Date.now() - value.createdAt > this.maxAgeMs) {
        this.states.delete(key);
      }
    }
  }

  async consumeState(
    state: string
  ): Promise<{ authUserId: string; subjectId?: string; codeVerifier: string } | null> {
    const data = this.states.get(state);
    if (!data) return null;

    // Check expiration
    if (Date.now() - data.createdAt > this.maxAgeMs) {
      this.states.delete(state);
      return null;
    }

    this.states.delete(state);
    return {
      authUserId: data.authUserId,
      subjectId: data.subjectId,
      codeVerifier: data.codeVerifier,
    };
  }
}

/**
 * Gumroad provider adapter implementing ProviderAdapter interface
 */
export class GumroadAdapter implements ProviderAdapter {
  readonly name = 'gumroad';

  private readonly oauthClient: GumroadOAuthClient;
  private readonly apiBaseUrl: string;

  constructor(
    readonly config: ProviderConfig & GumroadAdapterConfig,
    private readonly tokenStorage?: TokenStorage,
    private readonly encryptionService?: EncryptionService,
    private readonly stateStorage: StateStorage = new InMemoryStateStorage()
  ) {
    this.oauthClient = new GumroadOAuthClient({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      redirectUri: config.redirectUri,
      apiBaseUrl: config.apiBaseUrl,
      oauthBaseUrl: config.oauthBaseUrl,
    });
    this.apiBaseUrl = config.apiBaseUrl ?? 'https://api.gumroad.com/v2';
  }

  /**
   * Begin the OAuth verification flow.
   * Returns an authorization URL to redirect the user to.
   *
   * @param authUserId - The creator's auth user ID
   * @param subjectId - Optional subject ID (YUCP user)
   * @param options - Additional options (scope)
   */
  async beginVerification(
    authUserId: string,
    subjectId?: string,
    options?: { scope?: string }
  ): Promise<AuthorizationUrlResult> {
    const result = await this.oauthClient.getAuthorizationUrl(authUserId, {
      scope: options?.scope,
      subjectId,
    });

    // Store state for later verification
    await this.stateStorage.storeState(result.state, {
      authUserId,
      subjectId,
      codeVerifier: result.codeVerifier ?? '',
    });

    return result;
  }

  /**
   * Complete the OAuth verification flow.
   * Exchanges the authorization code for tokens and fetches user info.
   *
   * @param code - The authorization code from the callback
   * @param state - The state parameter from the callback
   */
  async completeVerification(
    code: string,
    state: string
  ): Promise<OAuthCompletionResult & { authUserId?: string; subjectId?: string }> {
    // Retrieve and validate state
    const stateData = await this.stateStorage.consumeState(state);
    if (!stateData) {
      return {
        success: false,
        error: 'Invalid or expired OAuth state',
      };
    }

    // Complete OAuth flow
    const result = await this.oauthClient.completeOAuthFlow(code, stateData.codeVerifier);

    if (!result.success) {
      return { ...result, authUserId: stateData.authUserId, subjectId: stateData.subjectId };
    }

    // Encrypt and store tokens if encryption service is available
    if (this.encryptionService && this.tokenStorage && result.gumroadUserId) {
      const encryptedAccess = await this.encryptionService.encryptToken(
        result.encryptedAccessToken as string,
        stateData.authUserId,
        'access'
      );
      const encryptedRefresh = await this.encryptionService.encryptToken(
        result.encryptedRefreshToken as string,
        stateData.authUserId,
        'refresh'
      );

      await this.tokenStorage.storeTokens(
        stateData.authUserId,
        result.gumroadUserId,
        encryptedAccess,
        encryptedRefresh,
        result.expiresAt ?? 0
      );
    }

    return {
      ...result,
      encryptedAccessToken: undefined, // Don't return raw tokens
      encryptedRefreshToken: undefined,
      authUserId: stateData.authUserId,
      subjectId: stateData.subjectId,
    };
  }

  /**
   * Verify a license key against a Gumroad product.
   * Uses POST https://api.gumroad.com/v2/licenses/verify (no OAuth required).
   *
   * Gumroad API note: products created before Jan 9 2023 use the field "product_permalink"
   * (the URL slug, e.g. "abc123" from gumroad.com/l/abc123). Products created after that
   * date require "product_id" (a unique ID shown in the License Key module on the product
   * settings page). We try product_id first; if Gumroad says the license doesn’t match,
   * we automatically retry with product_permalink so both old and new products work.
   *
   * @param licenseKey - The license key to verify
   * @param productId  - The Gumroad product ID or permalink (we try both automatically)
   * @param options    - Optional: increment_uses_count (default false)
   */
  async verifyLicense(
    licenseKey: string,
    productId: string,
    options?: { incrementUsesCount?: boolean }
  ): Promise<{
    valid: boolean;
    uses?: number;
    isTestPurchase?: boolean;
    purchaseEmail?: string;
    saleId?: string;
    error?: string;
  }> {
    const body = new URLSearchParams();
    body.append('product_id', productId);
    body.append('license_key', licenseKey);
    if (options?.incrementUsesCount === true) {
      body.append('increment_uses_count', 'true');
    }

    const response = await fetch(`${this.apiBaseUrl}/licenses/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
    });

    const data = (await response.json()) as GumroadLicenseVerifyResponse;

    if (!response.ok || !data.success) {
      return { valid: false, error: data.message ?? `HTTP ${response.status}` };
    }

    return {
      valid: true,
      uses: data.uses,
      isTestPurchase: data.purchase?.test,
      purchaseEmail: data.purchase?.email as string | undefined,
      saleId: data.purchase?.sale_id as string | undefined,
    };
  }

  /**
   * Verify a purchase by email address.
   * Fetches sales from the authenticated user's Gumroad account.
   *
   * @param emailOrId - Email address or Gumroad user ID to verify
   */
  async verifyPurchase(_emailOrId: string): Promise<Verification | null> {
    // This method is for backward compatibility with ProviderAdapter
    // In practice, verification is done via OAuth flow
    // Here we would need the tokens to be available

    if (!this.tokenStorage || !this.encryptionService) {
      throw new Error('Token storage and encryption service required for verifyPurchase');
    }

    // This is a placeholder - actual implementation would:
    // 1. Get stored tokens for the user
    // 2. Fetch purchases from Gumroad API
    // 3. Return verification result

    return null;
  }

  /**
   * Get recent purchases for the authenticated user.
   *
   * @param accessToken - The decrypted access token
   * @param limit - Maximum number of purchases to return
   */
  // ProviderAdapter defines getRecentPurchases(limit?: number): Promise<PurchaseRecord[]>
  // For Gumroad, fetching recent purchases requires an access token tied to a
  // Gumroad account. The generic ProviderAdapter surface does not provide that
  // token, so this method returns an empty list when called through the
  // ProviderAdapter interface. Use getPurchases(accessToken) when you have a
  // decrypted access token for the account.
  async getRecentPurchases(_limit = 50): Promise<PurchaseRecord[]> {
    console.warn(
      'GumroadAdapter.getRecentPurchases: no access token available via ProviderAdapter interface; returning empty list'
    );
    return [];
  }

  /**
   * Get all purchases for an authenticated user.
   *
   * @param accessToken - The decrypted access token
   */
  async getPurchases(accessToken: string): Promise<GumroadPurchaseEvidence[]> {
    const userResponse = await this.oauthClient.getCurrentUser(accessToken);
    if (!userResponse.success || !userResponse.user) {
      throw new GumroadApiError('Failed to get user information', 401);
    }

    const gumroadUserId = String(userResponse.user.id);
    const sales = await this.getSales(accessToken);

    return sales.map((sale) => normalizeSaleToEvidence(sale, gumroadUserId));
  }

  /**
   * Fetch sales from Gumroad API.
   *
   * @param accessToken - The access token
   * @param limit - Maximum number of sales to fetch
   */
  private async getSales(accessToken: string, limit = 100): Promise<GumroadSale[]> {
    const allSales: GumroadSale[] = [];
    let nextPageUrl: string | undefined =
      `${this.apiBaseUrl}/sales?access_token=${accessToken}&per_page=${Math.min(limit, 100)}`;

    while (nextPageUrl && allSales.length < limit) {
      const response = await fetch(nextPageUrl, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
        },
      });

      if (!response.ok) {
        const text = await response.text();
        throw new GumroadApiError(`Failed to fetch sales: ${text}`, response.status);
      }

      const data = (await response.json()) as GumroadSalesResponse;

      if (!data.success) {
        throw new GumroadApiError('Failed to fetch sales', 500);
      }

      allSales.push(...data.sales);
      nextPageUrl = data.next_page_url;

      // Stop if we have enough sales
      if (allSales.length >= limit) {
        break;
      }
    }

    return allSales.slice(0, limit);
  }

  /**
   * Get a single sale by ID.
   * Uses GET /v2/sales/:id — returns the sale if it exists in the creator's account.
   *
   * @param accessToken - The OAuth access token
   * @param saleId - The Gumroad sale ID (from webhook sale_id)
   */
  async getSale(accessToken: string, saleId: string): Promise<GumroadSale | null> {
    const response = await fetch(
      `${this.apiBaseUrl}/sales/${encodeURIComponent(saleId)}?access_token=${encodeURIComponent(accessToken)}`,
      {
        method: 'GET',
        headers: {
          Accept: 'application/json',
        },
      }
    );

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      const text = await response.text();
      throw new GumroadApiError(`Failed to fetch sale: ${text}`, response.status);
    }

    const data = (await response.json()) as GumroadSaleResponse;

    if (!data.success || !data.sale) {
      return null;
    }

    return data.sale;
  }

  /**
   * Get a specific product by ID.
   *
   * @param accessToken - The access token
   * @param productId - The Gumroad product ID
   */
  async getProduct(accessToken: string, productId: string): Promise<GumroadProduct | null> {
    const response = await fetch(
      `${this.apiBaseUrl}/products/${productId}?access_token=${accessToken}`,
      {
        method: 'GET',
        headers: {
          Accept: 'application/json',
        },
      }
    );

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      const text = await response.text();
      throw new GumroadApiError(`Failed to fetch product: ${text}`, response.status);
    }

    const data = (await response.json()) as GumroadProductResponse;

    if (!data.success) {
      return null;
    }

    return data.product;
  }

  /**
   * Check if a purchase has been refunded, chargebacked, or disputed.
   *
   * @param accessToken - The access token
   * @param saleId - The sale ID to check
   */
  async checkPurchaseStatus(
    accessToken: string,
    saleId: string
  ): Promise<{
    found: boolean;
    status: 'active' | 'refunded' | 'chargebacked' | 'disputed' | 'unknown';
    sale?: GumroadSale;
  }> {
    // Fetch all sales and find the specific one
    // Note: Gumroad API doesn't have a direct endpoint for a single sale
    const sales = await this.getSales(accessToken);
    const sale = sales.find((s) => s.id === saleId);

    if (!sale) {
      return { found: false, status: 'unknown' };
    }

    return {
      found: true,
      status: getSaleStatus(sale),
      sale,
    };
  }

  /**
   * Revoke access for a user by deleting their tokens.
   *
   * @param authUserId - The creator's auth user ID
   * @param gumroadUserId - The Gumroad user ID
   */
  async revokeAccess(authUserId: string, gumroadUserId: string): Promise<void> {
    if (this.tokenStorage) {
      await this.tokenStorage.deleteTokens(authUserId, gumroadUserId);
    }
  }
}

export * from './oauth';
// Re-export types and utilities
export type {
  AuthorizationUrlResult,
  GumroadAdapterConfig,
  GumroadProduct,
  GumroadPurchaseEvidence,
  GumroadSale,
  OAuthCompletionResult,
} from './types';
export * from './types';

/**
 * Resolve the real Gumroad product_id from a product URL or permalink.
 *
 * Gumroad products created after Jan 2023 require a base64-encoded product_id
 * (e.g. "QAJc7ErxdAC815P5P8R89g==") for license verification - NOT the URL slug.
 * This function fetches the product page, parses the embedded data-page JSON,
 * and returns the real product.id.
 *
 * Supports:
 *  - Full URLs:  https://creator.gumroad.com/l/slug
 *  - Short URLs: https://gumroad.com/l/slug
 *  - Slugs:      slug  (reconstructed as https://gumroad.com/l/slug)
 *
 * @param urlOrSlug - A Gumroad product URL or slug
 * @returns The real Gumroad product_id (e.g. "QAJc7ErxdAC815P5P8R89g==")
 * @throws If the page can't be fetched or parsed
 */
export async function resolveGumroadProductId(urlOrSlug: string): Promise<string> {
  return (await resolveGumroadProduct(urlOrSlug)).id;
}

/**
 * Fetches a Gumroad product page and extracts both the internal product ID and the display name.
 */
export async function resolveGumroadProduct(
  urlOrSlug: string
): Promise<{ id: string; name: string | undefined }> {
  // Normalise plain slugs to a full URL
  let url = urlOrSlug.trim();
  if (!url.startsWith('http')) {
    url = `https://gumroad.com/l/${url}`;
  }

  const response = await fetch(url, {
    headers: {
      // Mimic a real browser so Gumroad serves the full HTML with data-page
      'User-Agent': 'Mozilla/5.0 (compatible; YUCP-Bot/1.0)',
      Accept: 'text/html',
    },
    redirect: 'follow',
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch Gumroad product page (${response.status}): ${url}`);
  }

  const html = await response.text();

  // Gumroad embeds all page data in a data-page attribute on the root div
  const match = html.match(/data-page="([^"]+)"/);
  if (!match) {
    throw new Error(`Could not find data-page attribute on Gumroad product page: ${url}`);
  }

  // Decode HTML entities then parse as JSON
  const decoded = match[1]
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&#x([0-9A-Fa-f]+);/g, (_, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16))
    );

  let pageData: unknown;
  try {
    pageData = JSON.parse(decoded);
  } catch {
    throw new Error(`Could not parse data-page JSON from Gumroad product page: ${url}`);
  }

  const product =
    typeof pageData === 'object' &&
    pageData !== null &&
    'props' in pageData &&
    typeof pageData.props === 'object' &&
    pageData.props !== null &&
    'product' in pageData.props &&
    typeof pageData.props.product === 'object' &&
    pageData.props.product !== null
      ? (pageData.props.product as Record<string, unknown>)
      : undefined;

  const productId = typeof product?.id === 'string' ? product.id : undefined;
  if (!productId) {
    throw new Error(`Could not find product.id in Gumroad page data: ${url}`);
  }

  const productName = typeof product?.name === 'string' ? product.name : undefined;

  return { id: productId, name: productName };
}
