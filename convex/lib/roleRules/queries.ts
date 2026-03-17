/**
 * Shared helper functions for role_rules mutations and queries.
 */

export { requireApiSecret } from '../apiAuth';

export async function sha256Hex(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function normalizeProductUrl(url: string): string {
  try {
    const parsed = new URL(url.trim().toLowerCase());
    const path = parsed.pathname.replace(/\/+$/, '') || '/';
    return `${parsed.origin}${path}`;
  } catch {
    return url.trim().toLowerCase();
  }
}
