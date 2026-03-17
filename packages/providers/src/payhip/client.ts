/**
 * Payhip API Client
 *
 * HTTP client for Payhip license key API v2.
 * Uses per-product `product-secret-key` header for authentication.
 *
 * References:
 * - https://help.payhip.com/article/317-software-license-keys-new
 *
 * Usage:
 * ```ts
 * const client = new PayhipApiClient();
 * const result = await client.verifyLicenseKey('WTKP4-66NL5-HMKQW-GFSCZ', 'PRODUCT_SECRET');
 * ```
 */

import type { PayhipLicenseVerifyData, PayhipLicenseVerifyResponse } from './types';
import { PayhipApiError, PayhipRateLimitError } from './types';

const DEFAULT_API_BASE_URL = 'https://payhip.com/api/v2';
const DEFAULT_TIMEOUT = 30000;
const DEFAULT_MAX_RETRIES = 3;

export class PayhipApiClient {
  private readonly baseUrl: string;
  private readonly timeout: number;
  private readonly maxRetries: number;

  constructor(options?: { apiBaseUrl?: string; timeout?: number; maxRetries?: number }) {
    this.baseUrl = options?.apiBaseUrl ?? DEFAULT_API_BASE_URL;
    this.timeout = options?.timeout ?? DEFAULT_TIMEOUT;
    this.maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
  }

  /**
   * Make an authenticated request to the Payhip API.
   * Uses `product-secret-key` header for per-product authentication.
   */
  private async request<T>(
    method: 'GET' | 'PUT',
    path: string,
    productSecretKey: string,
    params?: Record<string, string>,
    body?: Record<string, string>,
    retryCount = 0
  ): Promise<T | null> {
    const url = new URL(`${this.baseUrl}${path}`);

    if (params) {
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.append(key, value);
      }
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    const headers: Record<string, string> = {
      'product-secret-key': productSecretKey,
      Accept: 'application/json',
    };

    let bodyStr: string | undefined;
    if (body) {
      bodyStr = new URLSearchParams(body).toString();
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }

    try {
      const response = await fetch(url.toString(), {
        method,
        headers,
        body: bodyStr,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (response.status === 429) {
        const retryAfter = response.headers.get('retry-after');
        const retryAfterMs = retryAfter ? Number.parseInt(retryAfter, 10) * 1000 : 1000;

        if (retryCount < this.maxRetries) {
          await this.sleep(retryAfterMs * (retryCount + 1));
          return this.request<T>(method, path, productSecretKey, params, body, retryCount + 1);
        }

        throw new PayhipRateLimitError('Rate limit exceeded after maximum retries', retryAfterMs);
      }

      if (!response.ok) {
        throw new PayhipApiError(`HTTP ${response.status}`, response.status);
      }

      const text = await response.text();
      // Payhip returns empty body for invalid license keys — treat as null
      if (!text || text.trim() === '') {
        return null;
      }

      const data = JSON.parse(text);
      return data as T;
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof PayhipApiError || error instanceof PayhipRateLimitError) {
        throw error;
      }
      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          throw new PayhipApiError('Request timeout', 408, 'timeout');
        }
        throw new PayhipApiError(error.message, 0, 'network_error');
      }
      throw new PayhipApiError('Unknown error', 0, 'unknown');
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ============================================================================
  // LICENSE KEY ENDPOINTS
  // ============================================================================

  /**
   * Verify a license key for a specific product.
   *
   * GET /api/v2/license/verify?license_key={key}
   * Header: product-secret-key: {productSecretKey}
   *
   * Returns null if the license key is invalid (Payhip returns empty response).
   *
   * @param licenseKey - The license key to verify (e.g., "WTKP4-66NL5-HMKQW-GFSCZ")
   * @param productSecretKey - The product-level secret key (from product edit page in Payhip)
   */
  async verifyLicenseKey(
    licenseKey: string,
    productSecretKey: string
  ): Promise<PayhipLicenseVerifyData | null> {
    const result = await this.request<PayhipLicenseVerifyResponse>(
      'GET',
      '/license/verify',
      productSecretKey,
      { license_key: licenseKey.trim() }
    );
    return result?.data ?? null;
  }

  /**
   * Disable a license key.
   *
   * PUT /api/v2/license/disable
   * Header: product-secret-key: {productSecretKey}
   *
   * @param licenseKey - The license key to disable
   * @param productSecretKey - The product-level secret key
   */
  async disableLicenseKey(
    licenseKey: string,
    productSecretKey: string
  ): Promise<PayhipLicenseVerifyData | null> {
    const result = await this.request<PayhipLicenseVerifyResponse>(
      'PUT',
      '/license/disable',
      productSecretKey,
      undefined,
      { license_key: licenseKey.trim() }
    );
    return result?.data ?? null;
  }

  /**
   * Enable a license key.
   *
   * PUT /api/v2/license/enable
   * Header: product-secret-key: {productSecretKey}
   *
   * @param licenseKey - The license key to enable
   * @param productSecretKey - The product-level secret key
   */
  async enableLicenseKey(
    licenseKey: string,
    productSecretKey: string
  ): Promise<PayhipLicenseVerifyData | null> {
    const result = await this.request<PayhipLicenseVerifyResponse>(
      'PUT',
      '/license/enable',
      productSecretKey,
      undefined,
      { license_key: licenseKey.trim() }
    );
    return result?.data ?? null;
  }

  /**
   * Increase the usage count of a license key.
   *
   * PUT /api/v2/license/usage
   * Header: product-secret-key: {productSecretKey}
   */
  async incrementLicenseUsage(
    licenseKey: string,
    productSecretKey: string
  ): Promise<PayhipLicenseVerifyData | null> {
    const result = await this.request<PayhipLicenseVerifyResponse>(
      'PUT',
      '/license/usage',
      productSecretKey,
      undefined,
      { license_key: licenseKey.trim() }
    );
    return result?.data ?? null;
  }

  /**
   * Decrease the usage count of a license key.
   *
   * PUT /api/v2/license/decrease
   * Header: product-secret-key: {productSecretKey}
   */
  async decrementLicenseUsage(
    licenseKey: string,
    productSecretKey: string
  ): Promise<PayhipLicenseVerifyData | null> {
    const result = await this.request<PayhipLicenseVerifyResponse>(
      'PUT',
      '/license/decrease',
      productSecretKey,
      undefined,
      { license_key: licenseKey.trim() }
    );
    return result?.data ?? null;
  }
}

export * from './types';
