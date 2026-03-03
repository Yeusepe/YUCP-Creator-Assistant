/**
 * Manual License Manager
 *
 * Handles license key generation, hashing, validation, usage tracking,
 * expiry, bulk import, and manual revoke.
 *
 * Security: License keys are NEVER stored in plaintext. Only SHA-256 hashes
 * are persisted to the database.
 */

import type {
  CreateLicenseInput,
  CreateLicenseResult,
  ValidateLicenseInput,
  ValidateLicenseResult,
  UseLicenseInput,
  UseLicenseResult,
  RevokeLicenseInput,
  BulkImportInput,
  BulkImportResult,
  GenerateKeyOptions,
  ManualLicense,
  ManualLicenseStorage,
} from './types';

/** Default prefix for generated license keys */
const DEFAULT_PREFIX = 'YUCP';

/** Default number of segments in a license key */
const DEFAULT_SEGMENTS = 4;

/** Default characters per segment */
const DEFAULT_SEGMENT_LENGTH = 4;

/** Characters used in license key generation (excludes ambiguous chars) */
const KEY_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * Generate a cryptographically secure random string.
 */
function randomChars(length: number): string {
  const chars = new Array(length);
  const randomValues = crypto.getRandomValues(new Uint8Array(length));
  for (let i = 0; i < length; i++) {
    chars[i] = KEY_CHARS[randomValues[i] % KEY_CHARS.length];
  }
  return chars.join('');
}

/**
 * Hash a license key using SHA-256.
 * @param key - The plaintext license key
 * @returns Hex-encoded SHA-256 hash
 */
export async function hashLicenseKey(key: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(key);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = new Uint8Array(hashBuffer);
  return Array.from(hashArray)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Generate a license key in format: PREFIX-XXXX-XXXX-XXXX
 * @param options - Generation options
 * @returns Generated license key
 */
export function generateLicenseKey(options: GenerateKeyOptions = {}): string {
  const prefix = options.prefix ?? DEFAULT_PREFIX;
  const segments = options.segments ?? DEFAULT_SEGMENTS;
  const segmentLength = options.segmentLength ?? DEFAULT_SEGMENT_LENGTH;

  const parts = [prefix];
  for (let i = 0; i < segments; i++) {
    parts.push(randomChars(segmentLength));
  }

  return parts.join('-');
}

/**
 * Normalize a license key for comparison.
 * Removes whitespace, replaces spaces with dashes, and converts to uppercase.
 */
export function normalizeLicenseKey(key: string): string {
  return key.trim().replace(/\s+/g, '-').toUpperCase();
}

/**
 * Check if a license has expired.
 */
function isExpired(expiresAt?: number): boolean {
  if (!expiresAt) return false;
  return Date.now() > expiresAt;
}

/**
 * Manual License Manager
 *
 * Provides all license management functionality including:
 * - Secure key generation
 * - SHA-256 hashing (never stores plaintext)
 * - Validation with expiry checks
 * - Usage tracking (seat counting)
 * - Bulk import for creators
 * - Manual revoke
 */
export class ManualLicenseManager {
  constructor(private storage: ManualLicenseStorage) {}

  /**
   * Generate a new license key and store its hash.
   * Returns both the license record and the plaintext key (shown once).
   */
  async generateLicense(input: CreateLicenseInput): Promise<CreateLicenseResult> {
    // Generate or use provided key
    const rawKey = input.licenseKey ?? generateLicenseKey();
    const licenseKey = normalizeLicenseKey(rawKey);

    // Hash the key (we only store the hash)
    const licenseKeyHash = await hashLicenseKey(licenseKey);

    // Check if key already exists
    const existing = await this.storage.findByKeyHash(licenseKeyHash);
    if (existing) {
      throw new Error('License key already exists');
    }

    // Create the license record
    const license = await this.storage.create({
      tenantId: input.tenantId,
      productId: input.productId,
      catalogProductId: input.catalogProductId,
      maxUses: input.maxUses,
      expiresAt: input.expiresAt,
      notes: input.notes,
      buyerEmail: input.buyerEmail,
      licenseKeyHash,
    });

    // Return license without hash + plaintext key
    const { licenseKeyHash: _, ...licenseWithoutHash } = license;
    return {
      license: licenseWithoutHash,
      licenseKey,
    };
  }

  /**
   * Validate a license key.
   * Checks: exists, not revoked, not expired, not exhausted, correct product.
   */
  async validateLicense(input: ValidateLicenseInput): Promise<ValidateLicenseResult> {
    const normalizedKey = normalizeLicenseKey(input.licenseKey);
    const keyHash = await hashLicenseKey(normalizedKey);

    // Find license by hash
    const license = await this.storage.findByKeyHash(keyHash);

    if (!license) {
      return { valid: false, reason: 'not_found' };
    }

    // Check product match
    if (license.productId !== input.productId) {
      return { valid: false, reason: 'wrong_product' };
    }

    // Check tenant match
    if (license.tenantId !== input.tenantId) {
      return { valid: false, reason: 'not_found' };
    }

    // Check status
    if (license.status === 'revoked') {
      return { valid: false, reason: 'revoked', license: this.stripHash(license) };
    }

    // Check expiry
    if (isExpired(license.expiresAt)) {
      // Auto-update status to expired
      await this.storage.updateStatus(license._id, 'expired');
      return { valid: false, reason: 'expired', license: this.stripHash(license) };
    }

    // Check usage limit
    if (license.maxUses !== undefined && license.currentUses >= license.maxUses) {
      // Auto-update status to exhausted
      await this.storage.updateStatus(license._id, 'exhausted');
      return { valid: false, reason: 'exhausted', license: this.stripHash(license) };
    }

    return { valid: true, license: this.stripHash(license) };
  }

  /**
   * Use a license (increment usage count).
   * Returns updated license state.
   */
  async useLicense(input: UseLicenseInput): Promise<UseLicenseResult> {
    // First validate
    const validation = await this.validateLicense(input);

    if (!validation.valid) {
      return {
        success: false,
        reason: validation.reason,
      };
    }

    // Increment usage
    const license = await this.storage.incrementUsage(validation.license!._id);

    // Check if now exhausted
    if (license.maxUses !== undefined && license.currentUses >= license.maxUses) {
      await this.storage.updateStatus(license._id, 'exhausted');
      license.status = 'exhausted';
    }

    return {
      success: true,
      license: this.stripHash(license),
    };
  }

  /**
   * Revoke a license manually.
   */
  async revokeLicense(input: RevokeLicenseInput): Promise<ManualLicense> {
    const license = await this.storage.findById(input.licenseId);

    if (!license) {
      throw new Error('License not found');
    }

    // Verify tenant ownership
    if (license.tenantId !== input.tenantId) {
      throw new Error('License not found');
    }

    // Update status to revoked
    const updated = await this.storage.updateStatus(
      license._id,
      'revoked',
      input.reason
    );

    return updated;
  }

  /**
   * Bulk import licenses for a product.
   * Generates keys for entries without custom keys.
   */
  async bulkImport(input: BulkImportInput): Promise<BulkImportResult> {
    const result: BulkImportResult = {
      created: 0,
      failed: 0,
      licenses: [],
      errors: [],
    };

    const licensesToCreate: Array<{
      licenseKeyHash: string;
      licenseKey: string; // Keep plaintext for result
      tenantId: string;
      productId: string;
      maxUses?: number;
      expiresAt?: number;
      notes?: string;
      buyerEmail?: string;
    }> = [];

    // Process each license entry
    for (let i = 0; i < input.licenses.length; i++) {
      const entry = input.licenses[i];

      try {
        // Generate or normalize key
        const rawKey = entry.licenseKey ?? generateLicenseKey();
        const licenseKey = normalizeLicenseKey(rawKey);
        const licenseKeyHash = await hashLicenseKey(licenseKey);

        // Check for duplicates in batch
        const duplicateInBatch = licensesToCreate.some(
          (l) => l.licenseKeyHash === licenseKeyHash
        );
        if (duplicateInBatch) {
          throw new Error('Duplicate license key in import batch');
        }

        // Check for existing in database
        const existing = await this.storage.findByKeyHash(licenseKeyHash);
        if (existing) {
          throw new Error('License key already exists');
        }

        licensesToCreate.push({
          licenseKeyHash,
          licenseKey, // Store plaintext for result
          tenantId: input.tenantId,
          productId: input.productId,
          maxUses: entry.maxUses ?? input.defaultMaxUses,
          expiresAt: entry.expiresAt ?? input.defaultExpiresAt,
          notes: entry.notes,
          buyerEmail: entry.buyerEmail,
        });
      } catch (error) {
        result.failed++;
        result.errors.push({
          index: i,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    // Bulk create licenses
    if (licensesToCreate.length > 0) {
      try {
        const created = await this.storage.bulkCreate(licensesToCreate);

        // Generate result with plaintext keys
        // We stored the plaintext keys in licensesToCreate
        for (let i = 0; i < created.length; i++) {
          result.licenses.push({
            license: this.stripHash(created[i]),
            licenseKey: licensesToCreate[i].licenseKey,
          });
          result.created++;
        }
      } catch (error) {
        // If bulk create fails, mark all as failed
        for (let i = 0; i < licensesToCreate.length; i++) {
          result.failed++;
          result.errors.push({
            index: i,
            error: error instanceof Error ? error.message : 'Bulk create failed',
          });
        }
      }
    }

    return result;
  }

  /**
   * List licenses for a tenant/product.
   */
  async listLicenses(tenantId: string, productId?: string): Promise<Array<Omit<ManualLicense, 'licenseKeyHash'>>> {
    const licenses = await this.storage.list(tenantId, productId);
    return licenses.map((l) => this.stripHash(l));
  }

  /**
   * Strip the license key hash from a license record for safe return.
   */
  private stripHash(license: ManualLicense): Omit<ManualLicense, 'licenseKeyHash'> {
    const { licenseKeyHash: _, ...rest } = license;
    return rest;
  }
}

// Re-export types
export * from './types';
