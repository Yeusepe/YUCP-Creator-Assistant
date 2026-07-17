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
import { createApiServiceActorBinding, createAuthUserActorBinding } from '../lib/apiActor';
import { buildCookie, getCookieValue } from '../lib/browserSessions';
import { getConvexClientFromUrl } from '../lib/convex';
import { rejectCrossSiteRequest } from '../lib/csrf';
import { logger } from '../lib/logger';
import { RequestBodyError, readJsonObjectBodyWithLimit } from '../lib/requestBody';
import type { ConnectConfig } from '../providers/types';
import {
  type HostedVerificationIntentRecord,
  mapHostedVerificationIntentResponse,
  normalizeHostedVerificationRequirements,
  type VerificationIntentRequirementInput,
} from '../verification/hostedIntents';
import { getVerificationConfig } from '../verification/verificationConfig';

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
};

function getAllowedOrigins(config: ConnectConfig): Set<string> {
  return new Set([new URL(config.apiBaseUrl).origin, new URL(config.frontendBaseUrl).origin]);
}

const BUYER_ACCESS_MACHINE_COOKIE = 'yucp_buyer_access_machine';
const BUYER_ACCESS_MACHINE_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const BUYER_ACCESS_MACHINE_FINGERPRINT_PATTERN = /^buyer-access-web:[0-9a-f]{32}$/;
const BUYER_ACCESS_VERIFICATION_INTENT_BODY_MAX_BYTES = 4096;

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

  if (
    descriptor?.buyerVerificationMethods.includes('account_link') &&
    descriptor.supportsBuyerOAuthLink === true &&
    Boolean(getVerificationConfig(product.provider))
  ) {
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
      creatorAuthUserId: product.creatorAuthUserId,
      productId: product.productId,
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
    const actor = await createApiServiceActorBinding({
      service: 'buyer-product-access',
      scopes: ['creator:delegate'],
    });
    const convex = getConvexClientFromUrl(config.convexUrl, actor);
    return (await convex.query(api.packageRegistry.getBuyerAccessContextByCatalogProductId, {
      apiSecret: config.convexApiSecret,
      actor,
      catalogProductId: catalogProductId as Id<'product_catalog'>,
    })) as BuyerAccessCatalogProduct | null;
  }

  async function getBuyerProductAccess(
    request: Request,
    catalogProductId: string
  ): Promise<Response> {
    const session = await auth.getSession(request);

    try {
      const buyerActor = session
        ? await createAuthUserActorBinding({
            authUserId: session.user.id,
            source: 'session',
          })
        : null;
      const buyerConvex = buyerActor ? getConvexClientFromUrl(config.convexUrl, buyerActor) : null;
      const product = await resolveAccessProduct(catalogProductId);
      if (!product) {
        return Response.json({ error: 'Product access page not found' }, { status: 404 });
      }

      const buyerSubjects = session
        ? ((await buyerConvex?.query(api.subjects.listByAuthUser, {
            apiSecret: config.convexApiSecret,
            actor: buyerActor,
            authUserId: session.user.id,
            status: 'active',
            limit: 1,
          })) as { data: Array<{ _id: Id<'subjects'> }> } | null)
        : null;
      const buyerSubject = buyerSubjects?.data[0] ?? null;
      const entitlementsResult =
        session && buyerSubject
          ? await (async () => {
              const entitlementActor = await createApiServiceActorBinding({
                service: 'api-server',
                scopes: ['creator:delegate'],
              });
              const entitlementConvex = getConvexClientFromUrl(config.convexUrl, entitlementActor);
              return await entitlementConvex.query(api.entitlements.listByAuthUser, {
                apiSecret: config.convexApiSecret,
                actor: entitlementActor,
                authUserId: product.creatorAuthUserId,
                subjectId: buyerSubject._id,
                productId: product.productId,
                status: 'active',
                limit: 20,
              });
            })()
          : { data: [] };
      const activeEntitlement =
        entitlementsResult.data?.find(
          (entitlement: { catalogProductId?: Id<'product_catalog'> | null }) =>
            !entitlement.catalogProductId ||
            String(entitlement.catalogProductId) === String(product.catalogProductId)
        ) ?? null;

      return jsonNoStore({
        product: {
          catalogProductId: String(product.catalogProductId),
          displayName: product.displayName ?? product.productId,
          canonicalSlug: product.canonicalSlug ?? null,
          thumbnailUrl: product.thumbnailUrl ?? null,
          provider: product.provider,
          providerLabel: providerLabel(product.provider),
          storefrontUrl: buildCatalogProductUrl(product.provider, product.providerProductRef),
        },
        accessState: {
          hasActiveEntitlement: Boolean(activeEntitlement),
          requiresVerification: !activeEntitlement,
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
      const packageId = product.productId;
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
