/**
 * License format detection for Gumroad and Jinxxy providers.
 *
 * Gumroad: 32-char alphanumeric 8-8-8-8
 * Jinxxy: UUID 8-4-4-4-12 or short_key 4-12 (alphanumeric prefix, hex suffix)
 */

/** Gumroad license format: 8-8-8-8 alphanumeric */
const GUMROAD_REGEX = /^[A-Za-z0-9]{8}-[A-Za-z0-9]{8}-[A-Za-z0-9]{8}-[A-Za-z0-9]{8}$/;

/** Jinxxy UUID format: 8-4-4-4-12 hex */
const JINXXY_UUID_REGEX =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Jinxxy short_key format: 4 alphanumeric - 12 hex (case-insensitive hex to match jinx-master) */
const JINXXY_SHORT_KEY_REGEX = /^[A-Za-z0-9]{4}-[a-fA-F0-9]{12}$/;

export type LicenseFormat = 'gumroad' | 'jinxxy' | 'unknown';

/**
 * Detect which provider a license key format belongs to.
 *
 * @param key - The license key string to inspect
 * @returns 'gumroad' | 'jinxxy' | 'unknown'
 */
export function detectLicenseFormat(key: string): LicenseFormat {
  const trimmed = key.trim();
  if (!trimmed) return 'unknown';

  if (GUMROAD_REGEX.test(trimmed)) return 'gumroad';
  if (JINXXY_UUID_REGEX.test(trimmed) || JINXXY_SHORT_KEY_REGEX.test(trimmed)) return 'jinxxy';

  return 'unknown';
}
