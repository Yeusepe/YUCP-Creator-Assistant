/**
 * Shared helper functions for role_rules mutations and queries.
 */

export { requireApiSecret } from '../apiAuth';
export { sha256Hex } from '@yucp/shared/crypto';

export function normalizeProductUrl(url: string): string {
  try {
    const parsed = new URL(url.trim().toLowerCase());
    const path = parsed.pathname.replace(/\/+$/, '') || '/';
    return `${parsed.origin}${path}`;
  } catch {
    return url.trim().toLowerCase();
  }
}
