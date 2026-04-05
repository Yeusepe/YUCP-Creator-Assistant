import type { StructuredLogger } from '@yucp/shared';
import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';
import type { Auth } from '../auth';
import { getConvexClientFromUrl } from '../lib/convex';
import type { ConnectConfig } from '../providers/types';
import { PUBLIC_API_KEY_METADATA_KIND, parsePublicApiKeyMetadata } from './connectApiAccessShared';

type ConvexClient = ReturnType<typeof getConvexClientFromUrl>;

type RunProviderDisconnectHook = (
  convex: ConvexClient,
  connectionId: string,
  authUserId: string
) => Promise<void>;

interface ConnectUserAccountRoutesOptions {
  readonly auth: Auth;
  readonly config: ConnectConfig;
  readonly logger: StructuredLogger;
  readonly runProviderDisconnectHook: RunProviderDisconnectHook;
}

async function listAllSubjectsForAuthUser(
  convex: ConvexClient,
  apiSecret: string,
  authUserId: string
) {
  const subjects: Array<{
    _id: string;
    displayName?: string;
    status: string;
    primaryDiscordUserId?: string;
  }> = [];
  let cursor: string | null | undefined;

  for (;;) {
    const result = await convex.query(api.subjects.listByAuthUser, {
      apiSecret,
      authUserId,
      limit: 100,
      cursor: cursor ?? undefined,
    });
    subjects.push(...(result.data ?? []));

    if (!result.hasMore || !result.nextCursor) {
      return subjects;
    }

    cursor = result.nextCursor;
  }
}

async function listAllEntitlementsForSubject(
  convex: ConvexClient,
  apiSecret: string,
  authUserId: string,
  subjectId: string
) {
  const entitlements: Array<{
    id: string;
    sourceProvider: string;
    productId: string;
    sourceReference?: string;
    status: string;
    grantedAt: number;
    revokedAt?: number | null;
  }> = [];
  let cursor: string | null | undefined;

  for (;;) {
    const result = await convex.query(api.entitlements.listByAuthUser, {
      apiSecret,
      authUserId,
      subjectId,
      limit: 100,
      cursor: cursor ?? undefined,
    });
    entitlements.push(...(result.data ?? []));

    if (!result.hasMore || !result.nextCursor) {
      return entitlements;
    }

    cursor = result.nextCursor;
  }
}

export function createConnectUserAccountRoutes(options: ConnectUserAccountRoutesOptions) {
  const { auth, config, logger, runProviderDisconnectHook } = options;

  async function revokeUserEntitlement(request: Request, entitlementId: string): Promise<Response> {
    if (request.method !== 'DELETE') {
      return Response.json({ error: 'Method not allowed' }, { status: 405 });
    }
    const session = await auth.getSession(request);
    if (!session) {
      return Response.json({ error: 'Authentication required' }, { status: 401 });
    }
    if (!entitlementId) {
      return Response.json({ error: 'entitlementId is required' }, { status: 400 });
    }
    try {
      const convex = getConvexClientFromUrl(config.convexUrl);
      await convex.mutation(api.entitlements.revokeEntitlement, {
        apiSecret: config.convexApiSecret,
        authUserId: session.user.id,
        entitlementId: entitlementId as Id<'entitlements'>,
        reason: 'manual',
        details: 'User-initiated deactivation from account portal',
      });
      return Response.json({ success: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Unauthorized') || msg.includes('not the owner')) {
        return Response.json(
          { error: 'Not authorized to revoke this entitlement' },
          { status: 403 }
        );
      }
      logger.error('Failed to revoke entitlement', {
        entitlementId,
        error: msg,
      });
      return Response.json({ error: 'Failed to revoke entitlement' }, { status: 500 });
    }
  }

  async function getUserOAuthGrants(request: Request): Promise<Response> {
    const session = await auth.getSession(request);
    if (!session) {
      return Response.json({ error: 'Authentication required' }, { status: 401 });
    }
    try {
      const convex = getConvexClientFromUrl(config.convexUrl);
      const grants = await convex.query(api.userPortal.listOAuthGrantsForUser, {
        apiSecret: config.convexApiSecret,
        authUserId: session.user.id,
      });
      return Response.json({ grants });
    } catch (err) {
      logger.error('Failed to get user OAuth grants', {
        error: err instanceof Error ? err.message : String(err),
      });
      return Response.json({ error: 'Failed to fetch authorized apps' }, { status: 500 });
    }
  }

  async function revokeUserOAuthGrant(request: Request, consentId: string): Promise<Response> {
    if (request.method !== 'DELETE') {
      return Response.json({ error: 'Method not allowed' }, { status: 405 });
    }
    const session = await auth.getSession(request);
    if (!session) {
      return Response.json({ error: 'Authentication required' }, { status: 401 });
    }
    if (!consentId) {
      return Response.json({ error: 'consentId is required' }, { status: 400 });
    }
    try {
      const convex = getConvexClientFromUrl(config.convexUrl);
      await convex.mutation(api.userPortal.revokeOAuthGrant, {
        apiSecret: config.convexApiSecret,
        authUserId: session.user.id,
        consentId,
      });
      return Response.json({ success: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Unauthorized') || msg.includes('not belong')) {
        return Response.json({ error: 'Not authorized to revoke this grant' }, { status: 403 });
      }
      if (msg.includes('not found')) {
        return Response.json({ error: 'OAuth grant not found' }, { status: 404 });
      }
      logger.error('Failed to revoke OAuth grant', {
        consentId,
        error: msg,
      });
      return Response.json({ error: 'Failed to revoke authorized app' }, { status: 500 });
    }
  }

  async function getUserDataExport(request: Request): Promise<Response> {
    const session = await auth.getSession(request);
    if (!session) {
      return Response.json({ error: 'Authentication required' }, { status: 401 });
    }
    try {
      const convex = getConvexClientFromUrl(config.convexUrl);

      const [subjectsResult, connectionsResult, grantsResult] = await Promise.all([
        listAllSubjectsForAuthUser(convex, config.convexApiSecret, session.user.id),
        convex.query(api.providerConnections.listConnectionsForUser, {
          apiSecret: config.convexApiSecret,
          authUserId: session.user.id,
        }),
        convex.query(api.userPortal.listOAuthGrantsForUser, {
          apiSecret: config.convexApiSecret,
          authUserId: session.user.id,
        }),
      ]);

      const subjectsWithEntitlements = await Promise.all(
        subjectsResult.map(
          async (subject: {
            _id: string;
            displayName?: string;
            status: string;
            primaryDiscordUserId?: string;
          }) => {
            const entitlementsResult = await listAllEntitlementsForSubject(
              convex,
              config.convexApiSecret,
              session.user.id,
              subject._id
            );
            return {
              id: subject._id,
              displayName: subject.displayName ?? null,
              primaryDiscordUserId: subject.primaryDiscordUserId ?? null,
              status: subject.status,
              entitlements: entitlementsResult.map(
                (e: {
                  id: string;
                  sourceProvider: string;
                  productId: string;
                  sourceReference?: string;
                  status: string;
                  grantedAt: number;
                  revokedAt?: number | null;
                }) => ({
                  id: e.id,
                  sourceProvider: e.sourceProvider,
                  productId: e.productId,
                  sourceReference: e.sourceReference ?? null,
                  status: e.status,
                  grantedAt: e.grantedAt,
                  revokedAt: e.revokedAt ?? null,
                })
              ),
            };
          }
        )
      );

      const sanitizedConnections = (
        connectionsResult as Array<{
          id?: string;
          provider?: string;
          connectionType?: string;
          status?: string;
          createdAt?: number;
          updatedAt?: number;
        }>
      ).map((connection) => ({
        id: connection.id,
        provider: connection.provider,
        connectionType: connection.connectionType,
        status: connection.status,
        createdAt: connection.createdAt,
        updatedAt: connection.updatedAt,
      }));

      const exportPayload = {
        exportedAt: new Date().toISOString(),
        profile: {
          authUserId: session.user.id,
          name: session.user.name,
          email: session.user.email,
        },
        subjects: subjectsWithEntitlements,
        providerConnections: sanitizedConnections,
        authorizedApps: grantsResult,
      };

      const json = JSON.stringify(exportPayload, null, 2);
      return new Response(json, {
        headers: {
          'Content-Type': 'application/json',
          'Content-Disposition': 'attachment; filename="yucp-data-export.json"',
        },
      });
    } catch (err) {
      logger.error('Failed to generate data export', {
        error: err instanceof Error ? err.message : String(err),
      });
      return Response.json({ error: 'Failed to generate data export' }, { status: 500 });
    }
  }

  async function requestUserAccountDeletion(request: Request): Promise<Response> {
    if (request.method !== 'DELETE') {
      return Response.json({ error: 'Method not allowed' }, { status: 405 });
    }
    const session = await auth.getSession(request);
    if (!session) {
      return Response.json({ error: 'Authentication required' }, { status: 401 });
    }
    try {
      const convex = getConvexClientFromUrl(config.convexUrl);
      const authUserId = session.user.id;

      const subjects = await listAllSubjectsForAuthUser(convex, config.convexApiSecret, authUserId);

      for (const subject of subjects as Array<{ _id: string }>) {
        await convex.mutation(api.entitlements.revokeAllEntitlementsForSubject, {
          apiSecret: config.convexApiSecret,
          authUserId,
          subjectId: subject._id as Id<'subjects'>,
        });
      }

      await convex.mutation(api.userPortal.revokeAllOAuthGrantsForUser, {
        apiSecret: config.convexApiSecret,
        authUserId,
      });

      const { apiKeys } = await auth.listApiKeys(request);
      const managedPublicApiKeys = apiKeys.filter((key) => {
        const metadata = parsePublicApiKeyMetadata(key.metadata);
        return (
          metadata?.kind === PUBLIC_API_KEY_METADATA_KIND &&
          metadata.authUserId === authUserId &&
          key.enabled !== false
        );
      });
      await Promise.all(
        managedPublicApiKeys.map((key) =>
          convex.mutation(api.betterAuthApiKeys.updateApiKey, {
            apiSecret: config.convexApiSecret,
            keyId: key.id,
            enabled: false,
          })
        )
      );

      const connections = await convex.query(api.providerConnections.listConnectionsForUser, {
        apiSecret: config.convexApiSecret,
        authUserId,
      });
      for (const connection of (connections as Array<{ id?: string }>) ?? []) {
        if (!connection.id) continue;
        try {
          await runProviderDisconnectHook(convex, connection.id, authUserId);
          await convex.mutation(api.providerConnections.disconnectConnection, {
            apiSecret: config.convexApiSecret,
            connectionId: connection.id as Id<'provider_connections'>,
            authUserId,
          });
        } catch (disconnectErr) {
          logger.warn('Failed to disconnect provider connection during account deletion', {
            connectionId: connection.id,
            error: disconnectErr instanceof Error ? disconnectErr.message : String(disconnectErr),
          });
        }
      }

      await convex.mutation(api.userPortal.requestAccountDeletion, {
        apiSecret: config.convexApiSecret,
        authUserId,
      });

      return Response.json({
        message:
          'Deletion request received. Your account and associated data will be removed within 30 days.',
      });
    } catch (err) {
      logger.error('Failed to process account deletion request', {
        error: err instanceof Error ? err.message : String(err),
      });
      return Response.json(
        { error: 'Failed to process account deletion request' },
        { status: 500 }
      );
    }
  }

  return {
    revokeUserEntitlement,
    getUserOAuthGrants,
    revokeUserOAuthGrant,
    getUserDataExport,
    requestUserAccountDeletion,
  };
}
