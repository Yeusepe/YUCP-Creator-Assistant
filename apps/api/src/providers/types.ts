/**
 * Provider Plugin Architecture
 *
 * Each provider is a self-contained module that exports a default ProviderPlugin object.
 * The plugin handles credential resolution from Convex, product listing, and (optionally) backfill.
 *
 * Adding a new provider:
 * 1. Create apps/api/src/providers/{name}.ts — implement ProviderPlugin
 * 2. Add import + array entry in apps/api/src/providers/index.ts
 * Route handlers (products.ts, backfill.ts) require zero changes.
 */

import type { getConvexClientFromUrl } from '../lib/convex';

/** Infrastructure context passed to all provider plugin methods */
export interface ProviderContext {
  convex: ReturnType<typeof getConvexClientFromUrl>;
  apiSecret: string;
  authUserId: string;
  encryptionSecret: string;
}

/** A single purchase record produced by the backfill pipeline */
export interface BackfillRecord {
  /** Set to '' in fetchPage; injected by the backfill runner */
  authUserId: string;
  provider: string;
  externalOrderId: string;
  externalLineItemId?: string;
  buyerEmailHash: string | undefined;
  providerUserId?: string;
  providerProductId: string;
  paymentStatus: string;
  lifecycleStatus: 'active' | 'refunded' | 'cancelled' | 'disputed';
  purchasedAt: number;
}

/** A product returned by the products listing endpoint */
export interface ProductRecord {
  id: string;
  name?: string;
  [key: string]: unknown;
}

/** Optional backfill capability — providers that don't support backfill omit this */
export interface BackfillPlugin {
  /** Milliseconds to wait between paginated fetches */
  readonly pageDelayMs: number;
  /**
   * Fetch one page of purchase records.
   * @param credential Pre-decrypted provider credential
   * @param productRef Provider-specific product identifier
   * @param cursor Opaque pagination cursor; null = first page
   * @param pageSize Number of items to request per page
   */
  fetchPage(
    credential: string,
    productRef: string,
    cursor: string | null,
    pageSize: number,
  ): Promise<{ facts: BackfillRecord[]; nextCursor: string | null }>;
}

/**
 * Named HKDF domain-separation labels for every credential type a provider encrypts/decrypts.
 * Providers export these as a named `PURPOSES` const so callers import the string from here
 * rather than duplicating magic literals. `credential` is the primary API key / access token.
 */
export interface ProviderPurposes {
  /** The primary credential used in getCredential() / the connect flow */
  readonly credential: string;
  readonly [key: string]: string;
}

/** The main contract every provider module must satisfy */
export interface ProviderPlugin {
  /** Provider identifier — must match the provider key used in Convex and Gumroad/Jinxxy/etc. */
  readonly id: string;
  /**
   * HKDF purpose strings for every credential type this provider manages.
   * Callers import `PURPOSES` from the provider module and reference e.g. `PURPOSES.credential`.
   */
  readonly purposes: ProviderPurposes;
  /**
   * Whether this provider requires an external API credential.
   * Set to false for providers that only query Convex (e.g. Payhip).
   * When true and getCredential returns null, the handler returns a "not connected" error.
   */
  readonly needsCredential: boolean;
  /**
   * Resolve and decrypt the provider credential from Convex.
   * Returns null if not configured.
   */
  getCredential(ctx: ProviderContext): Promise<string | null>;
  /**
   * List available products for this provider.
   * credential is pre-decrypted (null when needsCredential is false).
   */
  fetchProducts(credential: string | null, ctx: ProviderContext): Promise<ProductRecord[]>;
  /** Optional — undefined means this provider does not support purchase backfill */
  readonly backfill?: BackfillPlugin;
}
