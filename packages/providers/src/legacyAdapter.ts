import type { Verification } from '@yucp/shared';

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
