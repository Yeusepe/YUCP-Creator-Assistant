/**
 * Shared API authentication helpers for Convex mutations and queries.
 *
 * Centralizes requireApiSecret so every module uses constant-time comparison
 * and there is a single place to update the logic.
 */

import { constantTimeEqual } from './vrchat/crypto';

/**
 * Throws if the supplied apiSecret does not match CONVEX_API_SECRET.
 * Uses constant-time comparison to prevent timing-based secret enumeration.
 */
export function requireApiSecret(apiSecret: string | undefined): void {
  const expected = process.env.CONVEX_API_SECRET;
  if (!expected || !constantTimeEqual(apiSecret ?? '', expected)) {
    throw new Error('Unauthorized: invalid or missing API secret');
  }
}
