/**
 * Manual License Provider Module
 *
 * This module provides functionality for managing manual license keys,
 * including:
 * - Secure key generation (YUCP-XXXX-XXXX-XXXX format)
 * - SHA-256 hashing (never stores plaintext)
 * - License validation with expiry checks
 * - Usage tracking (seat counting)
 * - Bulk import for creators (CSV/JSON support)
 * - Manual revoke
 *
 * @example
 * ```ts
 * import { ManualLicenseManager, generateLicenseKey, hashLicenseKey } from '@yucp/providers/manual';
 *
 * // Generate a license key
 * const key = generateLicenseKey(); // "YUCP-ABCD-EFGH-IJKL"
 *
 * // Hash it for storage
 * const hash = await hashLicenseKey(key);
 *
 * // Create manager with storage
 * const manager = new ManualLicenseManager(storage);
 *
 * // Generate and store a license
 * const result = await manager.generateLicense({
 *   authUserId: 'tenant-123',
 *   productId: 'product-456',
 *   maxUses: 5,
 *   expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000, // 1 year
 * });
 *
 * // Validate a license
 * const validation = await manager.validateLicense({
 *   licenseKey: 'YUCP-ABCD-EFGH-IJKL',
 *   productId: 'product-456',
 *   authUserId: 'tenant-123',
 * });
 *
 * // Use a license (increment usage)
 * const usage = await manager.useLicense({
 *   licenseKey: 'YUCP-ABCD-EFGH-IJKL',
 *   productId: 'product-456',
 *   authUserId: 'tenant-123',
 * });
 *
 * // Revoke a license
 * await manager.revokeLicense({
 *   licenseId: 'license-id',
 *   authUserId: 'tenant-123',
 *   reason: 'Refund issued',
 * });
 *
 * // Bulk import
 * const importResult = await manager.bulkImport({
 *   authUserId: 'tenant-123',
 *   productId: 'product-456',
 *   licenses: [
 *     { maxUses: 1 },
 *     { maxUses: 1 },
 *     { licenseKey: 'CUSTOM-KEY', maxUses: 10 },
 *   ],
 *   defaultMaxUses: 1,
 * });
 * ```
 */

// Core manager class
export {
  generateLicenseKey,
  hashLicenseKey,
  ManualLicenseManager,
  normalizeLicenseKey,
} from './manager';

// Types
export type {
  BulkImportInput,
  BulkImportResult,
  CreateLicenseInput,
  CreateLicenseResult,
  GenerateKeyOptions,
  ManualLicense,
  ManualLicenseStatus,
  ManualLicenseStorage,
  RevokeLicenseInput,
  UseLicenseInput,
  UseLicenseResult,
  ValidateLicenseInput,
  ValidateLicenseResult,
} from './types';

// CSV parsing utilities for bulk import
import type { BulkImportInput } from './types';

/**
 * Parse CSV content for bulk license import.
 * Expected columns: licenseKey (optional), maxUses (optional), expiresAt (optional), notes (optional), buyerEmail (optional)
 */
export function parseBulkImportCSV(
  csvContent: string,
  authUserId: string,
  productId: string,
  defaults?: {
    defaultMaxUses?: number;
    defaultExpiresAt?: number;
  }
): BulkImportInput {
  const lines = csvContent.trim().split('\n');
  if (lines.length < 2) {
    throw new Error('CSV must have a header row and at least one data row');
  }

  // Parse header
  const header = lines[0].split(',').map((h) => h.trim().toLowerCase());
  const keyIndex = header.indexOf('licensekey');
  const maxUsesIndex = header.indexOf('maxuses');
  const expiresAtIndex = header.indexOf('expiresat');
  const notesIndex = header.indexOf('notes');
  const emailIndex = header.indexOf('buyeremail');

  const licenses: BulkImportInput['licenses'] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const values = line.split(',').map((v) => v.trim());

    const entry: BulkImportInput['licenses'][number] = {};

    if (keyIndex >= 0 && values[keyIndex]) {
      entry.licenseKey = values[keyIndex];
    }

    if (maxUsesIndex >= 0 && values[maxUsesIndex]) {
      const parsed = Number.parseInt(values[maxUsesIndex], 10);
      if (!Number.isNaN(parsed)) {
        entry.maxUses = parsed;
      }
    }

    if (expiresAtIndex >= 0 && values[expiresAtIndex]) {
      // Support ISO date format or Unix timestamp
      const val = values[expiresAtIndex];
      const parsed = Number.parseInt(val, 10);
      if (!Number.isNaN(parsed)) {
        // If it looks like a Unix timestamp (seconds or ms)
        entry.expiresAt = parsed < 1e12 ? parsed * 1000 : parsed;
      } else {
        // Try parsing as ISO date
        const date = new Date(val);
        if (!Number.isNaN(date.getTime())) {
          entry.expiresAt = date.getTime();
        }
      }
    }

    if (notesIndex >= 0 && values[notesIndex]) {
      entry.notes = values[notesIndex];
    }

    if (emailIndex >= 0 && values[emailIndex]) {
      entry.buyerEmail = values[emailIndex];
    }

    licenses.push(entry);
  }

  return {
    authUserId,
    productId,
    licenses,
    defaultMaxUses: defaults?.defaultMaxUses,
    defaultExpiresAt: defaults?.defaultExpiresAt,
  };
}

/**
 * Parse JSON content for bulk license import.
 * Accepts an array of license objects.
 */
export function parseBulkImportJSON(
  jsonContent: string,
  authUserId: string,
  productId: string,
  defaults?: {
    defaultMaxUses?: number;
    defaultExpiresAt?: number;
  }
): BulkImportInput {
  const data = JSON.parse(jsonContent);

  if (!Array.isArray(data)) {
    throw new Error('JSON must be an array of license objects');
  }

  const licenses: BulkImportInput['licenses'] = data.map((item: Record<string, unknown>) => ({
    licenseKey: typeof item.licenseKey === 'string' ? item.licenseKey : undefined,
    maxUses: typeof item.maxUses === 'number' ? item.maxUses : undefined,
    expiresAt: typeof item.expiresAt === 'number' ? item.expiresAt : undefined,
    notes: typeof item.notes === 'string' ? item.notes : undefined,
    buyerEmail: typeof item.buyerEmail === 'string' ? item.buyerEmail : undefined,
  }));

  return {
    authUserId,
    productId,
    licenses,
    defaultMaxUses: defaults?.defaultMaxUses,
    defaultExpiresAt: defaults?.defaultExpiresAt,
  };
}
