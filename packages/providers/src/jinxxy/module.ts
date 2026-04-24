import type { StructuredLogger } from '@yucp/shared';
import type {
  LicenseVerificationPlugin,
  ProductRecord,
  ProviderContext,
  ProviderPurposes,
  ProviderRuntimeClient,
  ProviderRuntimeModule,
} from '../contracts';
import { JinxxyApiClient } from './client';

export const JINXXY_PURPOSES = {
  credential: 'jinxxy-api-key',
  webhookSecret: 'jinxxy-webhook-signing-secret',
} as const satisfies ProviderPurposes;

export const JINXXY_DISPLAY_META = {
  dashboardSetupExperience: 'guided',
  dashboardSetupHint: 'Paste one API key, then YUCP can scan products and continue automatically.',
  label: 'Jinxxy™',
  icon: 'Jinxxy.png',
  color: '#9146FF',
  shadowColor: '#9146FF',
  textColor: '#ffffff',
  connectedColor: '#7b3be6',
  confettiColors: ['#9146FF', '#7b3be6', '#b980ff', '#ffffff'],
  description: 'Marketplace',
  dashboardConnectPath: '/setup/jinxxy',
  dashboardConnectParamStyle: 'snakeCase',
  dashboardIconBg: '#9146FF',
  dashboardQuickStartBg: 'rgba(145,70,255,0.1)',
  dashboardQuickStartBorder: 'rgba(145,70,255,0.3)',
  dashboardServerTileHint: 'Allow users to verify Jinxxy purchases in this Discord server.',
} as const;

const HARD_PAGE_LIMIT = 100;

function normalizeJinxxyAmountCents(price: number) {
  return Math.round(price);
}

export interface JinxxyCollaboratorConnection {
  id: string;
  provider: string;
  credentialEncrypted?: string;
  collaboratorDisplayName?: string;
}

type JinxxyRuntimeLogger = Pick<StructuredLogger, 'warn'>;

interface JinxxyClientLike {
  getProducts(params: { page: number; per_page: number }): Promise<{
    products: Array<{ id: string; name: string }>;
    pagination?: { has_next?: boolean };
  }>;
  getProduct(productId: string): Promise<{
    id: string;
    versions?: Array<{
      id: string;
      name: string;
      price: number;
    }>;
    base_price?: number;
    currency_code?: string;
    visibility?: string;
  } | null>;
  verifyLicenseByKey(licenseKey: string): Promise<{
    valid: boolean;
    error?: string;
    providerUserId?: string;
    externalOrderId?: string;
    providerProductId?: string;
    license?: {
      id?: string;
      customer_id?: string;
      order_id?: string;
      product_id?: string;
    } | null;
  }>;
  verifyLicenseWithBuyerByKey?(licenseKey: string): Promise<{
    valid: boolean;
    error?: string;
    providerUserId?: string;
    externalOrderId?: string;
    providerProductId?: string;
    license?: {
      id?: string;
      customer_id?: string;
      order_id?: string;
      product_id?: string;
    } | null;
  }>;
}

export interface JinxxyRuntimePorts<TClient extends ProviderRuntimeClient = ProviderRuntimeClient> {
  readonly logger: JinxxyRuntimeLogger;
  getEncryptedCredential(authUserId: string, ctx: ProviderContext<TClient>): Promise<string | null>;
  decryptCredential(encryptedCredential: string, ctx: ProviderContext<TClient>): Promise<string>;
  listCollaboratorConnections(
    ctx: ProviderContext<TClient>
  ): Promise<JinxxyCollaboratorConnection[]>;
  createClient?(apiKey: string): JinxxyClientLike;
}

export type JinxxyProviderRuntime<TClient extends ProviderRuntimeClient = ProviderRuntimeClient> =
  Omit<ProviderRuntimeModule<never, TClient>, 'backfill' | 'buyerVerification'> & {
    readonly buyerVerification?: undefined;
  };

function getClient(ports: JinxxyRuntimePorts, apiKey: string): JinxxyClientLike {
  return ports.createClient?.(apiKey) ?? new JinxxyApiClient({ apiKey });
}

function mapVisibilityToActive(visibility: string | undefined): boolean {
  return visibility !== 'ARCHIVED' && visibility !== 'archived';
}

async function listProductsForKey(
  apiKey: string,
  ports: JinxxyRuntimePorts
): Promise<Array<{ id: string; name: string }>> {
  const client = getClient(ports, apiKey);
  const products: Array<{ id: string; name: string }> = [];
  let page = 1;
  while (page <= HARD_PAGE_LIMIT) {
    const { products: pageProducts, pagination } = await client.getProducts({
      page,
      per_page: 50,
    });
    for (const product of pageProducts) {
      if (product.id && product.name) {
        products.push({ id: product.id, name: product.name });
      }
    }
    if (!pagination?.has_next || pageProducts.length < 50) {
      break;
    }
    page++;
  }
  return products;
}

export function createJinxxyLicenseVerification<
  TClient extends ProviderRuntimeClient = ProviderRuntimeClient,
>(ports: JinxxyRuntimePorts<TClient>): LicenseVerificationPlugin<TClient> {
  return {
    async verifyLicense(licenseKey, _productId, authUserId, ctx) {
      const encryptedApiKey = await ports.getEncryptedCredential(authUserId, ctx);
      if (!encryptedApiKey) {
        return {
          valid: false,
          error: 'Jinxxy API key not configured. Add your Jinxxy API key in `/creator setup`.',
        };
      }

      const apiKey = await ports.decryptCredential(encryptedApiKey, ctx);
      const client = getClient(ports, apiKey);
      const result = client.verifyLicenseWithBuyerByKey
        ? await client.verifyLicenseWithBuyerByKey(licenseKey)
        : await client.verifyLicenseByKey(licenseKey);

      return {
        valid: result.valid,
        externalOrderId:
          result.externalOrderId ?? result.license?.order_id ?? result.license?.id ?? undefined,
        providerUserId: result.providerUserId ?? result.license?.customer_id ?? undefined,
        providerProductId: result.providerProductId ?? result.license?.product_id ?? undefined,
        error: result.error ?? undefined,
      };
    },
  };
}

export function createJinxxyProviderModule<
  TClient extends ProviderRuntimeClient = ProviderRuntimeClient,
>(ports: JinxxyRuntimePorts<TClient>): JinxxyProviderRuntime<TClient> {
  return {
    id: 'jinxxy',
    needsCredential: true,
    supportsCollab: true,
    purposes: JINXXY_PURPOSES,
    displayMeta: JINXXY_DISPLAY_META,
    async getCredential(ctx) {
      const encryptedApiKey = await ports.getEncryptedCredential(ctx.authUserId, ctx);
      if (!encryptedApiKey) {
        return null;
      }
      return await ports.decryptCredential(encryptedApiKey, ctx);
    },
    async fetchProducts(credential, ctx): Promise<ProductRecord[]> {
      if (!credential) {
        return [];
      }

      const products: ProductRecord[] = await listProductsForKey(credential, ports);

      try {
        const collabConnections = await ports.listCollaboratorConnections(ctx);
        for (const collab of collabConnections) {
          if (collab.provider !== 'jinxxy' || !collab.credentialEncrypted) {
            continue;
          }
          try {
            const collabKey = await ports.decryptCredential(collab.credentialEncrypted, ctx);
            const collabProducts = await listProductsForKey(collabKey, ports);
            for (const product of collabProducts) {
              products.push({
                ...product,
                collaboratorName: collab.collaboratorDisplayName ?? 'Collaborator',
              });
            }
          } catch (err) {
            ports.logger.warn('Failed to fetch products for collaborator', {
              collabId: collab.id,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      } catch (err) {
        ports.logger.warn('Failed to fetch collaborator connections for product list', {
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
      async listProductTiers(credential, productId) {
        if (!credential) {
          return [];
        }

        const client = getClient(ports, credential);
        /**
         * Jinxxy product docs:
         * - https://api.creators.jinxxy.com/v1/docs#tag/products/GET/products/{id}
         * - https://api.creators.jinxxy.com/v1/openapi.json
         * The product response schema documents top-level `currency_code` and `visibility`,
         * plus `versions[]` entries with `id`, `name`, and `price`. Current creator API
         * payloads surface `price` in cents already, so YUCP preserves the numeric value
         * as `amountCents` instead of applying a second major-unit conversion. Each
         * version is treated as a provider tier.
         */
        const product = await client.getProduct(productId);
        if (!product?.versions?.length) {
          return [];
        }

        const active = mapVisibilityToActive(product.visibility);
        return product.versions.map((version) => ({
          id: version.id,
          productId,
          name: version.name,
          amountCents: normalizeJinxxyAmountCents(version.price),
          currency: product.currency_code ?? 'USD',
          active,
          metadata: {
            provider: 'jinxxy',
          },
        }));
      },
    },
    verification: createJinxxyLicenseVerification(ports),
    async collabValidate(credential: string): Promise<void> {
      await getClient(ports, credential).getProducts({ per_page: 1, page: 1 });
    },
    collabCredentialPurpose: JINXXY_PURPOSES.credential,
  };
}
