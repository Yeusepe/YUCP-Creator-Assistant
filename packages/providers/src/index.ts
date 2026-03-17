// Provider adapters for Gumroad, Jinxxy, Discord, and manual licenses

import type { Verification } from '@yucp/shared';
import { ManualLicenseManager } from './manual/manager';
import type { ManualLicenseStorage } from './manual/types';

export interface PurchaseRecord {
  buyerEmail?: string;
  buyerDiscordId?: string;
  productId: string;
  purchaseDate: Date;
  licenseKey?: string;
}

export interface ProviderConfig {
  apiKey?: string;
  apiToken?: string;
  secretKey?: string;
  webhookSecret?: string;
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
}

export interface ProviderAdapter {
  readonly name: string;
  verifyPurchase(emailOrId: string): Promise<Verification | null>;
  getRecentPurchases(limit?: number): Promise<PurchaseRecord[]>;
}

/** Extended adapter interface for manual licenses with full license management */
export interface ManualProviderAdapter extends ProviderAdapter {
  /** Generate a new license key */
  generateLicense(
    input: import('./manual/types').CreateLicenseInput
  ): Promise<import('./manual/types').CreateLicenseResult>;
  /** Validate a license key */
  validateLicense(
    input: import('./manual/types').ValidateLicenseInput
  ): Promise<import('./manual/types').ValidateLicenseResult>;
  /** Use a license (increment usage count) */
  useLicense(
    input: import('./manual/types').UseLicenseInput
  ): Promise<import('./manual/types').UseLicenseResult>;
  /** Revoke a license */
  revokeLicense(
    input: import('./manual/types').RevokeLicenseInput
  ): Promise<import('./manual/types').ManualLicense>;
  /** Bulk import licenses */
  bulkImport(
    input: import('./manual/types').BulkImportInput
  ): Promise<import('./manual/types').BulkImportResult>;
  /** List licenses for a creator/product */
  listLicenses(
    authUserId: string,
    productId?: string
  ): Promise<Array<Omit<import('./manual/types').ManualLicense, 'licenseKeyHash'>>>;
}

// Re-export Gumroad adapter (full implementation in ./gumroad)
import { GumroadAdapter } from './gumroad';

export { GumroadAdapter, resolveGumroadProduct, resolveGumroadProductId } from './gumroad';

import type { GumroadAdapterConfig } from './gumroad/types';

export type {
  AuthorizationUrlResult,
  EncryptionService,
  GumroadAdapterConfig,
  GumroadProduct,
  GumroadPurchaseEvidence,
  GumroadSale,
  OAuthCompletionResult,
  StateStorage,
  TokenStorage,
} from './gumroad';

// Re-export Jinxxy adapter (full implementation in ./jinxxy)
import { JinxxyAdapter, type JinxxyAdapterConfig } from './jinxxy';

export { JinxxyAdapter, JinxxyApiClient } from './jinxxy';

// Re-export Payhip adapter (full implementation in ./payhip)
import { PayhipAdapter } from './payhip';

export type {
  PayhipAdapterConfig,
  PayhipEvidence,
  PayhipLicenseVerifyData,
  PayhipLicenseVerifyResponse,
  PayhipLicenseVerifyResult,
  PayhipPaidPayload,
  PayhipProductKey,
  PayhipRefundedPayload,
  PayhipWebhookItem,
  PayhipWebhookPayload,
} from './payhip';
export { PayhipAdapter, PayhipApiClient, PayhipApiError, PayhipRateLimitError } from './payhip';

import { LemonSqueezyAdapter, type LemonSqueezyAdapterConfig } from './lemonsqueezy';

export type {
  JinxxyAdapterConfig,
  JinxxyApiError,
  JinxxyCustomer,
  JinxxyEvidence,
  JinxxyLicense,
  JinxxyOrder,
  JinxxyPagination,
  JinxxyProduct,
  JinxxyRateLimitError,
  LicenseVerificationResult,
  PurchaseVerificationResult,
} from './jinxxy';
export type {
  LemonSqueezyAdapterConfig,
  LemonSqueezyEvidence,
  LemonSqueezyLicenseKey,
  LemonSqueezyLicenseValidationResult,
  LemonSqueezyOrder,
  LemonSqueezyStore,
  LemonSqueezySubscription,
  LemonSqueezyVariant,
  LemonSqueezyWebhook,
  LemonSqueezyWebhookCreateInput,
} from './lemonsqueezy';
export {
  LemonSqueezyAdapter,
  LemonSqueezyApiClient,
  LemonSqueezyApiError,
  LemonSqueezyRateLimitError,
} from './lemonsqueezy';
export type {
  RequiresTwoFactorAuth,
  TwoFactorAuthType,
  VrchatCurrentUser,
  VrchatLicensedAvatar,
  VrchatVerifyOwnershipResult,
} from './vrchat';
export { extractVrchatAvatarId, VrchatApiClient } from './vrchat';

// Discord provider adapter (placeholder)
export class DiscordAdapter implements ProviderAdapter {
  readonly name = 'discord';

  async verifyPurchase(_discordId: string): Promise<Verification | null> {
    // Placeholder - Discord verification via OAuth/bot
    return null;
  }

  async getRecentPurchases(_limit?: number): Promise<PurchaseRecord[]> {
    // Placeholder
    return [];
  }
}

// Manual license provider adapter
export class ManualAdapter implements ProviderAdapter {
  readonly name = 'manual';

  private manager: ManualLicenseManager | null = null;

  constructor(_config: ProviderConfig, storage?: ManualLicenseStorage) {
    if (storage) {
      this.manager = new ManualLicenseManager(storage);
    }
  }

  /**
   * Set the storage backend for license management.
   * Must be called before using license management features.
   */
  setStorage(storage: ManualLicenseStorage): void {
    this.manager = new ManualLicenseManager(storage);
  }

  /**
   * Get the license manager (throws if not configured)
   */
  private getManager(): ManualLicenseManager {
    if (!this.manager) {
      throw new Error('ManualAdapter storage not configured. Call setStorage() first.');
    }
    return this.manager;
  }

  /**
   * Verify a purchase by validating the license key.
   * @param licenseKey - The plaintext license key to verify
   * @param context - Context containing productId and authUserId
   */
  async verifyPurchase(
    licenseKey: string,
    context?: { productId: string; authUserId: string }
  ): Promise<Verification | null> {
    if (!context || !this.manager) {
      // Fallback for basic interface - cannot validate without context
      return null;
    }

    const result = await this.manager.validateLicense({
      licenseKey,
      productId: context.productId,
      authUserId: context.authUserId,
    });

    if (!result.valid || !result.license) {
      return null;
    }

    // Convert to Verification format
    return {
      id: result.license._id,
      userId: '', // Not applicable for manual licenses
      provider: 'manual',
      status: 'verified',
      createdAt: new Date(result.license.createdAt),
    };
  }

  /**
   * Generate a new license key.
   */
  async generateLicense(
    input: import('./manual/types').CreateLicenseInput
  ): Promise<import('./manual/types').CreateLicenseResult> {
    return this.getManager().generateLicense(input);
  }

  /**
   * Validate a license key.
   */
  async validateLicense(
    input: import('./manual/types').ValidateLicenseInput
  ): Promise<import('./manual/types').ValidateLicenseResult> {
    return this.getManager().validateLicense(input);
  }

  /**
   * Use a license (increment usage count).
   */
  async useLicense(
    input: import('./manual/types').UseLicenseInput
  ): Promise<import('./manual/types').UseLicenseResult> {
    return this.getManager().useLicense(input);
  }

  /**
   * Revoke a license.
   */
  async revokeLicense(
    input: import('./manual/types').RevokeLicenseInput
  ): Promise<import('./manual/types').ManualLicense> {
    return this.getManager().revokeLicense(input);
  }

  /**
   * Bulk import licenses.
   */
  async bulkImport(
    input: import('./manual/types').BulkImportInput
  ): Promise<import('./manual/types').BulkImportResult> {
    return this.getManager().bulkImport(input);
  }

  /**
   * List licenses for a creator/product.
   */
  async listLicenses(
    authUserId: string,
    productId?: string
  ): Promise<Array<Omit<import('./manual/types').ManualLicense, 'licenseKeyHash'>>> {
    return this.getManager().listLicenses(authUserId, productId);
  }

  async getRecentPurchases(_limit?: number): Promise<PurchaseRecord[]> {
    // Manual licenses don't have "purchases" in the traditional sense
    return [];
  }
}

// Factory function for creating provider adapters
export function createProviderAdapter(
  type: 'gumroad' | 'jinxxy' | 'lemonsqueezy' | 'payhip' | 'discord' | 'manual',
  config: ProviderConfig,
  storage?: ManualLicenseStorage
): ProviderAdapter {
  switch (type) {
    case 'gumroad': {
      const c = config as Record<string, unknown>;
      if (typeof c.clientId === 'string' && typeof c.clientSecret === 'string') {
        return new GumroadAdapter({
          ...config,
          clientId: c.clientId,
          clientSecret: c.clientSecret,
          redirectUri: typeof c.redirectUri === 'string' ? c.redirectUri : '',
        } as ProviderConfig & GumroadAdapterConfig);
      }
      throw new Error(
        'Gumroad adapter requires clientId and clientSecret in config. Provide full GumroadAdapterConfig.'
      );
    }
    case 'jinxxy':
      if (!config.apiKey) {
        throw new Error('Use JinxxyAdapter directly with apiKey config');
      }
      return new JinxxyAdapter(config as unknown as JinxxyAdapterConfig);
    case 'lemonsqueezy':
      if (!config.apiToken) {
        throw new Error('Use LemonSqueezyAdapter directly with apiToken config');
      }
      return new LemonSqueezyAdapter(config as unknown as LemonSqueezyAdapterConfig);
    case 'payhip':
      return new PayhipAdapter(config);
    case 'discord':
      return new DiscordAdapter();
    case 'manual':
      return new ManualAdapter(config, storage);
    default:
      throw new Error(`Unknown provider type: ${type}`);
  }
}

/**
 * Create a manual provider adapter with full license management capabilities.
 */
export function createManualAdapter(
  config: ProviderConfig,
  storage: ManualLicenseStorage
): ManualProviderAdapter {
  return new ManualAdapter(config, storage) as ManualProviderAdapter;
}

export type { LicenseFormat } from './core/licenseFormat';
// License format detection
export { detectLicenseFormat } from './core/licenseFormat';
export type { ProviderMeta } from './core/meta';
// Provider metadata
export { LICENSE_PROVIDERS, PROVIDER_META, providerLabel } from './core/meta';
export * from './core/orchestrator';
// Provider registry and orchestration layer
export * from './core/registry';
// Discord OAuth provider for buyer verification
export * from './discord';
// Manual license management module
export * from './manual';
