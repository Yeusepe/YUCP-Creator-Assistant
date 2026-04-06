import type { StructuredLogger } from '@yucp/shared';
import { api } from '../../../../convex/_generated/api';
import type { Auth } from '../auth';
import { getConvexClientFromUrl } from '../lib/convex';
import { PUBLIC_API_KEY_PREFIX } from '../lib/publicApiKeys';
import type { ConnectConfig } from '../providers/types';
import {
  type BetterAuthApiKey,
  type BetterAuthOAuthClient,
  type BetterAuthPermissionStatements,
  getBetterAuthErrorMessage,
  getPublicApiKeyExpiresIn,
  getPublicApiKeyScopes,
  normalizeOAuthScopes,
  normalizePublicApiScopes,
  normalizeRedirectUris,
  type OAuthAppMappingRecord,
  PUBLIC_API_KEY_METADATA_KIND,
  parsePublicApiKeyMetadata,
  toTimestamp,
} from './connectApiAccessShared';

type OwnerSession = NonNullable<Awaited<ReturnType<Auth['getSession']>>>;

type RequireOwnerSessionForTenant = (
  request: Request,
  authUserId: string | undefined
) => Promise<{ ok: true; session: OwnerSession } | { ok: false; response: Response }>;

interface ConnectApiAccessRoutesOptions {
  readonly auth: Auth;
  readonly config: ConnectConfig;
  readonly logger: StructuredLogger;
  readonly requireOwnerSessionForTenant: RequireOwnerSessionForTenant;
}

async function createManagedPublicApiKey(
  config: ConnectConfig,
  logger: StructuredLogger,
  ownerUserId: string,
  input: {
    name: string;
    scopes: string[];
    authUserId: string;
    expiresAt?: number | null;
  }
): Promise<{
  response: Response;
  data: (BetterAuthApiKey & { key?: string }) | null;
}> {
  const convex = getConvexClientFromUrl(config.convexUrl);
  try {
    const result = (await convex.mutation(api.betterAuthApiKeys.createApiKey, {
      apiSecret: config.convexApiSecret,
      userId: ownerUserId,
      authUserId: input.authUserId,
      name: input.name,
      scopes: input.scopes,
      expiresIn: getPublicApiKeyExpiresIn(input.expiresAt),
    })) as {
      key: string;
      apiKey: {
        id: string;
        name: string | null;
        start: string | null;
        prefix: string | null;
        enabled: boolean;
        permissions: BetterAuthPermissionStatements | null;
        metadata: { kind: string; authUserId: string } | null;
        lastRequestAt: number | null;
        expiresAt: number | null;
        createdAt: number | null;
      };
    };

    return {
      response: new Response(null, { status: 200 }),
      data: {
        id: result.apiKey.id,
        key: result.key,
        name: result.apiKey.name,
        start: result.apiKey.start,
        prefix: result.apiKey.prefix,
        enabled: result.apiKey.enabled,
        permissions: result.apiKey.permissions,
        metadata: result.apiKey.metadata,
        lastRequest: result.apiKey.lastRequestAt ?? undefined,
        expiresAt: result.apiKey.expiresAt ?? undefined,
        createdAt: result.apiKey.createdAt ?? undefined,
      },
    };
  } catch (error) {
    logger.error('Create API key via Convex failed', {
      authUserId: input.authUserId,
      userId: ownerUserId,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      response: new Response(null, { status: 500 }),
      data: null,
    };
  }
}

export function createConnectApiAccessRoutes(options: ConnectApiAccessRoutesOptions) {
  const { auth, config, logger, requireOwnerSessionForTenant } = options;

  async function listPublicApiKeys(request: Request): Promise<Response> {
    const authUserId = new URL(request.url).searchParams.get('authUserId') ?? undefined;
    const required = await requireOwnerSessionForTenant(request, authUserId);
    if (!required.ok) {
      return required.response;
    }

    try {
      const convex = getConvexClientFromUrl(config.convexUrl);
      let data = (await convex.query(api.betterAuthApiKeys.listApiKeysForAuthUser, {
        apiSecret: config.convexApiSecret,
        authUserId: required.session.user.id === authUserId ? required.session.user.id : authUserId,
      })) as Array<{
        id: string;
        name: string | null;
        start: string | null;
        prefix: string | null;
        enabled: boolean;
        permissions: BetterAuthPermissionStatements | null;
        lastRequestAt: number | null;
        expiresAt: number | null;
        createdAt: number | null;
      }>;

      if (data.length === 0 && authUserId) {
        const backfill = (await convex.mutation(api.betterAuthApiKeys.backfillApiKeyReferenceIds, {
          apiSecret: config.convexApiSecret,
          ownerUserId: required.session.user.id,
          authUserId,
        })) as { updatedCount: number };
        if (backfill.updatedCount > 0) {
          data = (await convex.query(api.betterAuthApiKeys.listApiKeysForAuthUser, {
            apiSecret: config.convexApiSecret,
            authUserId,
          })) as typeof data;
        }
      }

      const keys = data
        .map((key) => ({
          _id: key.id,
          _creationTime: key.createdAt ?? Date.now(),
          authUserId,
          name: key.name ?? 'Unnamed',
          prefix: key.start ?? key.prefix ?? PUBLIC_API_KEY_PREFIX,
          status: key.enabled === false ? ('revoked' as const) : ('active' as const),
          scopes: getPublicApiKeyScopes(key.permissions),
          lastUsedAt: key.lastRequestAt ?? undefined,
          expiresAt: key.expiresAt ?? undefined,
        }))
        .sort((left, right) => right._creationTime - left._creationTime);

      return Response.json({ keys });
    } catch (err) {
      logger.error('List API keys failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return Response.json({ error: 'Failed to list API keys' }, { status: 500 });
    }
  }

  async function createPublicApiKey(request: Request): Promise<Response> {
    let body: {
      authUserId?: string;
      name?: string;
      scopes?: string[];
      expiresAt?: number | null;
    };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return Response.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    const authUserId = body.authUserId?.trim();
    const required = await requireOwnerSessionForTenant(request, authUserId);
    if (!required.ok) {
      return required.response;
    }
    if (!authUserId) {
      return Response.json({ error: 'authUserId is required' }, { status: 400 });
    }

    const name = body.name?.trim();
    if (!name) {
      return Response.json({ error: 'name is required' }, { status: 400 });
    }

    try {
      const scopes = normalizePublicApiScopes(body.scopes);
      const expiresAt =
        typeof body.expiresAt === 'number' && Number.isFinite(body.expiresAt)
          ? body.expiresAt
          : undefined;
      const { response, data } = await createManagedPublicApiKey(
        config,
        logger,
        required.session.user.id,
        {
          name,
          scopes,
          authUserId,
          expiresAt,
        }
      );

      if (!response.ok || !data?.id || !data.key) {
        logger.warn('Create API key rejected by Better Auth', {
          authUserId,
          userId: required.session.user.id,
          status: response.status,
          error: getBetterAuthErrorMessage(data, 'Failed to create API key'),
          data,
        });
        return Response.json(
          { error: getBetterAuthErrorMessage(data, 'Failed to create API key') },
          { status: response.status || 500 }
        );
      }

      return Response.json({
        keyId: data.id,
        apiKey: data.key,
        name: data.name ?? name,
        prefix: data.start ?? data.prefix ?? PUBLIC_API_KEY_PREFIX,
        scopes,
        expiresAt: toTimestamp(data.expiresAt) ?? null,
      });
    } catch (err) {
      logger.error('Create API key failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return Response.json(
        { error: err instanceof Error ? err.message : 'Failed to create API key' },
        { status: 400 }
      );
    }
  }

  async function revokePublicApiKey(request: Request, keyId: string): Promise<Response> {
    let body: { authUserId?: string };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return Response.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    const authUserId = body.authUserId?.trim();
    const required = await requireOwnerSessionForTenant(request, authUserId);
    if (!required.ok) {
      return required.response;
    }
    if (!authUserId) {
      return Response.json({ error: 'authUserId is required' }, { status: 400 });
    }

    try {
      const convex = getConvexClientFromUrl(config.convexUrl);
      const existing = (await convex.query(api.betterAuthApiKeys.getApiKey, {
        apiSecret: config.convexApiSecret,
        keyId,
      })) as BetterAuthApiKey | null;

      if (!existing) {
        return Response.json({ error: 'API key not found' }, { status: 404 });
      }

      const metadata = parsePublicApiKeyMetadata(existing.metadata);
      if (metadata?.kind !== PUBLIC_API_KEY_METADATA_KIND || metadata.authUserId !== authUserId) {
        return Response.json({ error: 'API key not found' }, { status: 404 });
      }

      await convex.mutation(api.betterAuthApiKeys.updateApiKey, {
        apiSecret: config.convexApiSecret,
        keyId,
        enabled: false,
      });

      return Response.json({ success: true });
    } catch (err) {
      logger.error('Revoke API key failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return Response.json({ error: 'Failed to revoke API key' }, { status: 500 });
    }
  }

  async function listOAuthApps(request: Request): Promise<Response> {
    const authUserId = new URL(request.url).searchParams.get('authUserId') ?? undefined;
    const required = await requireOwnerSessionForTenant(request, authUserId);
    if (!required.ok) {
      return required.response;
    }

    try {
      const convex = getConvexClientFromUrl(config.convexUrl);
      const mappings = (await convex.query(api.oauthApps.listOAuthApps, {
        apiSecret: config.convexApiSecret,
        authUserId,
      })) as OAuthAppMappingRecord[];
      const clients =
        mappings.length === 0
          ? []
          : ((await auth.listOAuthClients(request)) as BetterAuthOAuthClient[]);

      const clientMap = new Map(clients.map((client) => [client.client_id, client] as const));
      const apps = mappings
        .map((mapping) => {
          const client = clientMap.get(mapping.clientId);
          if (!client) {
            logger.warn('OAuth app mapping missing Better Auth client', {
              appId: mapping._id,
              clientId: mapping.clientId,
              authUserId,
            });
            return null;
          }

          const scopes = client.scope ? client.scope.split(/\s+/).filter(Boolean) : mapping.scopes;

          return {
            _id: mapping._id,
            _creationTime: mapping._creationTime,
            authUserId: mapping.authUserId,
            name: client.client_name ?? mapping.name,
            clientId: mapping.clientId,
            redirectUris: client.redirect_uris ?? mapping.redirectUris,
            scopes,
            tokenEndpointAuthMethod: client.token_endpoint_auth_method,
            grantTypes: client.grant_types,
            responseTypes: client.response_types,
            disabled: client.disabled ?? false,
          };
        })
        .filter((app): app is NonNullable<typeof app> => Boolean(app));

      return Response.json({ apps });
    } catch (err) {
      logger.error('List OAuth apps failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return Response.json({ error: 'Failed to list OAuth apps' }, { status: 500 });
    }
  }

  async function createOAuthApp(request: Request): Promise<Response> {
    let body: {
      authUserId?: string;
      name?: string;
      redirectUris?: string[];
      scopes?: string[];
    };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return Response.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    const authUserId = body.authUserId?.trim();
    const required = await requireOwnerSessionForTenant(request, authUserId);
    if (!required.ok) {
      return required.response;
    }

    const name = body.name?.trim();
    if (!name) {
      return Response.json({ error: 'name is required' }, { status: 400 });
    }

    try {
      const redirectUris = normalizeRedirectUris(body.redirectUris);
      const scopes = normalizeOAuthScopes(body.scopes);
      const convex = getConvexClientFromUrl(config.convexUrl);
      const createdClient = (await convex.mutation(api.oauthClients.createOAuthClient, {
        apiSecret: config.convexApiSecret,
        client_name: name,
        redirect_uris: redirectUris,
        scope: scopes.join(' '),
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'client_secret_post',
        type: 'web',
      })) as BetterAuthOAuthClient;

      if (!createdClient.client_id || !createdClient.client_secret) {
        return Response.json({ error: 'Failed to create OAuth app' }, { status: 500 });
      }

      try {
        const result = await convex.mutation(api.oauthApps.createOAuthAppMapping, {
          apiSecret: config.convexApiSecret,
          authUserId,
          name,
          clientId: createdClient.client_id,
          redirectUris,
          scopes,
          createdByAuthUserId: required.session.user.id,
        });

        return Response.json({
          appId: result._id,
          clientId: createdClient.client_id,
          clientSecret: createdClient.client_secret,
          name: result.name,
          redirectUris: result.redirectUris,
          scopes: result.scopes,
        });
      } catch (mappingError) {
        await convex.mutation(api.oauthClients.deleteOAuthClient, {
          apiSecret: config.convexApiSecret,
          clientId: createdClient.client_id,
        });
        throw mappingError;
      }
    } catch (err) {
      logger.error('Create OAuth app failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return Response.json(
        { error: err instanceof Error ? err.message : 'Failed to create OAuth app' },
        { status: 400 }
      );
    }
  }

  async function regenerateOAuthAppSecret(request: Request, appId: string): Promise<Response> {
    let body: { authUserId?: string };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return Response.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    const authUserId = body.authUserId?.trim();
    const required = await requireOwnerSessionForTenant(request, authUserId);
    if (!required.ok) {
      return required.response;
    }

    try {
      const convex = getConvexClientFromUrl(config.convexUrl);
      const mapping = await convex.query(api.oauthApps.getOAuthApp, {
        apiSecret: config.convexApiSecret,
        authUserId,
        appId,
      });

      if (!mapping) {
        return Response.json({ error: 'OAuth app not found' }, { status: 404 });
      }

      const result = (await convex.mutation(api.oauthClients.rotateOAuthClientSecret, {
        apiSecret: config.convexApiSecret,
        clientId: mapping.clientId,
      })) as BetterAuthOAuthClient;

      if (!result.client_secret) {
        return Response.json({ error: 'Failed to regenerate secret' }, { status: 500 });
      }

      return Response.json({
        clientSecret: result.client_secret,
      });
    } catch (err) {
      logger.error('Regenerate OAuth app secret failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return Response.json({ error: 'Failed to regenerate secret' }, { status: 500 });
    }
  }

  async function updateOAuthApp(request: Request, appId: string): Promise<Response> {
    let body: {
      authUserId?: string;
      name?: string;
      redirectUris?: string[];
      scopes?: string[];
    };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return Response.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    const authUserId = body.authUserId?.trim();
    const required = await requireOwnerSessionForTenant(request, authUserId);
    if (!required.ok) {
      return required.response;
    }

    try {
      const convex = getConvexClientFromUrl(config.convexUrl);
      const mapping = await convex.query(api.oauthApps.getOAuthApp, {
        apiSecret: config.convexApiSecret,
        authUserId,
        appId,
      });

      if (!mapping) {
        return Response.json({ error: 'OAuth app not found' }, { status: 404 });
      }

      const nextName =
        body.name === undefined
          ? undefined
          : (() => {
              const value = body.name?.trim() ?? '';
              if (!value) {
                throw new Error('name cannot be empty');
              }
              return value;
            })();
      const nextRedirectUris =
        body.redirectUris === undefined ? undefined : normalizeRedirectUris(body.redirectUris);
      const nextScopes = body.scopes === undefined ? undefined : normalizeOAuthScopes(body.scopes);

      if (nextName === undefined && nextRedirectUris === undefined && nextScopes === undefined) {
        return Response.json({ error: 'No updates provided' }, { status: 400 });
      }

      const clientUpdate = {
        ...(nextName !== undefined ? { client_name: nextName } : {}),
        ...(nextRedirectUris !== undefined ? { redirect_uris: nextRedirectUris } : {}),
        ...(nextScopes !== undefined ? { scope: nextScopes.join(' ') } : {}),
      };

      await convex.mutation(api.oauthClients.updateOAuthClient, {
        apiSecret: config.convexApiSecret,
        clientId: mapping.clientId,
        update: clientUpdate,
      });

      try {
        await convex.mutation(api.oauthApps.updateOAuthAppMapping, {
          apiSecret: config.convexApiSecret,
          authUserId,
          appId,
          name: nextName,
          redirectUris: nextRedirectUris,
          scopes: nextScopes,
        });
      } catch (mappingError) {
        logger.error('OAuth app mapping update failed after OAuth client update', {
          appId,
          clientId: mapping.clientId,
          error: mappingError instanceof Error ? mappingError.message : String(mappingError),
        });
        try {
          await convex.mutation(api.oauthClients.updateOAuthClient, {
            apiSecret: config.convexApiSecret,
            clientId: mapping.clientId,
            update: {
              ...(nextName !== undefined ? { client_name: mapping.name } : {}),
              ...(nextRedirectUris !== undefined ? { redirect_uris: mapping.redirectUris } : {}),
              ...(nextScopes !== undefined ? { scope: mapping.scopes.join(' ') } : {}),
            },
          });
        } catch (rollbackError) {
          logger.error('OAuth client rollback failed after mapping update error', {
            appId,
            clientId: mapping.clientId,
            error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
          });
        }
        throw mappingError;
      }

      return Response.json({ success: true });
    } catch (err) {
      logger.error('Update OAuth app failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return Response.json(
        { error: err instanceof Error ? err.message : 'Failed to update OAuth app' },
        { status: 500 }
      );
    }
  }

  async function deleteOAuthApp(request: Request, appId: string): Promise<Response> {
    let body: { authUserId?: string };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return Response.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    const authUserId = body.authUserId?.trim();
    const required = await requireOwnerSessionForTenant(request, authUserId);
    if (!required.ok) {
      return required.response;
    }

    try {
      const convex = getConvexClientFromUrl(config.convexUrl);
      const mapping = await convex.query(api.oauthApps.getOAuthApp, {
        apiSecret: config.convexApiSecret,
        authUserId,
        appId,
      });

      if (!mapping) {
        return Response.json({ error: 'OAuth app not found' }, { status: 404 });
      }

      await convex.mutation(api.oauthClients.deleteOAuthClient, {
        apiSecret: config.convexApiSecret,
        clientId: mapping.clientId,
      });

      try {
        await convex.mutation(api.oauthApps.deleteOAuthAppMapping, {
          apiSecret: config.convexApiSecret,
          authUserId,
          appId,
        });
      } catch (mappingError) {
        logger.error('OAuth app mapping delete failed after OAuth client deletion', {
          appId,
          clientId: mapping.clientId,
          error: mappingError instanceof Error ? mappingError.message : String(mappingError),
        });
        throw mappingError;
      }

      return Response.json({ success: true });
    } catch (err) {
      logger.error('Delete OAuth app failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return Response.json(
        { error: err instanceof Error ? err.message : 'Failed to delete OAuth app' },
        { status: 500 }
      );
    }
  }

  async function rotatePublicApiKey(request: Request, keyId: string): Promise<Response> {
    let body: {
      authUserId?: string;
      name?: string;
      scopes?: string[];
      expiresAt?: number | null;
    };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return Response.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    const authUserId = body.authUserId?.trim();
    const required = await requireOwnerSessionForTenant(request, authUserId);
    if (!required.ok) {
      return required.response;
    }
    if (!authUserId) {
      return Response.json({ error: 'authUserId is required' }, { status: 400 });
    }

    try {
      const convex = getConvexClientFromUrl(config.convexUrl);
      const existing = (await convex.query(api.betterAuthApiKeys.getApiKey, {
        apiSecret: config.convexApiSecret,
        keyId,
      })) as BetterAuthApiKey | null;

      if (!existing) {
        return Response.json({ error: 'API key not found' }, { status: 404 });
      }

      const metadata = parsePublicApiKeyMetadata(existing.metadata);
      if (metadata?.kind !== PUBLIC_API_KEY_METADATA_KIND || metadata.authUserId !== authUserId) {
        return Response.json({ error: 'API key not found' }, { status: 404 });
      }

      const scopes =
        body.scopes === undefined
          ? getPublicApiKeyScopes(existing.permissions)
          : normalizePublicApiScopes(body.scopes);
      const nextName = body.name?.trim() || existing.name || 'Rotated key';
      const resolvedExpiresAt =
        body.expiresAt === null
          ? null
          : typeof body.expiresAt === 'number' && Number.isFinite(body.expiresAt)
            ? body.expiresAt
            : toTimestamp(existing.expiresAt);
      const created = await createManagedPublicApiKey(config, logger, required.session.user.id, {
        name: nextName,
        scopes,
        authUserId,
        expiresAt: resolvedExpiresAt,
      });

      if (!created.response.ok || !created.data?.id || !created.data.key) {
        logger.warn('Rotate API key rejected by Better Auth', {
          authUserId,
          keyId,
          userId: required.session.user.id,
          status: created.response.status,
          error: getBetterAuthErrorMessage(created.data, 'Failed to rotate API key'),
          data: created.data,
        });
        return Response.json(
          { error: getBetterAuthErrorMessage(created.data, 'Failed to rotate API key') },
          { status: created.response.status || 500 }
        );
      }

      await convex.mutation(api.betterAuthApiKeys.updateApiKey, {
        apiSecret: config.convexApiSecret,
        keyId,
        enabled: false,
      });

      return Response.json({
        keyId: created.data.id,
        apiKey: created.data.key,
        name: nextName,
        prefix: created.data.start ?? created.data.prefix ?? PUBLIC_API_KEY_PREFIX,
        scopes,
        expiresAt: toTimestamp(created.data.expiresAt) ?? null,
        rotatedFromKeyId: keyId,
      });
    } catch (err) {
      logger.error('Rotate API key failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return Response.json(
        { error: err instanceof Error ? err.message : 'Failed to rotate API key' },
        { status: 400 }
      );
    }
  }

  return {
    listPublicApiKeys,
    createPublicApiKey,
    revokePublicApiKey,
    rotatePublicApiKey,
    listOAuthApps,
    createOAuthApp,
    updateOAuthApp,
    deleteOAuthApp,
    regenerateOAuthAppSecret,
  };
}
