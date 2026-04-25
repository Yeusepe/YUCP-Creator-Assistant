export interface BackfillRecord {
  authUserId: string;
  provider: string;
  externalOrderId: string;
  externalLineItemId?: string;
  buyerEmailHash?: string;
  buyerEmailEncrypted?: string;
  providerUserId?: string;
  providerProductId: string;
  externalVariantId?: string;
  /** @deprecated Prefer externalVariantId for generic tier identity. */
  providerProductVersionId?: string;
  paymentStatus: string;
  lifecycleStatus: 'active' | 'refunded' | 'cancelled' | 'disputed';
  purchasedAt: number;
}

export interface BackfillPage {
  readonly facts: BackfillRecord[];
  readonly nextCursor: string | null;
}

export interface BackfillProviderCapability {
  readonly pageDelayMs: number;
  getCredential(authUserId: string): Promise<string | null>;
  fetchPage(
    credential: string,
    providerProductRef: string,
    cursor: string | null,
    pageSize: number
  ): Promise<BackfillPage>;
}

export interface BackfillProviderPort {
  getProvider(provider: string): BackfillProviderCapability | undefined;
}

export interface BackfillIngestionPort {
  ingestBatch(input: {
    authUserId: string;
    provider: string;
    purchases: BackfillRecord[];
  }): Promise<{ inserted: number; skipped: number }>;
}

export interface BackfillDelayPort {
  sleep(waitMs: number): Promise<void>;
}
