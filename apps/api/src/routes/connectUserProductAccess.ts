import { buildCatalogProductUrl, providerLabel } from '@yucp/providers/providerMetadata';
import { getSafeRelativeRedirectTarget } from '@yucp/shared';
import { sha256Base64Url } from '@yucp/shared/crypto';
import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';
import type { Auth } from '../auth';
import { createApiServiceActorBinding, createAuthUserActorBinding } from '../lib/apiActor';
import { buildCookie, getCookieValue } from '../lib/browserSessions';
import { getClientAddress } from '../lib/clientAddress';
import { getConvexClientFromUrl } from '../lib/convex';
import { rejectCrossSiteRequest } from '../lib/csrf';
import { logger } from '../lib/logger';
import {
  buildPublicApiRateLimitKey,
  checkPublicApiRateLimit,
  getPublicApiRateLimitStore,
  type PublicApiRateLimitStore,
} from '../lib/publicApiRateLimit';
import { RequestBodyError, readJsonObjectBodyWithLimit } from '../lib/requestBody';
import {
  buildPublicVpmRepositoryAccess,
  type PublicVpmRepositoryAccess,
} from '../lib/vpmPublicRepository';
import type { ConnectConfig } from '../providers/types';
import {
  type HostedVerificationIntentRecord,
  mapHostedVerificationIntentResponse,
  normalizeHostedVerificationRequirements,
} from '../verification/hostedIntents';
import {
  type BuyerAccessCatalogProduct,
  buildHostedVerificationRequirements,
  getBuyerAccessStorefronts,
} from '../verification/productAccessRequirements';

interface CreateConnectUserProductAccessRoutesOptions {
  auth: Auth;
  config: ConnectConfig;
  rateLimitStore?: PublicApiRateLimitStore;
}

type ActiveCreatorVpmLink = {
  linkId: string;
};

function getAllowedOrigins(config: ConnectConfig): Set<string> {
  return new Set([new URL(config.apiBaseUrl).origin, new URL(config.frontendBaseUrl).origin]);
}

const BUYER_ACCESS_MACHINE_COOKIE = 'yucp_buyer_access_machine';
const BUYER_ACCESS_MACHINE_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const BUYER_ACCESS_MACHINE_FINGERPRINT_PATTERN = /^buyer-access-web:[0-9a-f]{32}$/;
const BUYER_ACCESS_VERIFICATION_INTENT_BODY_MAX_BYTES = 4096;
const BUYER_ACCESS_LOOKUP_RATE_LIMIT_MAX_REQUESTS = 120;
const BUYER_ACCESS_LOOKUP_RATE_LIMIT_WINDOW_MS = 60_000;

function jsonNoStore(body: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  headers.set('Cache-Control', 'private, no-store');
  return Response.json(body, {
    ...init,
    headers,
  });
}

function createBuyerAccessMachineFingerprint(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `buyer-access-web:${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function buildBuyerAccessFailureContext(
  error: unknown,
  lookupMode: 'catalog-id' | 'creator-scoped' = 'catalog-id'
) {
  return {
    lookupMode,
    errorName: error instanceof Error ? error.name : 'UnknownError',
  };
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

function buildBuyerAccessIdempotencyKey(
  catalogProductId: string,
  returnPath: string,
  codeChallenge: string
): string {
  return `buyer-access:${catalogProductId}:${encodeURIComponent(returnPath)}:${codeChallenge}`;
}

export function createConnectUserProductAccessRoutes({
  auth,
  config,
  rateLimitStore = getPublicApiRateLimitStore(),
}: CreateConnectUserProductAccessRoutesOptions) {
  async function resolveAccessProduct(
    catalogProductId: string,
    creatorRef?: string
  ): Promise<BuyerAccessCatalogProduct | null> {
    const actor = await createApiServiceActorBinding({
      service: 'buyer-product-access',
      scopes: ['creator:delegate'],
    });
    const convex = getConvexClientFromUrl(config.convexUrl, actor);
    if (creatorRef) {
      return (await convex.query(api.packageRegistry.getBuyerAccessContextByCreatorAndProductRef, {
        apiSecret: config.convexApiSecret,
        actor,
        creatorRef,
        productRef: catalogProductId,
      })) as BuyerAccessCatalogProduct | null;
    }
    return (await convex.query(api.packageRegistry.getBuyerAccessContextByCatalogProductId, {
      apiSecret: config.convexApiSecret,
      actor,
      catalogProductId: catalogProductId as Id<'product_catalog'>,
    })) as BuyerAccessCatalogProduct | null;
  }

  async function resolveBuyerProductAccess(
    session: Awaited<ReturnType<Auth['getSession']>>,
    catalogProductId: string,
    creatorRef?: string
  ) {
    const product = await resolveAccessProduct(catalogProductId, creatorRef);
    if (!product) {
      return { activeEntitlement: null, product: null };
    }

    let activeEntitlement: { catalogProductId?: Id<'product_catalog'> | null } | null = null;
    if (session) {
      const entitlementActor = await createApiServiceActorBinding({
        authUserId: session.user.id,
        service: 'buyer-product-access',
        scopes: ['entitlements:service'],
      });
      const entitlementConvex = getConvexClientFromUrl(config.convexUrl, entitlementActor);
      for (const storefront of getBuyerAccessStorefronts(product)) {
        let cursor: string | undefined;
        do {
          const entitlementsResult = (await entitlementConvex.query(
            api.entitlements.listByAuthUser,
            {
              apiSecret: config.convexApiSecret,
              actor: entitlementActor,
              authUserId: session.user.id,
              scope: 'subject_holder',
              productId: storefront.productId,
              status: 'active',
              limit: 100,
              ...(cursor ? { cursor } : {}),
            }
          )) as {
            data?: Array<{ catalogProductId?: Id<'product_catalog'> | null }>;
            hasMore?: boolean;
            nextCursor?: string | null;
          };
          activeEntitlement =
            entitlementsResult.data?.find(
              (entitlement) =>
                !entitlement.catalogProductId ||
                String(entitlement.catalogProductId) === String(storefront.catalogProductId)
            ) ?? null;
          cursor =
            !activeEntitlement && entitlementsResult.hasMore && entitlementsResult.nextCursor
              ? entitlementsResult.nextCursor
              : undefined;
        } while (!activeEntitlement && cursor);
        if (activeEntitlement) break;
      }
    }

    return { activeEntitlement, product };
  }

  async function resolvePublicRepository(
    product: BuyerAccessCatalogProduct,
    hasActiveEntitlement: boolean
  ): Promise<PublicVpmRepositoryAccess | null> {
    if (!hasActiveEntitlement || !product.packageId || !config.vpmBaseUrl) {
      return null;
    }
    const actor = await createApiServiceActorBinding({
      service: 'buyer-product-access',
      scopes: ['downloads:service'],
    });
    const convex = getConvexClientFromUrl(config.convexUrl, actor);
    const link = (await convex.query(api.creatorVpmLinks.getActiveForPackageAccess, {
      apiSecret: config.convexApiSecret,
      actor,
      authUserId: product.creatorAuthUserId,
      packageId: product.packageId,
    })) as ActiveCreatorVpmLink | null;
    return link ? buildPublicVpmRepositoryAccess(config.vpmBaseUrl, link.linkId) : null;
  }

  async function getBuyerProductAccess(
    request: Request,
    catalogProductId: string
  ): Promise<Response> {
    const rateLimit = await checkPublicApiRateLimit({
      store: rateLimitStore,
      key: buildPublicApiRateLimitKey({
        routeFamily: 'buyer-product-access',
        clientAddress: getClientAddress(request),
      }),
      limit: BUYER_ACCESS_LOOKUP_RATE_LIMIT_MAX_REQUESTS,
      windowMs: BUYER_ACCESS_LOOKUP_RATE_LIMIT_WINDOW_MS,
    });
    if (!rateLimit.allowed) {
      return Response.json(
        { error: 'Too many requests' },
        {
          status: 429,
          headers: { ...rateLimit.headers, 'Cache-Control': 'private, no-store' },
        }
      );
    }

    const session = await auth.getSession(request);
    const creatorRefParam = new URL(request.url).searchParams.get('creator_ref');
    const creatorRef = creatorRefParam?.trim();
    if (
      creatorRefParam !== null &&
      (!creatorRef || creatorRef.length > 256 || creatorRef.includes('/'))
    ) {
      return Response.json({ error: 'Product access page not found' }, { status: 404 });
    }

    try {
      const { activeEntitlement, product } = await resolveBuyerProductAccess(
        session,
        catalogProductId,
        creatorRef
      );
      if (!product) {
        return Response.json({ error: 'Product access page not found' }, { status: 404 });
      }
      const repository = await resolvePublicRepository(product, Boolean(activeEntitlement));

      return jsonNoStore({
        product: {
          catalogProductId: String(product.catalogProductId),
          displayName: product.displayName ?? product.productId,
          canonicalSlug: product.canonicalSlug ?? null,
          thumbnailUrl: product.thumbnailUrl ?? null,
          provider: product.provider,
          providerLabel: providerLabel(product.provider),
          storefrontUrl: buildCatalogProductUrl(product.provider, product.providerProductRef),
          storefronts: product.storefronts.map((storefront) => ({
            catalogProductId: String(storefront.catalogProductId),
            provider: storefront.provider,
            providerLabel: providerLabel(storefront.provider),
            storefrontUrl: buildCatalogProductUrl(
              storefront.provider,
              storefront.providerProductRef
            ),
          })),
        },
        accessState: {
          hasActiveEntitlement: Boolean(activeEntitlement),
          requiresVerification: !activeEntitlement,
        },
        repository,
      });
    } catch (error) {
      logger.error(
        'Failed to load buyer product access surface',
        buildBuyerAccessFailureContext(error, creatorRef ? 'creator-scoped' : 'catalog-id')
      );
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

    const csrfBlock = rejectCrossSiteRequest(request, getAllowedOrigins(config));
    if (csrfBlock) {
      return csrfBlock;
    }

    const session = await auth.getSession(request);
    if (!session) {
      return Response.json({ error: 'Authentication required' }, { status: 401 });
    }

    let body: Record<string, unknown> = {};
    try {
      body = await readJsonObjectBodyWithLimit(
        request,
        BUYER_ACCESS_VERIFICATION_INTENT_BODY_MAX_BYTES
      );
    } catch (error) {
      if (error instanceof RequestBodyError) {
        return Response.json({ error: error.message }, { status: error.status });
      }
      throw error;
    }

    try {
      const product = await resolveAccessProduct(catalogProductId);
      if (!product) {
        return Response.json({ error: 'Product access page not found' }, { status: 404 });
      }
      const safeReturnPath =
        getSafeRelativeRedirectTarget(
          typeof body.returnTo === 'string' ? body.returnTo : undefined
        ) ?? '/dashboard';
      const returnUrl = `${config.frontendBaseUrl.replace(/\/$/, '')}${safeReturnPath}`;
      const buyerAccessFingerprint = resolveBuyerAccessMachineFingerprint(request);
      const packageId = product.packageId ?? product.productId;
      const packageName = product.displayName ?? product.productId;
      const codeVerifier = `${crypto.randomUUID()}${crypto.randomUUID()}`;
      const requirements = normalizeHostedVerificationRequirements(
        buildHostedVerificationRequirements(product)
      );
      const actor = await createAuthUserActorBinding({
        authUserId: session.user.id,
        source: 'session',
      });
      const convex = getConvexClientFromUrl(config.convexUrl, actor);
      const codeChallenge = await sha256Base64Url(codeVerifier);

      const created = await convex.mutation(api.verificationIntents.createVerificationIntent, {
        apiSecret: config.convexApiSecret,
        actor,
        authUserId: session.user.id,
        packageId,
        packageName,
        machineFingerprint: buyerAccessFingerprint.machineFingerprint,
        codeChallenge,
        returnUrl,
        idempotencyKey: buildBuyerAccessIdempotencyKey(
          String(product.catalogProductId),
          safeReturnPath,
          codeChallenge
        ),
        requirements,
      });
      const intent = (await convex.action(api.verificationIntents.getVerificationIntent, {
        apiSecret: config.convexApiSecret,
        actor,
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

      return jsonNoStore(
        {
          ...mapHostedVerificationIntentResponse(intent, config.frontendBaseUrl),
          intentId: String(created.intentId),
          codeVerifier,
          machineFingerprint: buyerAccessFingerprint.machineFingerprint,
        },
        buyerAccessFingerprint.setCookie ? { headers } : undefined
      );
    } catch (error) {
      logger.error(
        'Failed to create buyer product access verification intent',
        buildBuyerAccessFailureContext(error)
      );
      return Response.json({ error: 'Failed to start verification' }, { status: 500 });
    }
  }

  return {
    getBuyerProductAccess,
    postBuyerProductAccessVerificationIntent,
  };
}
