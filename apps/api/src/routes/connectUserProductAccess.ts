import {
  buildCatalogProductUrl,
  getProviderDescriptor,
  providerLabel,
} from '@yucp/providers/providerMetadata';
import { getSafeRelativeRedirectTarget } from '@yucp/shared';
import { sha256Base64Url } from '@yucp/shared/crypto';
import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';
import type { Auth } from '../auth';
import { createAuthUserActorBinding } from '../lib/apiActor';
import { buildCookie, getCookieValue } from '../lib/browserSessions';
import { getConvexClientFromUrl } from '../lib/convex';
import { logger } from '../lib/logger';
import type { ConnectConfig } from '../providers/types';
import {
  type HostedVerificationIntentRecord,
  mapHostedVerificationIntentResponse,
  normalizeHostedVerificationRequirements,
  type VerificationIntentRequirementInput,
} from '../verification/hostedIntents';

interface CreateConnectUserProductAccessRoutesOptions {
  auth: Auth;
  config: ConnectConfig;
}

type BuyerAccessCatalogProduct = {
  catalogProductId: Id<'product_catalog'>;
  creatorAuthUserId: string;
  productId: string;
  provider: string;
  providerProductRef: string;
  displayName?: string;
  canonicalSlug?: string;
  thumbnailUrl?: string;
  status: 'active';
  backstagePackages: Array<{
    packageId: string;
    packageName?: string;
    displayName?: string;
    defaultChannel?: string;
    latestPublishedVersion?: string;
    latestPublishedAt?: number;
    repositoryVisibility: 'hidden' | 'listed';
  }>;
};

function buildBuyerProductAccessPath(catalogProductId: string): string {
  return `/access/${encodeURIComponent(catalogProductId)}`;
}

const BUYER_ACCESS_MACHINE_COOKIE = 'yucp_buyer_access_machine';
const BUYER_ACCESS_MACHINE_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const BUYER_ACCESS_MACHINE_FINGERPRINT_PATTERN = /^buyer-access-web:[0-9a-f]{32}$/;

function createBuyerAccessMachineFingerprint(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `buyer-access-web:${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function resolveBuyerAccessMachineFingerprint(request: Request): {
  machineFingerprint: string;
  setCookie: string | null;
} {
  const existing = getCookieValue(request, BUYER_ACCESS_MACHINE_COOKIE)?.trim();
  if (existing && BUYER_ACCESS_MACHINE_FINGERPRINT_PATTERN.test(existing)) {
    return {
      machineFingerprint: existing,
      setCookie: null,
    };
  }

  const machineFingerprint = createBuyerAccessMachineFingerprint();
  return {
    machineFingerprint,
    setCookie: buildCookie(BUYER_ACCESS_MACHINE_COOKIE, machineFingerprint, request, {
      maxAgeSeconds: BUYER_ACCESS_MACHINE_COOKIE_MAX_AGE_SECONDS,
    }),
  };
}

function buildBuyerAccessIdempotencyKey(catalogProductId: string, returnPath: string): string {
  return `buyer-access:${catalogProductId}:${encodeURIComponent(returnPath)}`;
}

function buildHostedVerificationRequirements(
  product: BuyerAccessCatalogProduct
): VerificationIntentRequirementInput[] {
  const descriptor = getProviderDescriptor(product.provider);
  const requirements: VerificationIntentRequirementInput[] = [
    {
      methodKey: 'yucp-existing-entitlement',
      providerKey: 'yucp',
      kind: 'existing_entitlement',
      creatorAuthUserId: product.creatorAuthUserId,
      productId: product.productId,
    },
  ];

  if (descriptor?.buyerVerificationMethods.includes('account_link')) {
    requirements.push({
      methodKey: `${product.provider}-buyer-provider-link`,
      providerKey: product.provider,
      kind: 'buyer_provider_link',
      creatorAuthUserId: product.creatorAuthUserId,
      productId: product.productId,
    });
  }

  if (descriptor?.buyerVerificationMethods.includes('license_key')) {
    requirements.push({
      methodKey: `${product.provider}-manual-license`,
      providerKey: product.provider,
      kind: 'manual_license',
      providerProductRef: product.providerProductRef,
    });
  }

  return requirements;
}

export function createConnectUserProductAccessRoutes({
  auth,
  config,
}: CreateConnectUserProductAccessRoutesOptions) {
  async function resolveAccessProduct(
    catalogProductId: string
  ): Promise<BuyerAccessCatalogProduct | null> {
    const convex = getConvexClientFromUrl(config.convexUrl);
    return (await convex.query(api.packageRegistry.getBuyerAccessContextByCatalogProductId, {
      apiSecret: config.convexApiSecret,
      catalogProductId: catalogProductId as Id<'product_catalog'>,
    })) as BuyerAccessCatalogProduct | null;
  }

  async function getBuyerProductAccess(
    request: Request,
    catalogProductId: string
  ): Promise<Response> {
    const session = await auth.getSession(request);

    try {
      const convex = getConvexClientFromUrl(config.convexUrl);
      const product = await resolveAccessProduct(catalogProductId);
      if (!product) {
        return Response.json({ error: 'Product access page not found' }, { status: 404 });
      }

      const entitlementsResult = session
        ? await convex.query(api.entitlements.listByAuthUser, {
            apiSecret: config.convexApiSecret,
            authUserId: session.user.id,
            productId: product.productId,
            status: 'active',
            limit: 20,
          })
        : { data: [] };
      const activeEntitlement =
        entitlementsResult.data?.find(
          (entitlement: { catalogProductId?: Id<'product_catalog'> | null }) =>
            !entitlement.catalogProductId ||
            String(entitlement.catalogProductId) === String(product.catalogProductId)
        ) ?? null;

      return Response.json({
        product: {
          catalogProductId: String(product.catalogProductId),
          displayName: product.displayName ?? product.productId,
          canonicalSlug: product.canonicalSlug ?? null,
          thumbnailUrl: product.thumbnailUrl ?? null,
          provider: product.provider,
          providerLabel: providerLabel(product.provider),
          storefrontUrl: buildCatalogProductUrl(product.provider, product.providerProductRef),
          accessPagePath: buildBuyerProductAccessPath(String(product.catalogProductId)),
          packagePreview: product.backstagePackages.map((packageLink) => ({
            packageId: packageLink.packageId,
            packageName: packageLink.packageName ?? null,
            displayName: packageLink.displayName ?? null,
            defaultChannel: packageLink.defaultChannel ?? null,
            latestPublishedVersion: packageLink.latestPublishedVersion ?? null,
            latestPublishedAt: packageLink.latestPublishedAt ?? null,
            repositoryVisibility: packageLink.repositoryVisibility,
          })),
        },
        accessState: {
          hasActiveEntitlement: Boolean(activeEntitlement),
          requiresVerification: !activeEntitlement,
          hasPublishedPackages: product.backstagePackages.length > 0,
        },
      });
    } catch (error) {
      logger.error('Failed to load buyer product access surface', {
        catalogProductId,
        error: error instanceof Error ? error.message : String(error),
      });
      return Response.json({ error: 'Failed to load product access' }, { status: 500 });
    }
  }

  async function postBuyerProductAccessVerificationIntent(
    request: Request,
    catalogProductId: string
  ): Promise<Response> {
    if (request.method !== 'POST') {
      return Response.json({ error: 'Method not allowed' }, { status: 405 });
    }

    const session = await auth.getSession(request);
    if (!session) {
      return Response.json({ error: 'Authentication required' }, { status: 401 });
    }

    let body: { returnTo?: string } = {};
    try {
      body = (await request.json()) as typeof body;
    } catch {
      body = {};
    }

    try {
      const product = await resolveAccessProduct(catalogProductId);
      if (!product) {
        return Response.json({ error: 'Product access page not found' }, { status: 404 });
      }
      if (product.backstagePackages.length === 0) {
        return Response.json(
          {
            error:
              'This product does not have a published package yet. Ask the creator to finish package setup first.',
          },
          { status: 409 }
        );
      }

      const convex = getConvexClientFromUrl(config.convexUrl);
      const safeReturnPath =
        getSafeRelativeRedirectTarget(body.returnTo) ??
        buildBuyerProductAccessPath(String(product.catalogProductId));
      const returnUrl = `${config.frontendBaseUrl.replace(/\/$/, '')}${safeReturnPath}`;
      const buyerAccessFingerprint = resolveBuyerAccessMachineFingerprint(request);
      const primaryPackage = product.backstagePackages[0];
      const packageId = primaryPackage?.packageId ?? product.productId;
      const packageName =
        product.displayName ??
        primaryPackage?.displayName ??
        primaryPackage?.packageName ??
        primaryPackage?.packageId ??
        product.productId;
      const codeVerifier = `${crypto.randomUUID()}${crypto.randomUUID()}`;
      const requirements = normalizeHostedVerificationRequirements(
        buildHostedVerificationRequirements(product)
      );
      const actor = await createAuthUserActorBinding({
        authUserId: session.user.id,
        source: 'session',
      });

      const created = await convex.mutation(api.verificationIntents.createVerificationIntent, {
        apiSecret: config.convexApiSecret,
        actor,
        authUserId: session.user.id,
        packageId,
        packageName,
        machineFingerprint: buyerAccessFingerprint.machineFingerprint,
        codeChallenge: await sha256Base64Url(codeVerifier),
        returnUrl,
        idempotencyKey: buildBuyerAccessIdempotencyKey(
          String(product.catalogProductId),
          safeReturnPath
        ),
        requirements,
      });
      const intent = (await convex.action(api.verificationIntents.getVerificationIntent, {
        apiSecret: config.convexApiSecret,
        authUserId: session.user.id,
        intentId: created.intentId,
      })) as HostedVerificationIntentRecord | null;

      if (!intent) {
        return Response.json({ error: 'Failed to create verification intent' }, { status: 500 });
      }

      const headers = new Headers();
      if (buyerAccessFingerprint.setCookie) {
        headers.set('Set-Cookie', buyerAccessFingerprint.setCookie);
      }

      return Response.json(
        mapHostedVerificationIntentResponse(intent, config.frontendBaseUrl),
        buyerAccessFingerprint.setCookie ? { headers } : undefined
      );
    } catch (error) {
      logger.error('Failed to create buyer product access verification intent', {
        catalogProductId,
        error: error instanceof Error ? error.message : String(error),
      });
      return Response.json({ error: 'Failed to start verification' }, { status: 500 });
    }
  }

  return {
    getBuyerProductAccess,
    postBuyerProductAccessVerificationIntent,
  };
}
