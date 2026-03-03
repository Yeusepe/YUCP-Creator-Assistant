/**
 * Types for manual license management.
 */

/** Status of a manual license */
export type ManualLicenseStatus = 'active' | 'revoked' | 'expired' | 'exhausted';

/** A manual license record (as stored in database) */
export interface ManualLicense {
  /** Unique identifier */
  _id: string;
  /** Tenant scope */
  tenantId: string;
  /** SHA-256 hash of the license key (never store plaintext) */
  licenseKeyHash: string;
  /** Product this license is for */
  productId: string;
  /** Optional catalog product reference */
  catalogProductId?: string;
  /** Maximum number of uses (null = unlimited) */
  maxUses?: number;
  /** Current usage count */
  currentUses: number;
  /** Current status */
  status: ManualLicenseStatus;
  /** Optional expiration timestamp (Unix ms) */
  expiresAt?: number;
  /** Optional notes from creator */
  notes?: string;
  /** Optional buyer email for record keeping */
  buyerEmail?: string;
  /** Creation timestamp (Unix ms) */
  createdAt: number;
  /** Last update timestamp (Unix ms) */
  updatedAt: number;
}

/** Input for creating a new manual license */
export interface CreateLicenseInput {
  /** Tenant scope */
  tenantId: string;
  /** Product this license is for */
  productId: string;
  /** Optional catalog product reference */
  catalogProductId?: string;
  /** Maximum number of uses (null = unlimited) */
  maxUses?: number;
  /** Optional expiration timestamp (Unix ms) */
  expiresAt?: number;
  /** Optional notes from creator */
  notes?: string;
  /** Optional buyer email for record keeping */
  buyerEmail?: string;
  /** Optional custom license key (if not provided, one will be generated) */
  licenseKey?: string;
}

/** Result of license creation (includes the plaintext key for one-time display) */
export interface CreateLicenseResult {
  /** The created license record */
  license: Omit<ManualLicense, 'licenseKeyHash'>;
  /** The plaintext license key (only shown once) */
  licenseKey: string;
}

/** Input for validating a license key */
export interface ValidateLicenseInput {
  /** The plaintext license key to validate */
  licenseKey: string;
  /** Product to validate against */
  productId: string;
  /** Tenant scope */
  tenantId: string;
}

/** Result of license validation */
export interface ValidateLicenseResult {
  /** Whether the license is valid */
  valid: boolean;
  /** The license record if found */
  license?: Omit<ManualLicense, 'licenseKeyHash'>;
  /** Reason for invalidity if not valid */
  reason?: 'not_found' | 'expired' | 'revoked' | 'exhausted' | 'wrong_product';
}

/** Input for using a license (incrementing usage count) */
export interface UseLicenseInput {
  /** The plaintext license key */
  licenseKey: string;
  /** Product to use against */
  productId: string;
  /** Tenant scope */
  tenantId: string;
}

/** Result of license usage */
export interface UseLicenseResult {
  /** Whether the usage was successful */
  success: boolean;
  /** The updated license record */
  license?: Omit<ManualLicense, 'licenseKeyHash'>;
  /** Reason for failure if not successful */
  reason?: string;
}

/** Input for revoking a license */
export interface RevokeLicenseInput {
  /** The license ID to revoke */
  licenseId: string;
  /** Tenant scope (for authorization) */
  tenantId: string;
  /** Optional reason for revocation */
  reason?: string;
}

/** Input for bulk importing licenses */
export interface BulkImportInput {
  /** Tenant scope */
  tenantId: string;
  /** Product to create licenses for */
  productId: string;
  /** Licenses to import */
  licenses: Array<{
    /** Optional custom license key */
    licenseKey?: string;
    /** Maximum uses (null = unlimited) */
    maxUses?: number;
    /** Expiration timestamp */
    expiresAt?: number;
    /** Notes */
    notes?: string;
    /** Buyer email */
    buyerEmail?: string;
  }>;
  /** Default max uses if not specified per-license */
  defaultMaxUses?: number;
  /** Default expiration if not specified per-license */
  defaultExpiresAt?: number;
}

/** Result of bulk import */
export interface BulkImportResult {
  /** Number of licenses successfully created */
  created: number;
  /** Number of licenses that failed */
  failed: number;
  /** Created licenses with their keys */
  licenses: Array<{
    license: Omit<ManualLicense, 'licenseKeyHash'>;
    licenseKey: string;
  }>;
  /** Errors encountered */
  errors: Array<{
    index: number;
    error: string;
  }>;
}

/** License generation options */
export interface GenerateKeyOptions {
  /** Prefix for the license key (default: 'YUCP') */
  prefix?: string;
  /** Number of segments (default: 4) */
  segments?: number;
  /** Characters per segment (default: 4) */
  segmentLength?: number;
}

/** Storage interface for manual licenses (to be implemented by Convex) */
export interface ManualLicenseStorage {
  /** Create a new license */
  create(input: Omit<CreateLicenseInput, 'licenseKey'> & { licenseKeyHash: string }): Promise<ManualLicense>;
  /** Find license by key hash */
  findByKeyHash(licenseKeyHash: string): Promise<ManualLicense | null>;
  /** Find license by ID */
  findById(licenseId: string): Promise<ManualLicense | null>;
  /** Update license usage count */
  incrementUsage(licenseId: string): Promise<ManualLicense>;
  /** Update license status */
  updateStatus(licenseId: string, status: ManualLicenseStatus, reason?: string): Promise<ManualLicense>;
  /** List licenses for a tenant/product */
  list(tenantId: string, productId?: string): Promise<ManualLicense[]>;
  /** Bulk create licenses */
  bulkCreate(licenses: Array<Omit<CreateLicenseInput, 'licenseKey'> & { licenseKeyHash: string }>): Promise<ManualLicense[]>;
}
