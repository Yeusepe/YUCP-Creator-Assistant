/**
 * Tests for Manual License Adapter
 */

import { beforeEach, describe, expect, it } from 'bun:test';
import {
  ManualLicenseManager,
  generateLicenseKey,
  hashLicenseKey,
  normalizeLicenseKey,
} from '../src/manual/manager';
import type {
  BulkImportInput,
  CreateLicenseInput,
  ManualLicense,
  ManualLicenseStorage,
  RevokeLicenseInput,
  UseLicenseInput,
  ValidateLicenseInput,
} from '../src/manual/types';

// In-memory storage implementation for testing
class InMemoryStorage implements ManualLicenseStorage {
  private licenses: Map<string, ManualLicense> = new Map();
  private idCounter = 0;

  async create(
    input: Omit<CreateLicenseInput, 'licenseKey'> & { licenseKeyHash: string }
  ): Promise<ManualLicense> {
    const id = `license-${++this.idCounter}`;
    const now = Date.now();
    const license: ManualLicense = {
      _id: id,
      tenantId: input.tenantId,
      licenseKeyHash: input.licenseKeyHash,
      productId: input.productId,
      catalogProductId: input.catalogProductId,
      maxUses: input.maxUses,
      currentUses: 0,
      status: 'active',
      expiresAt: input.expiresAt,
      notes: input.notes,
      buyerEmail: input.buyerEmail,
      createdAt: now,
      updatedAt: now,
    };
    this.licenses.set(id, license);
    return license;
  }

  async findByKeyHash(licenseKeyHash: string): Promise<ManualLicense | null> {
    for (const license of this.licenses.values()) {
      if (license.licenseKeyHash === licenseKeyHash) {
        return license;
      }
    }
    return null;
  }

  async findById(licenseId: string): Promise<ManualLicense | null> {
    return this.licenses.get(licenseId) ?? null;
  }

  async incrementUsage(licenseId: string): Promise<ManualLicense> {
    const license = this.licenses.get(licenseId);
    if (!license) {
      throw new Error('License not found');
    }
    license.currentUses++;
    license.updatedAt = Date.now();
    this.licenses.set(licenseId, license);
    return license;
  }

  async updateStatus(
    licenseId: string,
    status: ManualLicense['status'],
    reason?: string
  ): Promise<ManualLicense> {
    const license = this.licenses.get(licenseId);
    if (!license) {
      throw new Error('License not found');
    }
    license.status = status;
    if (reason) {
      license.notes = reason;
    }
    license.updatedAt = Date.now();
    this.licenses.set(licenseId, license);
    return license;
  }

  async list(tenantId: string, productId?: string): Promise<ManualLicense[]> {
    return Array.from(this.licenses.values()).filter((l) => {
      if (productId && l.productId !== productId) return false;
      return l.tenantId === tenantId;
    });
  }

  async bulkCreate(
    licenses: Array<Omit<CreateLicenseInput, 'licenseKey'> & { licenseKeyHash: string }>
  ): Promise<ManualLicense[]> {
    const results: ManualLicense[] = [];
    for (const input of licenses) {
      const license = await this.create({ ...input, licenseKeyHash: input.licenseKeyHash });
      results.push(license);
    }
    return results;
  }
}

describe('generateLicenseKey', () => {
  it('should generate keys in the default format', () => {
    const key = generateLicenseKey();
    // Default: 4 segments, 4 chars each: YUCP-XXXX-XXXX-XXXX-XXXX
    expect(key).toMatch(/^YUCP-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(key.split('-').length).toBe(5);
  });

  it('should generate keys with custom prefix', () => {
    const key = generateLicenseKey({ prefix: 'CUSTOM' });
    expect(key).toMatch(/^CUSTOM-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  });

  it('should generate keys with custom segments', () => {
    const key = generateLicenseKey({ segments: 3, segmentLength: 6 });
    expect(key).toMatch(/^YUCP-[A-Z0-9]{6}-[A-Z0-9]{6}-[A-Z0-9]{6}$/);
  });

  it('should generate unique keys each time', () => {
    const keys = new Set<string>();
    for (let i = 0; i < 100; i++) {
      keys.add(generateLicenseKey());
    }
    expect(new Set(keys).size).toBe(100);
  });

  it('should normalize license keys', () => {
    expect(normalizeLicenseKey('  yucp-abcd-efgh-ijkl')).toBe('YUCP-ABCD-EFGH-IJKL');
    expect(normalizeLicenseKey('  YUCP-ABCD-EFGH-IJKL  ')).toBe('YUCP-ABCD-EFGH-IJKL');
    expect(normalizeLicenseKey('  yucp abcd efgh ijkl ')).toBe('YUCP-ABCD-EFGH-IJKL');
  });
});

describe('hashLicenseKey', () => {
  it('should produce consistent SHA-256 hashes', async () => {
    const key = 'YUCP-ABCD-EFGH-IJKL';
    const hash1 = await hashLicenseKey(key);
    const hash2 = await hashLicenseKey(key);
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64);
    expect(hash1).toMatch(/^[a-f0-9]{64}$/);
  });

  it('should produce different hashes for different keys', async () => {
    const key1 = 'YUCP-ABCD-EFGH-IJKL';
    const key2 = 'YUCP-AAAA-BBBB-CCCC';
    const hash1 = await hashLicenseKey(key1);
    const hash2 = await hashLicenseKey(key2);
    expect(hash1).not.toBe(hash2);
  });
});

describe('ManualLicenseManager', () => {
  let manager: ManualLicenseManager;
  let storage: InMemoryStorage;

  beforeEach(() => {
    storage = new InMemoryStorage();
    manager = new ManualLicenseManager(storage);
  });

  describe('generateLicense', () => {
    it('should generate a license with default options', async () => {
      const result = await manager.generateLicense({
        tenantId: 'tenant-123',
        productId: 'product-456',
      });

      expect(result.license).toBeDefined();
      expect(result.license.tenantId).toBe('tenant-123');
      expect(result.license.productId).toBe('product-456');
      expect(result.license.status).toBe('active');
      expect(result.licenseKey).toMatch(/^YUCP-/);
    });

    it('should generate license with custom key', async () => {
      const result = await manager.generateLicense({
        tenantId: 'tenant-123',
        productId: 'product-456',
        licenseKey: 'CUSTOM-KEY-123',
      });

      expect(result.license).toBeDefined();
      expect(result.licenseKey).toBe('CUSTOM-KEY-123');
    });

    it('should generate license with max uses', async () => {
      const result = await manager.generateLicense({
        tenantId: 'tenant-123',
        productId: 'product-456',
        maxUses: 5,
      });

      expect(result.license.maxUses).toBe(5);
      expect(result.license.currentUses).toBe(0);
    });

    it('should generate license with expiry', async () => {
      const futureExpiry = Date.now() + 365 * 24 * 60 * 60 * 1000; // 1 year
      const result = await manager.generateLicense({
        tenantId: 'tenant-123',
        productId: 'product-456',
        expiresAt: futureExpiry,
      });

      expect(result.license.expiresAt).toBe(futureExpiry);
    });

    it('should reject duplicate license keys', async () => {
      await manager.generateLicense({
        tenantId: 'tenant-123',
        productId: 'product-456',
        licenseKey: 'EXISTING-KEY',
      });

      await expect(
        manager.generateLicense({
          tenantId: 'tenant-123',
          productId: 'product-456',
          licenseKey: 'EXISTING-KEY',
        })
      ).rejects.toThrow('already exists');
    });

    it('should generate license with notes and buyer email', async () => {
      const result = await manager.generateLicense({
        tenantId: 'tenant-123',
        productId: 'product-456',
        notes: 'Test license',
        buyerEmail: 'buyer@example.com',
      });

      expect(result.license.notes).toBe('Test license');
      expect(result.license.buyerEmail).toBe('buyer@example.com');
    });
  });

  describe('validateLicense', () => {
    it('should validate an active license', async () => {
      const created = await manager.generateLicense({
        tenantId: 'tenant-123',
        productId: 'product-456',
      });

      const result = await manager.validateLicense({
        licenseKey: created.licenseKey,
        productId: 'product-456',
        tenantId: 'tenant-123',
      });

      expect(result.valid).toBe(true);
      expect(result.license).toBeDefined();
      expect(result.license?._id).toBe(created.license._id);
    });

    it('should reject invalid license key', async () => {
      const result = await manager.validateLicense({
        licenseKey: 'INVALID-KEY',
        productId: 'product-456',
        tenantId: 'tenant-123',
      });

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('not_found');
    });

    it('should reject license for wrong product', async () => {
      const created = await manager.generateLicense({
        tenantId: 'tenant-123',
        productId: 'product-456',
      });

      const result = await manager.validateLicense({
        licenseKey: created.licenseKey,
        productId: 'wrong-product',
        tenantId: 'tenant-123',
      });

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('wrong_product');
    });

    it('should reject license for wrong tenant', async () => {
      const created = await manager.generateLicense({
        tenantId: 'tenant-123',
        productId: 'product-456',
      });

      const result = await manager.validateLicense({
        licenseKey: created.licenseKey,
        productId: 'product-456',
        tenantId: 'wrong-tenant',
      });

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('not_found');
    });

    it('should reject expired license', async () => {
      const pastExpiry = Date.now() - 1000; // 1 second ago
      const created = await manager.generateLicense({
        tenantId: 'tenant-123',
        productId: 'product-456',
        expiresAt: pastExpiry,
      });

      const result = await manager.validateLicense({
        licenseKey: created.licenseKey,
        productId: 'product-456',
        tenantId: 'tenant-123',
      });

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('expired');
    });

    it('should reject revoked license', async () => {
      const created = await manager.generateLicense({
        tenantId: 'tenant-123',
        productId: 'product-456',
      });

      await manager.revokeLicense({
        licenseId: created.license._id,
        tenantId: 'tenant-123',
        reason: 'Test revocation',
      });

      const result = await manager.validateLicense({
        licenseKey: created.licenseKey,
        productId: 'product-456',
        tenantId: 'tenant-123',
      });

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('revoked');
    });

    it('should reject exhausted license', async () => {
      const created = await manager.generateLicense({
        tenantId: 'tenant-123',
        productId: 'product-456',
        maxUses: 1,
      });

      // First use should succeed
      const firstUse = await manager.useLicense({
        licenseKey: created.licenseKey,
        productId: 'product-456',
        tenantId: 'tenant-123',
      });
      expect(firstUse.success).toBe(true);

      // Second validation should show exhausted
      const result = await manager.validateLicense({
        licenseKey: created.licenseKey,
        productId: 'product-456',
        tenantId: 'tenant-123',
      });
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('exhausted');
    });
  });

  describe('useLicense', () => {
    it('should increment usage count', async () => {
      const created = await manager.generateLicense({
        tenantId: 'tenant-123',
        productId: 'product-456',
        maxUses: 5,
      });

      const result = await manager.useLicense({
        licenseKey: created.licenseKey,
        productId: 'product-456',
        tenantId: 'tenant-123',
      });

      expect(result.success).toBe(true);
      expect(result.license?.currentUses).toBe(1);
    });

    it('should track multiple uses', async () => {
      const created = await manager.generateLicense({
        tenantId: 'tenant-123',
        productId: 'product-456',
        maxUses: 5,
      });

      for (let i = 0; i < 3; i++) {
        const result = await manager.useLicense({
          licenseKey: created.licenseKey,
          productId: 'product-456',
          tenantId: 'tenant-123',
        });
        expect(result.success).toBe(true);
        expect(result.license?.currentUses).toBe(i + 1);
      }
    });

    it('should fail when license exhausted', async () => {
      const created = await manager.generateLicense({
        tenantId: 'tenant-123',
        productId: 'product-456',
        maxUses: 1,
      });

      // First use
      await manager.useLicense({
        licenseKey: created.licenseKey,
        productId: 'product-456',
        tenantId: 'tenant-123',
      });

      // Second use should fail
      const result = await manager.useLicense({
        licenseKey: created.licenseKey,
        productId: 'product-456',
        tenantId: 'tenant-123',
      });
      expect(result.success).toBe(false);
      expect(result.reason).toBe('exhausted');
    });

    it('should allow unlimited uses when maxUses is undefined', async () => {
      const created = await manager.generateLicense({
        tenantId: 'tenant-123',
        productId: 'product-456',
        // No maxUses = unlimited
      });

      for (let i = 0; i < 10; i++) {
        const result = await manager.useLicense({
          licenseKey: created.licenseKey,
          productId: 'product-456',
          tenantId: 'tenant-123',
        });
        expect(result.success).toBe(true);
      }
    });
  });

  describe('revokeLicense', () => {
    it('should revoke an active license', async () => {
      const created = await manager.generateLicense({
        tenantId: 'tenant-123',
        productId: 'product-456',
      });

      const revoked = await manager.revokeLicense({
        licenseId: created.license._id,
        tenantId: 'tenant-123',
        reason: 'Test revocation',
      });

      expect(revoked.status).toBe('revoked');
      expect(revoked.notes).toContain('Test revocation');
    });

    it('should reject revocation for wrong tenant', async () => {
      const created = await manager.generateLicense({
        tenantId: 'tenant-123',
        productId: 'product-456',
      });

      await expect(
        manager.revokeLicense({
          licenseId: created.license._id,
          tenantId: 'wrong-tenant',
        })
      ).rejects.toThrow('not found');
    });

    it('should reject revocation for non-existent license', async () => {
      await expect(
        manager.revokeLicense({
          licenseId: 'non-existent',
          tenantId: 'tenant-123',
        })
      ).rejects.toThrow('not found');
    });
  });

  describe('bulkImport', () => {
    it('should import multiple licenses', async () => {
      const result = await manager.bulkImport({
        tenantId: 'tenant-123',
        productId: 'product-456',
        licenses: [{}, {}, {}],
        defaultMaxUses: 1,
      });

      expect(result.created).toBe(3);
      expect(result.failed).toBe(0);
      expect(result.licenses).toHaveLength(3);
      expect(result.errors).toHaveLength(0);
    });

    it('should import licenses with custom keys', async () => {
      const result = await manager.bulkImport({
        tenantId: 'tenant-123',
        productId: 'product-456',
        licenses: [{ licenseKey: 'CUSTOM-1' }, { licenseKey: 'CUSTOM-2' }],
      });

      expect(result.created).toBe(2);
      expect(result.licenses[0].licenseKey).toBe('CUSTOM-1');
      expect(result.licenses[1].licenseKey).toBe('CUSTOM-2');
    });

    it('should reject duplicate keys in batch', async () => {
      const result = await manager.bulkImport({
        tenantId: 'tenant-123',
        productId: 'product-456',
        licenses: [{ licenseKey: 'DUPLICATE' }, { licenseKey: 'DUPLICATE' }],
      });

      expect(result.created).toBe(1);
      expect(result.failed).toBe(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].error).toContain('Duplicate');
    });

    it('should import licenses with per-license settings', async () => {
      const result = await manager.bulkImport({
        tenantId: 'tenant-123',
        productId: 'product-456',
        licenses: [
          { maxUses: 1, notes: 'Single use' },
          { maxUses: 10, notes: 'Multi use' },
        ],
      });

      expect(result.created).toBe(2);
      expect(result.licenses[0].license.maxUses).toBe(1);
      expect(result.licenses[0].license.notes).toBe('Single use');
      expect(result.licenses[1].license.maxUses).toBe(10);
      expect(result.licenses[1].license.notes).toBe('Multi use');
    });
  });

  describe('listLicenses', () => {
    it('should list licenses for tenant', async () => {
      await manager.generateLicense({
        tenantId: 'tenant-123',
        productId: 'product-456',
      });
      await manager.generateLicense({
        tenantId: 'tenant-123',
        productId: 'product-789',
      });

      const licenses = await manager.listLicenses('tenant-123');
      expect(licenses).toHaveLength(2);
    });

    it('should filter licenses by product', async () => {
      await manager.generateLicense({
        tenantId: 'tenant-123',
        productId: 'product-456',
      });
      await manager.generateLicense({
        tenantId: 'tenant-123',
        productId: 'product-789',
      });

      const licenses = await manager.listLicenses('tenant-123', 'product-456');
      expect(licenses).toHaveLength(1);
      expect(licenses[0].productId).toBe('product-456');
    });

    it('should not expose license key hashes', async () => {
      const created = await manager.generateLicense({
        tenantId: 'tenant-123',
        productId: 'product-456',
      });

      const licenses = await manager.listLicenses('tenant-123');
      const license = licenses.find((l) => l._id === created.license._id);
      expect(license).toBeDefined();
      expect(license).not.toHaveProperty('licenseKeyHash');
    });
  });
});
