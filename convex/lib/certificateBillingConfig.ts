/**
 * Certificate billing configuration.
 *
 * Polar references:
 *   Better Auth adapter  https://polar.sh/docs/integrate/sdk/adapters/better-auth
 *   Customer state       https://polar.sh/docs/integrate/customer-state
 */

export const CERTIFICATE_WORKSPACE_METADATA_KEY = 'workspace_key';

export interface CertificateBillingPlanConfig {
  planKey: string;
  productId: string;
  slug: string;
  priority: number;
  deviceCap: number;
  signQuotaPerPeriod: number | null;
  auditRetentionDays: number;
  supportTier: string;
  billingGraceDays: number;
}

export interface CertificateBillingConfig {
  enabled: boolean;
  polarAccessToken?: string;
  polarWebhookSecret?: string;
  polarServer?: 'sandbox';
  products: CertificateBillingPlanConfig[];
}

interface RawPlanConfig {
  planKey?: unknown;
  productId?: unknown;
  slug?: unknown;
  priority?: unknown;
  deviceCap?: unknown;
  signQuotaPerPeriod?: unknown;
  auditRetentionDays?: unknown;
  supportTier?: unknown;
  billingGraceDays?: unknown;
}

function readNonNegativeInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;
}

function readPositiveInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

export function buildAuthUserWorkspaceKey(authUserId: string): string {
  return `auth-user:${authUserId}`;
}

export function buildCreatorProfileWorkspaceKey(creatorProfileId: string): string {
  return `creator-profile:${creatorProfileId}`;
}

export function resolveWorkspaceKeys(
  authUserId: string,
  creatorProfileId?: string | null
): string[] {
  const keys = [buildAuthUserWorkspaceKey(authUserId)];
  if (creatorProfileId) {
    keys.unshift(buildCreatorProfileWorkspaceKey(creatorProfileId));
  }
  return keys;
}

export function extractWorkspaceKeyFromMetadata(
  metadata: Record<string, string | number | boolean> | null | undefined,
  fallbackWorkspaceKey: string
): string {
  const candidate = metadata?.[CERTIFICATE_WORKSPACE_METADATA_KEY];
  return typeof candidate === 'string' && candidate.trim()
    ? candidate.trim()
    : fallbackWorkspaceKey;
}

export function parseCertificateBillingProductsJson(
  raw: string | undefined
): CertificateBillingPlanConfig[] {
  if (!raw?.trim() || raw.trim() === 'undefined' || raw.trim() === 'null') {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `POLAR_CERT_PRODUCTS_JSON must be valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (!Array.isArray(parsed)) {
    throw new Error('POLAR_CERT_PRODUCTS_JSON must be a JSON array');
  }

  return parsed.map((entry, index) => {
    const value = entry as RawPlanConfig;
    if (typeof value.planKey !== 'string' || !value.planKey.trim()) {
      throw new Error(`POLAR_CERT_PRODUCTS_JSON[${index}].planKey must be a non-empty string`);
    }
    if (typeof value.productId !== 'string' || !value.productId.trim()) {
      throw new Error(`POLAR_CERT_PRODUCTS_JSON[${index}].productId must be a non-empty string`);
    }
    if (typeof value.slug !== 'string' || !value.slug.trim()) {
      throw new Error(`POLAR_CERT_PRODUCTS_JSON[${index}].slug must be a non-empty string`);
    }

    return {
      planKey: value.planKey.trim(),
      productId: value.productId.trim(),
      slug: value.slug.trim(),
      priority: readNonNegativeInteger(value.priority, index),
      deviceCap: readPositiveInteger(value.deviceCap, 1),
      signQuotaPerPeriod:
        typeof value.signQuotaPerPeriod === 'number' &&
        Number.isFinite(value.signQuotaPerPeriod) &&
        value.signQuotaPerPeriod > 0
          ? Math.floor(value.signQuotaPerPeriod)
          : null,
      auditRetentionDays: readPositiveInteger(value.auditRetentionDays, 30),
      supportTier:
        typeof value.supportTier === 'string' && value.supportTier.trim()
          ? value.supportTier.trim()
          : 'standard',
      billingGraceDays: readNonNegativeInteger(value.billingGraceDays, 3),
    };
  });
}

export function getCertificateBillingConfig(): CertificateBillingConfig {
  const products = parseCertificateBillingProductsJson(process.env.POLAR_CERT_PRODUCTS_JSON);
  const polarAccessToken = process.env.POLAR_ACCESS_TOKEN?.trim();
  const polarWebhookSecret = process.env.POLAR_WEBHOOK_SECRET?.trim();
  const polarServer =
    process.env.POLAR_SERVER?.trim().toLowerCase() === 'sandbox' ? 'sandbox' : undefined;

  return {
    enabled: Boolean(polarAccessToken && polarWebhookSecret && products.length > 0),
    polarAccessToken,
    polarWebhookSecret,
    polarServer,
    products,
  };
}

export function getPlanForProductId(
  config: CertificateBillingConfig,
  productId: string
): CertificateBillingPlanConfig | null {
  return config.products.find((plan) => plan.productId === productId) ?? null;
}
