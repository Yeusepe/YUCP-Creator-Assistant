import { parseProductId, type StructuredLogger } from '@yucp/shared';
import type {
  LicenseVerificationPlugin,
  ProductRecord,
  ProviderContext,
  ProviderPurposes,
  ProviderRuntimeClient,
  ProviderRuntimeModule,
} from '../contracts';
import { PayhipApiClient } from './client';
import type { PayhipProductKey } from './index';
import { PayhipAdapter } from './index';
import type { PayhipLicenseVerifyResult } from './types';

export const PAYHIP_PURPOSES = {
  credential: 'payhip-api-key',
  productSecret: 'payhip-product-secret',
} as const satisfies ProviderPurposes;

export const PAYHIP_DISPLAY_META = {
  label: 'Payhip',
  icon: 'PayHip.png',
  color: '#00d1b2',
  shadowColor: '#00d1b2',
  textColor: '#ffffff',
  connectedColor: '#00a896',
  confettiColors: ['#00d1b2', '#00a896', '#80ffe8', '#ffffff'],
  description: 'Marketplace',
  dashboardConnectPath: '/setup/payhip',
  dashboardConnectParamStyle: 'snakeCase',
  dashboardIconBg: '#3b82f6',
  dashboardQuickStartBg: 'rgba(59,130,246,0.12)',
  dashboardQuickStartBorder: 'rgba(59,130,246,0.32)',
  dashboardServerTileHint:
    'Allow users to verify Payhip purchases and license keys in this Discord server.',
} as const;

export interface PayhipCatalogEntry {
  permalink: string;
  displayName?: string;
  productPermalink?: string;
  hasSecretKey: boolean;
}

export interface PayhipSecretKeyRecord {
  permalink: string;
  encryptedSecretKey: string;
}

type PayhipRuntimeLogger = Pick<StructuredLogger, 'info' | 'warn'>;

export interface PayhipRuntimePorts<TClient extends ProviderRuntimeClient = ProviderRuntimeClient> {
  readonly logger: PayhipRuntimeLogger;
  listProducts(ctx: ProviderContext<TClient>): Promise<PayhipCatalogEntry[]>;
  upsertProductName(
    input: { authUserId: string; permalink: string; displayName: string },
    ctx: ProviderContext<TClient>
  ): Promise<void>;
  listProductSecretKeys(
    authUserId: string,
    ctx: ProviderContext<TClient>
  ): Promise<PayhipSecretKeyRecord[]>;
  decryptProductSecretKey(
    encryptedSecretKey: string,
    ctx: ProviderContext<TClient>
  ): Promise<string>;
  verifyLicenseKey?(
    licenseKey: string,
    productKeys: PayhipProductKey[]
  ): Promise<PayhipLicenseVerifyResult>;
}

export type PayhipProviderRuntime<TClient extends ProviderRuntimeClient = ProviderRuntimeClient> =
  Omit<ProviderRuntimeModule<never, TClient>, 'backfill'>;

export function createPayhipLicenseVerification<
  TClient extends ProviderRuntimeClient = ProviderRuntimeClient,
>(ports: PayhipRuntimePorts<TClient>): LicenseVerificationPlugin<TClient> {
  return {
    async verifyLicense(licenseKey, _productId, authUserId, ctx) {
      const rawKeys = await ports.listProductSecretKeys(authUserId, ctx);

      if (rawKeys.length === 0) {
        return {
          valid: false,
          error: 'No product secret keys configured for this store. Contact the server owner.',
        };
      }

      const productKeys: Array<{ permalink: string; secretKey: string }> = [];
      for (const { permalink, encryptedSecretKey } of rawKeys) {
        try {
          const secretKey = await ports.decryptProductSecretKey(encryptedSecretKey, ctx);
          productKeys.push({ permalink, secretKey });
        } catch (err) {
          ports.logger.warn('[payhip/verification] Failed to decrypt product secret key', {
            authUserId,
            permalink,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (productKeys.length === 0) {
        return {
          valid: false,
          error: 'Product secret keys could not be decrypted. Contact the server owner.',
        };
      }

      const result = await (
        ports.verifyLicenseKey ??
        (async (licenseKeyValue: string, productKeysValue: PayhipProductKey[]) => {
          const adapter = new PayhipAdapter();
          return await adapter.verifyLicenseKey(licenseKeyValue, productKeysValue);
        })
      )(licenseKey, productKeys);

      ports.logger.info('[payhip/verification] verifyLicenseKey result', {
        authUserId,
        valid: result.valid,
        matchedPermalink: result.matchedProductPermalink,
      });

      const rawPermalink = result.matchedProductPermalink;
      let normalizedPermalink = rawPermalink;
      if (rawPermalink) {
        const parsed = parseProductId('payhip', rawPermalink);
        normalizedPermalink = parsed.ok ? parsed.productId : rawPermalink;
      }

      return {
        valid: result.valid,
        providerProductId: normalizedPermalink,
        error: result.error,
      };
    },
  };
}

export function createPayhipProviderModule<
  TClient extends ProviderRuntimeClient = ProviderRuntimeClient,
>(ports: PayhipRuntimePorts<TClient>): PayhipProviderRuntime<TClient> {
  return {
    id: 'payhip',
    needsCredential: false,
    supportsCollab: true,
    purposes: PAYHIP_PURPOSES,
    collabCredentialPurpose: PAYHIP_PURPOSES.credential,
    productCredentialPurpose: PAYHIP_PURPOSES.productSecret,
    async getCredential() {
      return null;
    },
    async fetchProducts(_credential, ctx): Promise<ProductRecord[]> {
      const entries = await ports.listProducts(ctx);
      return entries.map((entry) => ({
        id: entry.permalink,
        name: entry.displayName,
        productUrl: entry.productPermalink ?? `https://payhip.com/b/${entry.permalink}`,
        hasSecretKey: entry.hasSecretKey,
      }));
    },
    async onProductCredentialAdded(productId, ctx) {
      const client = new PayhipApiClient();
      const name = await client.fetchProductName(productId);
      if (!name) {
        return;
      }
      await ports.upsertProductName(
        { authUserId: ctx.authUserId, permalink: productId, displayName: name },
        ctx
      );
    },
    displayMeta: PAYHIP_DISPLAY_META,
    verification: createPayhipLicenseVerification(ports),
  };
}
