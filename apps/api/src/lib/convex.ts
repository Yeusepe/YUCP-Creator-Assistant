/**
 * Convex HTTP client for server-side API calls.
 * Used by install and verification routes to call Convex mutations.
 */

import { ConvexHttpClient } from 'convex/browser';

type ConvexServerClient = {
  // biome-ignore lint/suspicious/noExplicitAny: Convex server wrappers are intentionally dynamic at this boundary.
  query: (functionReference: unknown, args?: unknown) => Promise<any>;
  // biome-ignore lint/suspicious/noExplicitAny: Convex server wrappers are intentionally dynamic at this boundary.
  mutation: (functionReference: unknown, args?: unknown) => Promise<any>;
  // biome-ignore lint/suspicious/noExplicitAny: Convex server wrappers are intentionally dynamic at this boundary.
  action: (functionReference: unknown, args?: unknown) => Promise<any>;
};

export type { ConvexServerClient };

let client: ConvexServerClient | null = null;

/**
 * Create a Convex HTTP client from a URL.
 * Use when URL comes from config (e.g. verification routes).
 */
export function getConvexClientFromUrl(url: string): ConvexServerClient {
  const convexUrl = url.startsWith('http')
    ? url
    : `https://${url.includes(':') ? url.split(':')[1] : url}.convex.cloud`;
  return new ConvexHttpClient(convexUrl) as unknown as ConvexServerClient;
}

/**
 * Get or create the Convex HTTP client.
 * Uses CONVEX_URL and requires CONVEX_API_SECRET for authenticated calls.
 */
export function getConvexClient(): ConvexServerClient {
  if (!client) {
    const url = process.env.CONVEX_URL ?? process.env.CONVEX_DEPLOYMENT;
    if (!url) {
      throw new Error('CONVEX_URL or CONVEX_DEPLOYMENT must be set for Convex client');
    }
    // CONVEX_URL should be full URL (e.g. https://xxx.convex.cloud)
    // CONVEX_DEPLOYMENT may be "dev:xxx" - extract deployment name for URL
    const convexUrl = url.startsWith('http')
      ? url
      : `https://${url.includes(':') ? url.split(':')[1] : url}.convex.cloud`;
    client = new ConvexHttpClient(convexUrl) as unknown as ConvexServerClient;
  }
  return client;
}

/**
 * Get the API secret for Convex mutations.
 * Must match CONVEX_API_SECRET in Convex deployment.
 */
export function getConvexApiSecret(): string {
  const secret = process.env.CONVEX_API_SECRET;
  if (!secret) {
    throw new Error('CONVEX_API_SECRET must be set for Convex API calls');
  }
  return secret;
}
