import type { StructuredLogger } from '@yucp/shared';
import { api } from '../../../../convex/_generated/api';
import {
  toCertificateBillingProjectionBenefitGrant,
  toCertificateBillingProjectionMeter,
  toCertificateBillingProjectionSubscription,
} from '../../../../convex/lib/certificateBillingProjection';
import { type Auth, BetterAuthEndpointError } from '../auth';
import { getConvexClientFromUrl } from '../lib/convex';
import { fetchCertificateBillingCustomerStateByExternalId } from '../lib/polar';
import { buildTimedResponse, RouteTimingCollector } from '../lib/requestTiming';
import type { ConnectConfig } from '../providers/types';
import {
  parseCertificatePlanSelectionBody,
  parseCertificateRevokeBody,
} from './connectCertificateRouteSupport';

interface CertificateOverview {
  workspaceKey: string;
  creatorProfileId?: string;
  billing: {
    billingEnabled: boolean;
    status: string;
    allowEnrollment: boolean;
    allowSigning: boolean;
    planKey?: string;
    productId?: string;
    deviceCap?: number;
    activeDeviceCount: number;
    signQuotaPerPeriod?: number;
    auditRetentionDays?: number;
    supportTier?: string;
    currentPeriodEnd?: number;
    graceUntil?: number;
    reason?: string;
    capabilities: Array<{
      capabilityKey: string;
      status: string;
    }>;
  };
  devices: Array<{
    certNonce: string;
    devPublicKey: string;
    publisherId: string;
    publisherName: string;
    issuedAt: number;
    expiresAt: number;
    status: string;
  }>;
  availablePlans: Array<{
    planKey: string;
    slug: string;
    productId: string;
    displayName: string;
    description?: string;
    highlights: string[];
    priority: number;
    displayBadge?: string;
    deviceCap: number;
    signQuotaPerPeriod?: number;
    auditRetentionDays: number;
    supportTier: string;
    billingGraceDays: number;
    capabilities: string[];
    meteredPrices: Array<{
      priceId: string;
      meterId: string;
      meterName: string;
    }>;
  }>;
  meters: Array<{
    meterId: string;
    meterName?: string;
    consumedUnits: number;
    creditedUnits: number;
    balance: number;
  }>;
}

interface ConnectCertificateRoutesOptions {
  readonly auth: Auth;
  readonly config: ConnectConfig;
  readonly logger: StructuredLogger;
}

function isPolarAccessTokenFailure(error: unknown): error is BetterAuthEndpointError {
  if (!(error instanceof BetterAuthEndpointError)) {
    return false;
  }

  const bodyValue =
    error.body && typeof error.body === 'object'
      ? JSON.stringify(error.body)
      : String(error.body ?? '');
  const haystack = `${error.message}\n${error.bodyText}\n${bodyValue}`.toLowerCase();

  return (
    haystack.includes('invalid_token') ||
    haystack.includes('access token provided is expired') ||
    haystack.includes('expired, revoked, malformed') ||
    haystack.includes('status 401')
  );
}

function createPolarAccessTokenFailureResponse(): Response {
  return Response.json(
    {
      error:
        'Certificate billing is temporarily unavailable because the configured Polar organization access token is invalid, expired, or for the wrong Polar environment. Update POLAR_ACCESS_TOKEN and POLAR_SERVER, then try again.',
      code: 'polar_access_token_invalid',
    },
    { status: 503 }
  );
}

async function ensureCertificateBillingCatalogFresh(
  convex: ReturnType<typeof getConvexClientFromUrl>,
  apiSecret: string,
  timing?: RouteTimingCollector
) {
  const ensureCatalog = () =>
    convex.action(api.certificateBillingSync.ensureCatalogFresh, {
      apiSecret,
    });

  if (timing) {
    await timing.measure(
      'convex_certificate_catalog',
      ensureCatalog,
      'ensure Polar certificate catalog cache'
    );
    return;
  }

  await ensureCatalog();
}

async function reconcileCertificateBillingCustomerStateForAuthUser(
  convex: ReturnType<typeof getConvexClientFromUrl>,
  apiSecret: string,
  authUserId: string,
  timing?: RouteTimingCollector
): Promise<boolean> {
  const state = timing
    ? await timing.measure(
        'provider_polar_customer_state',
        () => fetchCertificateBillingCustomerStateByExternalId(authUserId),
        'fetch Polar customer state'
      )
    : await fetchCertificateBillingCustomerStateByExternalId(authUserId);

  if (!state) {
    return false;
  }

  const projectCustomerState = () =>
    convex.mutation(api.certificateBilling.projectCustomerStateForApi, {
      apiSecret,
      authUserId,
      polarCustomerId: state.id,
      customerEmail: state.email,
      activeSubscriptions: state.activeSubscriptions.map(
        toCertificateBillingProjectionSubscription
      ),
      grantedBenefits: state.grantedBenefits.map(toCertificateBillingProjectionBenefitGrant),
      activeMeters: state.activeMeters.map(toCertificateBillingProjectionMeter),
    });

  if (timing) {
    await timing.measure(
      'convex_certificate_project_customer_state',
      projectCustomerState,
      'project Polar customer state'
    );
  } else {
    await projectCustomerState();
  }

  return true;
}

function buildCertificateDashboardUrl(config: ConnectConfig): string {
  return new URL('/dashboard/billing', `${config.frontendBaseUrl.replace(/\/$/, '')}/`).toString();
}

function getCertificateCheckoutEmbedOrigin(config: ConnectConfig): string {
  return new URL(config.frontendBaseUrl).origin;
}

function resolveCertificatePlanSelection(
  overview: CertificateOverview,
  body: { productId?: string; planKey?: string }
) {
  const requestedProductId = body.productId;
  if (requestedProductId) {
    return overview.availablePlans.find((entry) => entry.productId === requestedProductId) ?? null;
  }

  const requestedPlanKey = body.planKey;
  if (!requestedPlanKey) {
    return null;
  }

  return (
    overview.availablePlans.find(
      (entry) => entry.productId === requestedPlanKey || entry.planKey === requestedPlanKey
    ) ?? null
  );
}

export function createConnectCertificateRoutes(options: ConnectCertificateRoutesOptions) {
  const { auth, config, logger } = options;

  async function getUserCertificateOverviewForAuthUser(
    authUserId: string,
    timing?: RouteTimingCollector
  ): Promise<CertificateOverview> {
    const convex = getConvexClientFromUrl(config.convexUrl);
    await ensureCertificateBillingCatalogFresh(convex, config.convexApiSecret, timing);
    const loadOverview = () =>
      convex.query(api.certificateBilling.getAccountOverview, {
        apiSecret: config.convexApiSecret,
        authUserId,
      });
    const overview = (
      timing
        ? await timing.measure(
            'convex_certificate_overview',
            loadOverview,
            'load certificate overview'
          )
        : await loadOverview()
    ) as CertificateOverview;

    const shouldAttemptRecovery =
      overview.billing.billingEnabled &&
      overview.billing.status === 'inactive' &&
      overview.availablePlans.length > 0;
    if (!shouldAttemptRecovery) {
      return overview;
    }

    const reconciled = await reconcileCertificateBillingCustomerStateForAuthUser(
      convex,
      config.convexApiSecret,
      authUserId,
      timing
    );
    if (!reconciled) {
      return overview;
    }

    const refreshedOverview = (
      timing
        ? await timing.measure(
            'convex_certificate_overview_refresh',
            loadOverview,
            'reload certificate overview'
          )
        : await loadOverview()
    ) as CertificateOverview;
    return refreshedOverview;
  }

  async function getUserCertificates(request: Request): Promise<Response> {
    const timing = new RouteTimingCollector();
    const session = await timing.measure(
      'session',
      () => auth.getSession(request),
      'resolve account session'
    );
    if (!session) {
      return buildTimedResponse(
        timing,
        () => Response.json({ error: 'Authentication required' }, { status: 401 }),
        'serialize certificate response'
      );
    }

    try {
      const overview = await getUserCertificateOverviewForAuthUser(session.user.id, timing);
      return buildTimedResponse(
        timing,
        () => Response.json(overview),
        'serialize certificate response'
      );
    } catch (err) {
      if (isPolarAccessTokenFailure(err)) {
        logger.error('Polar credentials rejected certificate workspace reconciliation request', {
          authUserId: session.user.id,
          status: err.status,
          path: err.path,
        });
        return buildTimedResponse(
          timing,
          () => createPolarAccessTokenFailureResponse(),
          'serialize certificate response'
        );
      }

      logger.error('Failed to get certificate workspace overview', {
        authUserId: session.user.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return buildTimedResponse(
        timing,
        () => Response.json({ error: 'Failed to fetch certificate workspace' }, { status: 500 }),
        'serialize certificate response'
      );
    }
  }

  async function getViewerBranding(request: Request): Promise<Response> {
    const timing = new RouteTimingCollector();
    const session = await timing.measure(
      'session',
      () => auth.getSession(request),
      'resolve account session'
    );
    if (!session) {
      return buildTimedResponse(
        timing,
        () => Response.json({ error: 'Authentication required' }, { status: 401 }),
        'serialize certificate response'
      );
    }

    try {
      const branding = await timing.measure(
        'convex_certificate_shell_branding',
        () =>
          getConvexClientFromUrl(config.convexUrl).query(
            api.certificateBilling.getShellBrandingForAuthUser,
            {
              apiSecret: config.convexApiSecret,
              authUserId: session.user.id,
            }
          ),
        'load certificate shell branding'
      );

      return buildTimedResponse(
        timing,
        () => Response.json(branding),
        'serialize certificate response'
      );
    } catch (err) {
      logger.error('Failed to get viewer branding', {
        authUserId: session.user.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return buildTimedResponse(
        timing,
        () => Response.json({ error: 'Failed to fetch viewer branding' }, { status: 500 }),
        'serialize certificate response'
      );
    }
  }

  async function createUserCertificateCheckout(request: Request): Promise<Response> {
    const timing = new RouteTimingCollector();
    if (request.method !== 'POST') {
      return buildTimedResponse(
        timing,
        () => Response.json({ error: 'Method not allowed' }, { status: 405 }),
        'serialize certificate response'
      );
    }

    const session = await timing.measure(
      'session',
      () => auth.getSession(request),
      'resolve account session'
    );
    if (!session) {
      return buildTimedResponse(
        timing,
        () => Response.json({ error: 'Authentication required' }, { status: 401 }),
        'serialize certificate response'
      );
    }

    let body: { productId?: string; planKey?: string };
    try {
      let parsedBody: unknown;
      try {
        parsedBody = await request.json();
      } catch {
        return buildTimedResponse(
          timing,
          () => Response.json({ error: 'Invalid JSON' }, { status: 400 }),
          'serialize certificate response'
        );
      }
      body = parseCertificatePlanSelectionBody(parsedBody);
    } catch (error) {
      return buildTimedResponse(
        timing,
        () =>
          Response.json(
            { error: error instanceof Error ? error.message : 'Invalid request body' },
            { status: 400 }
          ),
        'serialize certificate response'
      );
    }

    try {
      const overview = await getUserCertificateOverviewForAuthUser(session.user.id, timing);
      if (!overview.billing.billingEnabled || overview.availablePlans.length === 0) {
        return buildTimedResponse(
          timing,
          () => Response.json({ error: 'Certificate billing is not configured' }, { status: 503 }),
          'serialize certificate response'
        );
      }

      const plan = resolveCertificatePlanSelection(overview, body);
      if (!plan) {
        return buildTimedResponse(
          timing,
          () => Response.json({ error: 'Unknown certificate product' }, { status: 404 }),
          'serialize certificate response'
        );
      }

      const dashboardUrl = buildCertificateDashboardUrl(config);
      const checkout = await timing.measure(
        'provider_polar_checkout',
        () =>
          auth.createPolarCheckout(request, {
            products: [plan.productId],
            referenceId: overview.workspaceKey,
            externalCustomerId: session.user.id,
            embedOrigin: getCertificateCheckoutEmbedOrigin(config),
            metadata: {
              workspace_key: overview.workspaceKey,
              product_id: plan.productId,
              plan_key: plan.planKey,
            },
            redirect: false,
            successUrl: dashboardUrl,
            returnUrl: dashboardUrl,
          }),
        'create Polar checkout'
      );
      if (!checkout) {
        return buildTimedResponse(
          timing,
          () =>
            Response.json(
              { error: 'Could not initialize certificate checkout for this session' },
              { status: 409 }
            ),
          'serialize certificate response'
        );
      }

      return buildTimedResponse(
        timing,
        () =>
          Response.json({
            url: checkout.url,
            redirect: checkout.redirect,
            workspaceKey: overview.workspaceKey,
            planKey: plan.planKey,
            productId: plan.productId,
          }),
        'serialize certificate response'
      );
    } catch (err) {
      if (isPolarAccessTokenFailure(err)) {
        logger.error('Polar credentials rejected certificate checkout request', {
          authUserId: session.user.id,
          productId: body.productId,
          planKey: body.planKey,
          status: err.status,
          path: err.path,
        });
        return buildTimedResponse(
          timing,
          () => createPolarAccessTokenFailureResponse(),
          'serialize certificate response'
        );
      }

      logger.error('Failed to create certificate checkout', {
        authUserId: session.user.id,
        productId: body.productId,
        planKey: body.planKey,
        error: err instanceof Error ? err.message : String(err),
      });
      return buildTimedResponse(
        timing,
        () => Response.json({ error: 'Failed to create certificate checkout' }, { status: 500 }),
        'serialize certificate response'
      );
    }
  }

  async function reconcileUserCertificateBilling(request: Request): Promise<Response> {
    const timing = new RouteTimingCollector();
    if (request.method !== 'POST') {
      return buildTimedResponse(
        timing,
        () => Response.json({ error: 'Method not allowed' }, { status: 405 }),
        'serialize certificate response'
      );
    }

    const session = await timing.measure(
      'session',
      () => auth.getSession(request),
      'resolve account session'
    );
    if (!session) {
      return buildTimedResponse(
        timing,
        () => Response.json({ error: 'Authentication required' }, { status: 401 }),
        'serialize certificate response'
      );
    }

    try {
      const convex = getConvexClientFromUrl(config.convexUrl);
      await ensureCertificateBillingCatalogFresh(convex, config.convexApiSecret, timing);

      const reconciled = await reconcileCertificateBillingCustomerStateForAuthUser(
        convex,
        config.convexApiSecret,
        session.user.id,
        timing
      );

      const overview = await getUserCertificateOverviewForAuthUser(session.user.id, timing);
      return buildTimedResponse(
        timing,
        () =>
          Response.json({
            reconciled,
            overview,
          }),
        'serialize certificate response'
      );
    } catch (err) {
      logger.error('Failed to reconcile certificate billing state', {
        authUserId: session.user.id,
        error: err instanceof Error ? err.message : String(err),
      });
      const polarErrorCode =
        err && typeof err === 'object' ? (err as { code?: unknown }).code : undefined;
      if (
        isPolarAccessTokenFailure(err) ||
        (err instanceof Error &&
          (err.name === 'PolarAuthError' ||
            polarErrorCode === 'polar_access_token_invalid' ||
            /expired|invalid.*polar/i.test(err.message)))
      ) {
        return buildTimedResponse(
          timing,
          createPolarAccessTokenFailureResponse,
          'serialize certificate response'
        );
      }
      return buildTimedResponse(
        timing,
        () =>
          Response.json(
            { error: 'Failed to reconcile certificate billing state' },
            { status: 500 }
          ),
        'serialize certificate response'
      );
    }
  }

  async function getUserCertificatePortal(request: Request): Promise<Response> {
    const timing = new RouteTimingCollector();
    const session = await timing.measure(
      'session',
      () => auth.getSession(request),
      'resolve account session'
    );
    if (!session) {
      return buildTimedResponse(
        timing,
        () => Response.json({ error: 'Authentication required' }, { status: 401 }),
        'serialize certificate response'
      );
    }

    try {
      const portal = await timing.measure(
        'provider_polar_portal',
        () => auth.createPolarPortal(request, { redirect: false }),
        'create Polar billing portal'
      );
      if (!portal) {
        return buildTimedResponse(
          timing,
          () =>
            Response.json(
              { error: 'No billing portal is available for this account yet' },
              { status: 409 }
            ),
          'serialize certificate response'
        );
      }

      return buildTimedResponse(
        timing,
        () =>
          Response.json({
            url: portal.url,
            redirect: portal.redirect,
          }),
        'serialize certificate response'
      );
    } catch (err) {
      if (isPolarAccessTokenFailure(err)) {
        logger.error('Polar credentials rejected certificate portal request', {
          authUserId: session.user.id,
          status: err.status,
          path: err.path,
        });
        return buildTimedResponse(
          timing,
          () => createPolarAccessTokenFailureResponse(),
          'serialize certificate response'
        );
      }

      logger.error('Failed to create certificate billing portal session', {
        authUserId: session.user.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return buildTimedResponse(
        timing,
        () => Response.json({ error: 'Failed to open billing portal' }, { status: 500 }),
        'serialize certificate response'
      );
    }
  }

  async function revokeUserCertificate(request: Request): Promise<Response> {
    const timing = new RouteTimingCollector();
    if (request.method !== 'POST') {
      return buildTimedResponse(
        timing,
        () => Response.json({ error: 'Method not allowed' }, { status: 405 }),
        'serialize certificate response'
      );
    }

    const session = await timing.measure(
      'session',
      () => auth.getSession(request),
      'resolve account session'
    );
    if (!session) {
      return buildTimedResponse(
        timing,
        () => Response.json({ error: 'Authentication required' }, { status: 401 }),
        'serialize certificate response'
      );
    }

    let body: { certNonce: string };
    try {
      let parsedBody: unknown;
      try {
        parsedBody = await request.json();
      } catch {
        return buildTimedResponse(
          timing,
          () => Response.json({ error: 'Invalid JSON' }, { status: 400 }),
          'serialize certificate response'
        );
      }
      body = parseCertificateRevokeBody(parsedBody);
    } catch (error) {
      return buildTimedResponse(
        timing,
        () =>
          Response.json(
            { error: error instanceof Error ? error.message : 'Invalid request body' },
            { status: 400 }
          ),
        'serialize certificate response'
      );
    }
    const certNonce = body.certNonce;

    try {
      await timing.measure(
        'convex_certificate_revoke',
        () =>
          getConvexClientFromUrl(config.convexUrl).mutation(
            api.certificateBilling.revokeOwnedCertificate,
            {
              apiSecret: config.convexApiSecret,
              authUserId: session.user.id,
              certNonce,
              reason: 'User-initiated device revoke from account portal',
            }
          ),
        'revoke certificate device'
      );
      return buildTimedResponse(
        timing,
        () => Response.json({ success: true }),
        'serialize certificate response'
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('Unauthorized')) {
        return buildTimedResponse(
          timing,
          () => Response.json({ error: 'Not authorized to revoke this device' }, { status: 403 }),
          'serialize certificate response'
        );
      }
      if (message.includes('not found')) {
        return buildTimedResponse(
          timing,
          () => Response.json({ error: 'Certificate device not found' }, { status: 404 }),
          'serialize certificate response'
        );
      }
      logger.error('Failed to revoke certificate device', {
        authUserId: session.user.id,
        certNonce: body.certNonce,
        error: message,
      });
      return buildTimedResponse(
        timing,
        () => Response.json({ error: 'Failed to revoke certificate device' }, { status: 500 }),
        'serialize certificate response'
      );
    }
  }

  return {
    getUserCertificates,
    getViewerBranding,
    createUserCertificateCheckout,
    reconcileUserCertificateBilling,
    getUserCertificatePortal,
    revokeUserCertificate,
  };
}
