import type {
  BackfillDelayPort,
  BackfillIngestionPort,
  BackfillProviderPort,
} from '../ports/backfill';

export interface BackfillProductInput {
  readonly authUserId: string;
  readonly provider: string;
  readonly providerProductRef: string;
  readonly pageSize: number;
}

export interface BackfillProductResult {
  readonly inserted: number;
  readonly skipped: number;
}

export class BackfillProviderNotSupportedError extends Error {
  constructor(public readonly provider: string) {
    super(`Provider "${provider}" does not support backfill`);
    this.name = 'BackfillProviderNotSupportedError';
  }
}

export class BackfillCredentialsNotFoundError extends Error {
  constructor(
    public readonly provider: string,
    public readonly authUserId: string
  ) {
    super(`${provider} credentials not found for user`);
    this.name = 'BackfillCredentialsNotFoundError';
  }
}

export interface BackfillServiceOptions {
  readonly providers: BackfillProviderPort;
  readonly ingestion: BackfillIngestionPort;
  readonly delay: BackfillDelayPort;
}

export class BackfillService {
  constructor(private readonly options: BackfillServiceOptions) {}

  async backfillProduct(input: BackfillProductInput): Promise<BackfillProductResult> {
    const provider = this.options.providers.getProvider(input.provider);
    if (!provider) {
      throw new BackfillProviderNotSupportedError(input.provider);
    }

    const credential = await provider.getCredential(input.authUserId);
    if (!credential) {
      throw new BackfillCredentialsNotFoundError(input.provider, input.authUserId);
    }

    let cursor: string | null = null;
    let inserted = 0;
    let skipped = 0;

    while (true) {
      const { facts, nextCursor } = await provider.fetchPage(
        credential,
        input.providerProductRef,
        cursor,
        input.pageSize
      );

      if (facts.length > 0) {
        const result = await this.options.ingestion.ingestBatch({
          authUserId: input.authUserId,
          provider: input.provider,
          purchases: facts.map((fact) => ({
            ...fact,
            authUserId: input.authUserId,
          })),
        });
        inserted += result.inserted;
        skipped += result.skipped;
      }

      if (!nextCursor) {
        return { inserted, skipped };
      }

      cursor = nextCursor;
      await this.options.delay.sleep(provider.pageDelayMs);
    }
  }
}
