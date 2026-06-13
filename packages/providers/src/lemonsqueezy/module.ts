import type { StructuredLogger } from '@yucp/shared';
import type {
  LicenseVerificationPlugin,
  LicenseVerificationResult,
  ProductRecord,
  ProviderContext,
  ProviderPurposes,
  ProviderRuntimeClient,
  ProviderRuntimeModule,
  ProviderTierRecord,
} from '../contracts';
import { LemonSqueezyApiClient } from './client';

export const LEMONSQUEEZY_PURPOSES = {
  credential: 'lemonsqueezy-api-token',
  webhookSecret: 'lemonsqueezy-webhook-secret',
} as const satisfies ProviderPurposes;

export const LEMONSQUEEZY_DISPLAY_META = {
  dashboardSetupExperience: 'guided',
  dashboardSetupHint:
    'Provide an API token and store selection once, then the setup job can manage the rest.',
  label: 'Lemon Squeezy',
  icon: 'LemonSqueezy.png',
  color: '#ffd35a',
  shadowColor: '#ffd35a',
  textColor: '#000000',
  connectedColor: '#e6b600',
  confettiColors: ['#ffd35a', '#e6b600', '#fff0a0', '#ffffff'],
  description: 'Marketplace',
  dashboardConnectPath: '/setup/lemonsqueezy',
  dashboardConnectParamStyle: 'snakeCase',
  dashboardIconBg: '#f7b84b',
  dashboardQuickStartBg: 'rgba(247,184,75,0.12)',
  dashboardQuickStartBorder: 'rgba(247,184,75,0.32)',
  dashboardServerTileHint:
    'Allow users to verify Lemon Squeezy purchases and licenses in this Discord server.',
} as const;

export interface LemonSqueezyCollaboratorConnection {
  id: string;
  provider: string;
  credentialEncrypted?: string;
  collaboratorDisplayName?: string;
}

type LemonSqueezyRuntimeLogger = Pick<StructuredLogger, 'warn' | 'error'>;

interface LemonSqueezyClientLike {
  getProducts(params: { page: number; perPage: number }): Promise<{
    products: Array<{ id: string; name: string; slug?: string | null; url?: string | null }>;
    pagination: { nextPage: number | null };
  }>;
  getVariants(productId: string): Promise<
    Array<{
      id: string;
      name: string;
      description?: string | null;
      price?: number | null;
      status?: string | null;
    }>
  >;
  getStores(
    page?: number,
    perPage?: number
  ): Promise<{
    stores: Array<{ id: string }>;
  }>;
  validateLicenseKey(licenseKey: string): Promise<{
    valid: boolean;
    error?: string | null;
    license_key?: { id?: number | string | null };
    meta?: {
      order_item_id?: number | string | null;
      product_id?: number | string | null;
    };
  }>;
}

export interface LemonSqueezyRuntimePorts<
  TClient extends ProviderRuntimeClient = ProviderRuntimeClient,
> {
  readonly logger: LemonSqueezyRuntimeLogger;
  getEncryptedCredential(authUserId: string, ctx: ProviderContext<TClient>): Promise<string | null>;
  decryptCredential(encryptedCredential: string, ctx: ProviderContext<TClient>): Promise<string>;
  listCollaboratorConnections(
    ctx: ProviderContext<TClient>
  ): Promise<LemonSqueezyCollaboratorConnection[]>;
  createClient?(apiToken: string): LemonSqueezyClientLike;
}

export type LemonSqueezyProviderRuntime<
  TClient extends ProviderRuntimeClient = ProviderRuntimeClient,
> = Omit<ProviderRuntimeModule<never, TClient>, 'backfill' | 'buyerVerification'> & {
  readonly buyerVerification?: undefined;
};

function getClient(ports: LemonSqueezyRuntimePorts, apiToken: string): LemonSqueezyClientLike {
  const client = ports.createClient?.(apiToken);
  if (client) {
    return client;
  }

  const apiClient = new LemonSqueezyApiClient({ apiToken });
  return {
    getProducts: (params) => apiClient.getProducts(params),
    getVariants: async (productId) => apiClient.getAllVariants(productId),
    getStores: (page, perPage) => apiClient.getStores(page, perPage),
    validateLicenseKey: (licenseKey) => apiClient.validateLicenseKey(licenseKey),
  };
}

async function listProductsForToken(
  apiToken: string,
  ports: LemonSqueezyRuntimePorts
): Promise<ProductRecord[]> {
  const client = getClient(ports, apiToken);
  const products: ProductRecord[] = [];
  let page = 1;

  while (true) {
    const { products: pageProducts, pagination } = await client.getProducts({
      page,
      perPage: 50,
    });
    for (const product of pageProducts) {
      if (product.id && product.name) {
        products.push({
          id: product.id,
          name: product.name,
          ...(product.slug?.trim() ? { canonicalSlug: product.slug.trim() } : {}),
          ...(product.url?.trim() ? { productUrl: product.url.trim() } : {}),
        });
      }
    }
    if (!pagination.nextPage) {
      break;
    }
    page = pagination.nextPage;
  }

  return products;
}

type LemonSqueezyValidationResult = Awaited<
  ReturnType<LemonSqueezyClientLike['validateLicenseKey']>
>;

function mapLemonSqueezyVerificationResult(
  validation: LemonSqueezyValidationResult
): LicenseVerificationResult {
  const licenseId =
    validation.license_key?.id != null
      ? String(validation.license_key.id)
      : validation.meta?.order_item_id != null
        ? String(validation.meta.order_item_id)
        : undefined;

  const providerProductId =
    validation.meta?.product_id != null ? String(validation.meta.product_id) : undefined;

  return {
    valid: validation.valid,
    externalOrderId: licenseId,
    providerProductId,
    error: validation.error ?? undefined,
  };
}

async function validateLicenseWithAccessibleCredential(
  credential: string,
  licenseKey: string,
  ctx: ProviderContext,
  ports: LemonSqueezyRuntimePorts
): Promise<LicenseVerificationResult> {
  const ownerValidation = await getClient(ports, credential).validateLicenseKey(licenseKey);
  if (ownerValidation.valid) {
    return mapLemonSqueezyVerificationResult(ownerValidation);
  }

  let collabConnections: LemonSqueezyCollaboratorConnection[];
  try {
    collabConnections = await ports.listCollaboratorConnections(ctx);
  } catch (err) {
    ports.logger.warn('Failed to fetch collaborator connections for LS license lookup', {
      error: err instanceof Error ? err.message : String(err),
    });
    return mapLemonSqueezyVerificationResult(ownerValidation);
  }

  for (const collab of collabConnections) {
    if (collab.provider !== 'lemonsqueezy' || !collab.credentialEncrypted) {
      continue;
    }

    try {
      const collabToken = await ports.decryptCredential(collab.credentialEncrypted, ctx);
      const collabValidation = await getClient(ports, collabToken).validateLicenseKey(licenseKey);
      if (collabValidation.valid) {
        return mapLemonSqueezyVerificationResult(collabValidation);
      }
    } catch (err) {
      ports.logger.warn('Failed to verify LS license with collaborator credential', {
        collabId: collab.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return mapLemonSqueezyVerificationResult(ownerValidation);
}

async function getVariantsForAccessibleCredential(
  credential: string,
  productId: string,
  ctx: ProviderContext,
  ports: LemonSqueezyRuntimePorts
): Promise<Awaited<ReturnType<LemonSqueezyClientLike['getVariants']>>> {
  let firstError: unknown;
  let firstEmptyVariants: Awaited<ReturnType<LemonSqueezyClientLike['getVariants']>> | null = null;

  try {
    return await getClient(ports, credential).getVariants(productId);
  } catch (err) {
    firstError = err;
  }

  let collabConnections: LemonSqueezyCollaboratorConnection[];
  try {
    collabConnections = await ports.listCollaboratorConnections(ctx);
  } catch (err) {
    ports.logger.warn('Failed to fetch collaborator connections for LS tier lookup', {
      error: err instanceof Error ? err.message : String(err),
    });
    throw firstError;
  }

  for (const collab of collabConnections) {
    if (collab.provider !== 'lemonsqueezy' || !collab.credentialEncrypted) {
      continue;
    }

    try {
      const collabToken = await ports.decryptCredential(collab.credentialEncrypted, ctx);
      const variants = await getClient(ports, collabToken).getVariants(productId);
      if (variants.length > 0) {
        return variants;
      }
      firstEmptyVariants ??= variants;
    } catch (err) {
      ports.logger.warn('Failed to fetch tiers for LS collaborator product', {
        collabId: collab.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (firstEmptyVariants) {
    return firstEmptyVariants;
  }
  throw firstError ?? new Error('Failed to fetch Lemon Squeezy product tiers');
}

export function createLemonSqueezyLicenseVerification<
  TClient extends ProviderRuntimeClient = ProviderRuntimeClient,
>(ports: LemonSqueezyRuntimePorts<TClient>): LicenseVerificationPlugin<TClient> {
  return {
    async verifyLicense(licenseKey, _productId, authUserId, ctx) {
      const encryptedApiToken = await ports.getEncryptedCredential(authUserId, ctx);
      if (!encryptedApiToken) {
        return {
          valid: false,
          error: 'Lemon Squeezy API key not configured. Connect your store in `/creator setup`.',
        };
      }

      let apiToken: string;
      try {
        apiToken = await ports.decryptCredential(encryptedApiToken, ctx);
      } catch (err) {
        ports.logger.error('Failed to decrypt Lemon Squeezy API token', {
          authUserId,
          err,
        });
        return {
          valid: false,
          error:
            'Failed to decrypt stored API token. Re-connect your Lemon Squeezy store in `/creator setup`.',
        };
      }

      return await validateLicenseWithAccessibleCredential(apiToken, licenseKey, ctx, ports);
    },
  };
}

export function createLemonSqueezyProviderModule<
  TClient extends ProviderRuntimeClient = ProviderRuntimeClient,
>(ports: LemonSqueezyRuntimePorts<TClient>): LemonSqueezyProviderRuntime<TClient> {
  return {
    id: 'lemonsqueezy',
    needsCredential: true,
    supportsCollab: true,
    purposes: LEMONSQUEEZY_PURPOSES,
    displayMeta: LEMONSQUEEZY_DISPLAY_META,
    async getCredential(ctx) {
      const encryptedToken = await ports.getEncryptedCredential(ctx.authUserId, ctx);
      if (!encryptedToken) {
        return null;
      }
      return await ports.decryptCredential(encryptedToken, ctx);
    },
    async fetchProducts(credential, ctx): Promise<ProductRecord[]> {
      const products: ProductRecord[] = [];

      if (credential) {
        const ownerProducts = await listProductsForToken(credential, ports);
        products.push(...ownerProducts);
      }

      try {
        const collabConnections = await ports.listCollaboratorConnections(ctx);

        for (const collab of collabConnections) {
          if (collab.provider !== 'lemonsqueezy' || !collab.credentialEncrypted) {
            continue;
          }
          try {
            const collabToken = await ports.decryptCredential(collab.credentialEncrypted, ctx);
            const collabProducts = await listProductsForToken(collabToken, ports);
            for (const product of collabProducts) {
              products.push({
                ...product,
                collaboratorName: collab.collaboratorDisplayName ?? 'Collaborator',
              });
            }
          } catch (err) {
            ports.logger.warn('Failed to fetch products for LS collaborator', {
              collabId: collab.id,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      } catch (err) {
        ports.logger.warn('Failed to fetch collaborator connections for LS product list', {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      const seen = new Set<string>();
      return products.filter((product) => {
        if (seen.has(product.id)) {
          return false;
        }
        seen.add(product.id);
        return true;
      });
    },
    tiers: {
      async listProductTiers(
        credential: string | null,
        productId: string,
        ctx
      ): Promise<ProviderTierRecord[]> {
        if (!credential) {
          return [];
        }
        // Lemon Squeezy variants are listed at GET /v1/variants filtered by product_id:
        // https://docs.lemonsqueezy.com/api/variants/list-all-variants
        // The variant attributes documented there map directly to YUCP tier fields:
        // `name`, `description`, `price` (already in cents), and `status`.
        const variants = await getVariantsForAccessibleCredential(
          credential,
          productId,
          ctx,
          ports
        );
        return variants.map((variant) => ({
          id: variant.id,
          productId,
          name: variant.name,
          description: variant.description ?? undefined,
          amountCents: variant.price ?? undefined,
          currency: undefined,
          active: variant.status !== 'archived',
          metadata: {
            provider: 'lemonsqueezy',
            status: variant.status ?? undefined,
          },
        }));
      },
    },
    verification: createLemonSqueezyLicenseVerification(ports),
    async collabValidate(credential: string): Promise<void> {
      const result = await getClient(ports, credential).getStores(1, 1);
      if (!result.stores[0]) {
        throw new Error('No Lemon Squeezy stores found for this API key');
      }
    },
    collabCredentialPurpose: LEMONSQUEEZY_PURPOSES.credential,
  };
}
