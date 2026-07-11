import { getProviderDescriptor } from '@yucp/providers/providerMetadata';
import { getSafeRelativeRedirectTarget } from '@yucp/shared';
import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';
import type { Auth } from '../auth';
import { createAuthUserActorBinding } from '../lib/apiActor';
import { getConvexClientFromUrl } from '../lib/convex';
import { rejectCrossSiteRequest } from '../lib/csrf';
import { logger } from '../lib/logger';
import { withApiSpan } from '../lib/observability';
import { providerPlatformService } from '../providers/display';
import type { ConnectConfig } from '../providers/types';
import {
  buildLinkedEntitlementRequirements,
  type HostedVerificationIntentRecord,
  mapHostedVerificationIntentResponse,
  shouldResolveLinkedEntitlementRequirements,
  verifyHostedBuyerProviderLinkIntent,
  verifyHostedManualLicenseIntent,
} from '../verification/hostedIntents';
import { getVerificationConfig } from '../verification/verificationConfig';

interface CreateConnectUserVerificationRoutesOptions {
  auth: Auth;
  config: ConnectConfig;
  isTenantOwnedBySessionUser: (
    request: Request,
    sessionUserId: string,
    profileAuthUserId: string
  ) => Promise<boolean>;
}

export function createConnectUserVerificationRoutes({
  auth,
  config,
  isTenantOwnedBySessionUser,
}: CreateConnectUserVerificationRoutesOptions) {
  function getAllowedOrigins(): Set<string> {
    return new Set([new URL(config.apiBaseUrl).origin, new URL(config.frontendBaseUrl).origin]);
  }

  function jsonNoStore(body: unknown, init?: ResponseInit): Response {
    const headers = new Headers(init?.headers);
    headers.set('Cache-Control', 'private, no-store');
    return Response.json(body, {
      ...init,
      headers,
    });
  }

  async function requireSessionActor(request: Request): Promise<
    | {
        authUserId: string;
        convex: ReturnType<typeof getConvexClientFromUrl>;
      }
    | Response
  > {
    const session = await auth.getSession(request);
    if (!session) {
      return Response.json({ error: 'Authentication required' }, { status: 401 });
    }

    const actor = await createAuthUserActorBinding({
      authUserId: session.user.id,
      source: 'session',
    });

    return {
      authUserId: session.user.id,
      convex: getConvexClientFromUrl(config.convexUrl, actor),
    };
  }

  async function reconcileBuyerVerificationAccounts(
    convex: ReturnType<typeof getConvexClientFromUrl>,
    authUserId: string
  ) {
    return withApiSpan(
      'verification.accounts.reconcile',
      {
        authUserId,
        verificationFlow: 'buyer-provider-links',
      },
      async () => {
        await convex.mutation(api.subjects.reconcileBuyerProviderLinksForAuthUser, {
          apiSecret: config.convexApiSecret,
          authUserId,
        });
        const links = await convex.query(api.subjects.listBuyerProviderLinksForAuthUser, {
          apiSecret: config.convexApiSecret,
          authUserId,
        });
        return links;
      }
    );
  }

  async function ensureLinkedEntitlementRequirements(
    convex: ReturnType<typeof getConvexClientFromUrl>,
    intent: HostedVerificationIntentRecord,
    authUserId: string
  ): Promise<HostedVerificationIntentRecord> {
    return withApiSpan(
      'verification.intent.requirements.resolve',
      {
        authUserId,
        intentId: String(intent._id),
        requirementCount: intent.requirements.length,
      },
      async () => {
        const links = await reconcileBuyerVerificationAccounts(convex, authUserId);
        const activeProviders = links
          .filter((link: (typeof links)[number]) => link.status === 'active')
          .map((link: (typeof links)[number]) => link.provider);
        const derivedRequirements = buildLinkedEntitlementRequirements(
          intent,
          activeProviders,
          async (requirement) => {
            if (!requirement.providerProductRef) {
              return null;
            }

            const product = await convex.query(api.yucpLicenses.lookupProductByProviderRef, {
              apiSecret: config.convexApiSecret,
              provider: requirement.providerKey,
              providerProductRef: requirement.providerProductRef,
            });

            if (!product) {
              return null;
            }

            return {
              creatorAuthUserId: product.authUserId,
              productId: product.productId,
            };
          }
        );
        const resolvedRequirements = await derivedRequirements;
        if (resolvedRequirements.length === 0) {
          return intent;
        }

        await convex.mutation(api.verificationIntents.appendVerificationIntentRequirements, {
          apiSecret: config.convexApiSecret,
          authUserId,
          intentId: intent._id,
          requirements: resolvedRequirements,
        });

        return {
          ...intent,
          requirements: [...intent.requirements, ...resolvedRequirements],
        };
      }
    );
  }

  async function getUserConnections(request: Request): Promise<Response> {
    const session = await auth.getSession(request);
    if (!session) {
      return Response.json({ error: 'Authentication required' }, { status: 401 });
    }

    const url = new URL(request.url);
    const requestedAuthUserId = url.searchParams.get('authUserId');
    const authUserId = requestedAuthUserId ?? session.user.id;

    try {
      if (requestedAuthUserId) {
        const tenantOwned = await isTenantOwnedBySessionUser(
          request,
          session.user.id,
          requestedAuthUserId
        );
        if (!tenantOwned) {
          return Response.json({ error: 'Forbidden' }, { status: 403 });
        }
      }

      const convex = getConvexClientFromUrl(config.convexUrl);
      const connections = await convex.query(api.providerConnections.listConnectionsForUser, {
        apiSecret: config.convexApiSecret,
        authUserId,
      });
      return Response.json({ connections });
    } catch (err) {
      logger.error('Failed to get user connections', {
        error: err instanceof Error ? err.message : String(err),
      });
      return Response.json({ error: 'Failed to fetch connections' }, { status: 500 });
    }
  }

  async function getUserAccounts(request: Request): Promise<Response> {
    const viewer = await requireSessionActor(request);
    if (viewer instanceof Response) {
      return viewer;
    }
    try {
      const links = await viewer.convex.query(api.subjects.listBuyerProviderLinksForAuthUser, {
        apiSecret: config.convexApiSecret,
        authUserId: viewer.authUserId,
      });
      return jsonNoStore({
        connections: links.map((link: (typeof links)[number]) => ({
          id: String(link.id),
          provider: link.provider,
          label: link.label,
          connectionType: 'verification',
          status: link.status,
          webhookConfigured: false,
          hasApiKey: false,
          hasAccessToken: false,
          providerUserId: link.providerUserId,
          providerUsername: link.providerUsername ?? null,
          verificationMethod: link.verificationMethod ?? null,
          providerDisplay: providerPlatformService.getConnectedAccountProviderDisplay(
            link.provider
          ),
          linkedAt: link.linkedAt,
          lastValidatedAt: link.lastValidatedAt ?? null,
          expiresAt: link.expiresAt ?? null,
          createdAt: link.createdAt,
          updatedAt: link.updatedAt,
        })),
      });
    } catch (err) {
      logger.error('Failed to get user accounts', {
        error: err instanceof Error ? err.message : String(err),
      });
      return Response.json({ error: 'Failed to fetch accounts' }, { status: 500 });
    }
  }

  async function refreshUserAccounts(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return Response.json({ error: 'Method not allowed' }, { status: 405 });
    }
    const csrfBlock = rejectCrossSiteRequest(request, getAllowedOrigins());
    if (csrfBlock) {
      return csrfBlock;
    }
    const viewer = await requireSessionActor(request);
    if (viewer instanceof Response) {
      return viewer;
    }
    try {
      const links = await reconcileBuyerVerificationAccounts(viewer.convex, viewer.authUserId);
      return jsonNoStore({
        connections: links.map((link: (typeof links)[number]) => ({
          id: String(link.id),
          provider: link.provider,
          label: link.label,
          connectionType: 'verification',
          status: link.status,
          webhookConfigured: false,
          hasApiKey: false,
          hasAccessToken: false,
          providerUserId: link.providerUserId,
          providerUsername: link.providerUsername ?? null,
          verificationMethod: link.verificationMethod ?? null,
          providerDisplay: providerPlatformService.getConnectedAccountProviderDisplay(
            link.provider
          ),
          linkedAt: link.linkedAt,
          lastValidatedAt: link.lastValidatedAt ?? null,
          expiresAt: link.expiresAt ?? null,
          createdAt: link.createdAt,
          updatedAt: link.updatedAt,
        })),
      });
    } catch (err) {
      logger.error('Failed to refresh user accounts', {
        error: err instanceof Error ? err.message : String(err),
      });
      return Response.json({ error: 'Failed to refresh accounts' }, { status: 500 });
    }
  }

  async function deleteUserAccount(request: Request): Promise<Response> {
    if (request.method !== 'DELETE') {
      return Response.json({ error: 'Method not allowed' }, { status: 405 });
    }
    const csrfBlock = rejectCrossSiteRequest(request, getAllowedOrigins());
    if (csrfBlock) {
      return csrfBlock;
    }
    const viewer = await requireSessionActor(request);
    if (viewer instanceof Response) {
      return viewer;
    }
    const url = new URL(request.url);
    const id = url.searchParams.get('id');
    if (!id) {
      return Response.json({ error: 'id is required' }, { status: 400 });
    }
    try {
      const result = await viewer.convex.mutation(api.subjects.revokeBuyerProviderLink, {
        apiSecret: config.convexApiSecret,
        authUserId: viewer.authUserId,
        linkId: id as Id<'buyer_provider_links'>,
      });
      if (!result.success) {
        return Response.json({ error: 'Account link not found' }, { status: 404 });
      }
      return Response.json({ success: true });
    } catch (err) {
      logger.error('Failed to delete user account', {
        error: err instanceof Error ? err.message : String(err),
      });
      return Response.json({ error: 'Failed to disconnect account' }, { status: 500 });
    }
  }

  function getUserProviders(_request: Request): Response {
    return Response.json({
      providers: providerPlatformService.listHostedVerificationProviderDisplays(),
    });
  }

  async function postUserVerifyStart(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return Response.json({ error: 'Method not allowed' }, { status: 405 });
    }
    const session = await auth.getSession(request);
    if (!session) {
      return Response.json({ error: 'Authentication required' }, { status: 401 });
    }

    let body: { providerKey?: string; returnUrl?: string } = {};
    try {
      body = (await request.json()) as { providerKey?: string };
    } catch {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const { providerKey } = body;
    if (!providerKey) {
      return Response.json({ error: 'providerKey is required' }, { status: 400 });
    }

    try {
      const safeReturnUrl = getSafeRelativeRedirectTarget(body.returnUrl) ?? '/account/connections';
      const frontendReturnUrl = `${config.frontendBaseUrl.replace(/\/$/, '')}${safeReturnUrl}`;
      const descriptor = getProviderDescriptor(providerKey);
      const oauthConfig =
        descriptor?.supportsBuyerOAuthLink === true ? getVerificationConfig(providerKey) : null;
      if (!oauthConfig) {
        return Response.json(
          { error: `Provider '${providerKey}' does not support user identity linking` },
          { status: 400 }
        );
      }

      const beginUrl = new URL('/api/verification/begin', config.frontendBaseUrl);
      beginUrl.searchParams.set('authUserId', session.user.id);
      beginUrl.searchParams.set('mode', providerKey);
      beginUrl.searchParams.set('verificationMethod', 'account_link');
      beginUrl.searchParams.set('redirectUri', frontendReturnUrl);

      try {
        const convex = getConvexClientFromUrl(config.convexUrl);
        const discordUserId = await convex.query(api.authViewer.getDiscordUserIdByAuthUser, {
          apiSecret: config.convexApiSecret,
          authUserId: session.user.id,
        });
        if (discordUserId) {
          beginUrl.searchParams.set('discordUserId', discordUserId);
        }
      } catch (lookupErr) {
        logger.warn(
          'Could not resolve discordUserId for verification begin; subject linking may be degraded',
          {
            authUserId: session.user.id,
            error: lookupErr instanceof Error ? lookupErr.message : String(lookupErr),
          }
        );
      }

      return Response.json({
        redirectUrl: `${beginUrl.pathname}${beginUrl.search}`,
      });
    } catch (err) {
      logger.error('Failed to start user verify session', {
        providerKey,
        error: err instanceof Error ? err.message : String(err),
      });
      return Response.json({ error: 'Failed to start verification session' }, { status: 500 });
    }
  }

  async function getUserVerificationIntent(request: Request, intentId: string): Promise<Response> {
    const viewer = await requireSessionActor(request);
    if (viewer instanceof Response) {
      return viewer;
    }

    try {
      logger.info('Hosted verification intent fetch requested', {
        intentId,
        authUserId: viewer.authUserId,
      });
      const storedIntent = await viewer.convex.action(
        api.verificationIntents.getVerificationIntent,
        {
          apiSecret: config.convexApiSecret,
          authUserId: viewer.authUserId,
          intentId: intentId as Id<'verification_intents'>,
        }
      );
      const intent =
        storedIntent && shouldResolveLinkedEntitlementRequirements(storedIntent)
          ? await ensureLinkedEntitlementRequirements(
              viewer.convex,
              storedIntent as HostedVerificationIntentRecord,
              viewer.authUserId
            )
          : storedIntent;
      if (!intent) {
        const diagnostic = await viewer.convex.query(
          api.verificationIntents.getIntentAccessDiagnostic,
          {
            apiSecret: config.convexApiSecret,
            intentId: intentId as Id<'verification_intents'>,
          }
        );

        if (!diagnostic) {
          logger.warn('Hosted verification intent fetch missed missing record', {
            intentId,
            authUserId: viewer.authUserId,
          });
          return Response.json(
            { error: 'Verification intent not found', code: 'verification_intent_missing' },
            { status: 404 }
          );
        }

        if (diagnostic.authUserId !== viewer.authUserId) {
          logger.warn('Hosted verification intent belongs to different user', {
            intentId,
            authUserId: viewer.authUserId,
            ownerAuthUserId: diagnostic.authUserId,
            status: diagnostic.status,
            expiresAt: diagnostic.expiresAt,
            packageId: diagnostic.packageId,
          });
          return Response.json(
            {
              error:
                'This verification link was created for a different YUCP account. Sign out here, then continue with the same YUCP account you used in Unity.',
              code: 'verification_intent_wrong_user',
            },
            { status: 409 }
          );
        }

        logger.warn('Hosted verification intent fetch returned null despite matching owner', {
          intentId,
          authUserId: viewer.authUserId,
          status: diagnostic.status,
          expiresAt: diagnostic.expiresAt,
          packageId: diagnostic.packageId,
        });
        return Response.json(
          { error: 'Verification intent not found', code: 'verification_intent_missing' },
          { status: 404 }
        );
      }
      logger.info('Hosted verification intent fetch succeeded', {
        intentId,
        authUserId: viewer.authUserId,
        status: intent.status,
      });
      return Response.json(
        mapHostedVerificationIntentResponse(
          intent as HostedVerificationIntentRecord,
          config.frontendBaseUrl
        )
      );
    } catch (err) {
      logger.error('Failed to fetch user verification intent', {
        intentId,
        error: err instanceof Error ? err.message : String(err),
      });
      return Response.json({ error: 'Failed to fetch verification intent' }, { status: 500 });
    }
  }

  async function postUserVerificationEntitlement(
    request: Request,
    intentId: string
  ): Promise<Response> {
    if (request.method !== 'POST') {
      return Response.json({ error: 'Method not allowed' }, { status: 405 });
    }
    const csrfBlock = rejectCrossSiteRequest(request, getAllowedOrigins());
    if (csrfBlock) {
      return csrfBlock;
    }
    const viewer = await requireSessionActor(request);
    if (viewer instanceof Response) {
      return viewer;
    }

    let body: { methodKey?: string } = {};
    try {
      body = (await request.json()) as { methodKey?: string };
    } catch {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    if (!body.methodKey) {
      return Response.json({ error: 'methodKey is required' }, { status: 400 });
    }

    try {
      logger.info('Hosted entitlement verification requested', {
        intentId,
        authUserId: viewer.authUserId,
        methodKey: body.methodKey,
      });
      const storedIntent = await viewer.convex.action(
        api.verificationIntents.getVerificationIntent,
        {
          apiSecret: config.convexApiSecret,
          authUserId: viewer.authUserId,
          intentId: intentId as Id<'verification_intents'>,
        }
      );
      if (storedIntent && shouldResolveLinkedEntitlementRequirements(storedIntent)) {
        await ensureLinkedEntitlementRequirements(
          viewer.convex,
          storedIntent as HostedVerificationIntentRecord,
          viewer.authUserId
        );
      }
      const result = await viewer.convex.action(
        api.verificationIntents.verifyIntentWithExistingEntitlement,
        {
          apiSecret: config.convexApiSecret,
          authUserId: viewer.authUserId,
          intentId: intentId as Id<'verification_intents'>,
          methodKey: body.methodKey,
        }
      );
      if (!result.success) {
        logger.warn('Hosted entitlement verification rejected', {
          intentId,
          authUserId: viewer.authUserId,
          methodKey: body.methodKey,
          code: result.errorCode,
        });
        return Response.json(
          {
            error: result.errorMessage ?? 'Entitlement verification failed',
            code: result.errorCode,
          },
          { status: 422 }
        );
      }
      logger.info('Hosted entitlement verification succeeded', {
        intentId,
        authUserId: viewer.authUserId,
        methodKey: body.methodKey,
      });
      return Response.json({ success: true });
    } catch (err) {
      logger.error('Failed to verify hosted entitlement intent', {
        intentId,
        error: err instanceof Error ? err.message : String(err),
      });
      return Response.json({ error: 'Failed to verify entitlement' }, { status: 500 });
    }
  }

  async function postUserVerificationManualLicense(
    request: Request,
    intentId: string
  ): Promise<Response> {
    if (request.method !== 'POST') {
      return Response.json({ error: 'Method not allowed' }, { status: 405 });
    }
    const csrfBlock = rejectCrossSiteRequest(request, getAllowedOrigins());
    if (csrfBlock) {
      return csrfBlock;
    }
    const viewer = await requireSessionActor(request);
    if (viewer instanceof Response) {
      return viewer;
    }

    let body: { methodKey?: string; licenseKey?: string } = {};
    try {
      body = (await request.json()) as { methodKey?: string; licenseKey?: string };
    } catch {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    if (!body.methodKey || !body.licenseKey) {
      return Response.json({ error: 'methodKey and licenseKey are required' }, { status: 400 });
    }

    try {
      const result = await verifyHostedManualLicenseIntent({
        convex: viewer.convex,
        apiSecret: config.convexApiSecret,
        encryptionSecret: config.encryptionSecret,
        authUserId: viewer.authUserId,
        intentId: intentId as Id<'verification_intents'>,
        methodKey: body.methodKey,
        licenseKey: body.licenseKey,
      });
      if (!result.success) {
        return Response.json(
          { error: result.errorMessage ?? 'License verification failed', code: result.errorCode },
          { status: 422 }
        );
      }
      return Response.json({ success: true });
    } catch (err) {
      logger.error('Failed to verify hosted manual license intent', {
        intentId,
        error: err instanceof Error ? err.message : String(err),
      });
      return Response.json({ error: 'Failed to verify license' }, { status: 500 });
    }
  }

  async function postUserVerificationProviderLink(
    request: Request,
    intentId: string
  ): Promise<Response> {
    if (request.method !== 'POST') {
      return Response.json({ error: 'Method not allowed' }, { status: 405 });
    }
    const csrfBlock = rejectCrossSiteRequest(request, getAllowedOrigins());
    if (csrfBlock) {
      return csrfBlock;
    }
    const viewer = await requireSessionActor(request);
    if (viewer instanceof Response) {
      return viewer;
    }

    let body: { methodKey?: string } = {};
    try {
      body = (await request.json()) as { methodKey?: string };
    } catch {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    if (!body.methodKey) {
      return Response.json({ error: 'methodKey is required' }, { status: 400 });
    }

    try {
      logger.info('Hosted provider link verification requested', {
        intentId,
        authUserId: viewer.authUserId,
        methodKey: body.methodKey,
      });
      const result = await verifyHostedBuyerProviderLinkIntent({
        convex: viewer.convex,
        apiSecret: config.convexApiSecret,
        encryptionSecret: config.encryptionSecret,
        authUserId: viewer.authUserId,
        intentId: intentId as Id<'verification_intents'>,
        methodKey: body.methodKey,
      });
      if (!result.success) {
        logger.warn('Hosted provider link verification rejected', {
          intentId,
          authUserId: viewer.authUserId,
          methodKey: body.methodKey,
          code: result.errorCode,
        });
        return Response.json(
          {
            error: result.errorMessage ?? 'Provider link verification failed',
            code: result.errorCode,
          },
          { status: 422 }
        );
      }
      logger.info('Hosted provider link verification succeeded', {
        intentId,
        authUserId: viewer.authUserId,
        methodKey: body.methodKey,
      });
      return Response.json({ success: true });
    } catch (err) {
      logger.error('Failed to verify hosted buyer provider link intent', {
        intentId,
        error: err instanceof Error ? err.message : String(err),
      });
      return Response.json({ error: 'Failed to verify provider link' }, { status: 500 });
    }
  }

  return {
    getUserConnections,
    getUserAccounts,
    refreshUserAccounts,
    deleteUserAccount,
    getUserProviders,
    postUserVerifyStart,
    getUserVerificationIntent,
    postUserVerificationEntitlement,
    postUserVerificationManualLicense,
    postUserVerificationProviderLink,
  };
}
