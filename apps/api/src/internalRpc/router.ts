import { TempoRouter, TempoRouterConfiguration } from '@tempojs/cloudflare-worker-router';
import { ConsoleLogger, TempoLogLevel } from '@tempojs/common';
import { AuthContext, AuthInterceptor, ServerContext } from '@tempojs/server';
import {
  type AddCollaboratorConnectionManualRequest,
  type AddCollaboratorConnectionManualResponse,
  BaseCatalogService,
  BaseCollaboratorService,
  BaseSetupService,
  BaseVerificationService,
  type BindVerifyPanelRequest,
  type CollaboratorConnectionRecord,
  type CompleteLicenseVerificationRequest,
  type CompleteVrchatVerificationRequest,
  type CreateCollaboratorInviteRequest,
  type CreateCollaboratorInviteResponse,
  type CreateConnectTokenRequest,
  type CreateDiscordRoleSetupSessionRequest,
  type CreateSetupSessionRequest,
  type DisconnectVerificationRequest,
  type DiscordRoleSetupResultResponse,
  type GetDiscordRoleSetupResultRequest,
  type ListCollaboratorConnectionsRequest,
  type ListCollaboratorConnectionsResponse,
  type ListProviderProductsRequest,
  type ListProviderTiersRequest,
  type ProductsResponse,
  type RemoveCollaboratorConnectionRequest,
  type ResolveProductNameRequest,
  type ResolveProductNameResponse,
  type SuccessResponse,
  TempoServiceRegistry,
  type TiersResponse,
  type TokenResponse,
  type UpsertProductCredentialRequest,
  type VerificationResultResponse,
} from '@yucp/private-rpc';
import { VrchatApiClient } from '@yucp/providers';
import { timingSafeStringEqual } from '@yucp/shared';
import { getConvexClientFromUrl } from '../lib/convex';
import { createSetupSession } from '../lib/setupSession';
import { getProviderRuntime } from '../providers/index';
import type { ProviderContext } from '../providers/types';
import type { VerificationRouteHandlers } from '../routes';
import type { CollabConfig } from '../routes/collab';
import { createCollabRoutes } from '../routes/collab';
import { type ConnectConfig, createConnectRoutes } from '../routes/connect';
import { handleProviderProducts } from '../routes/products';
import { handleProviderTiers } from '../routes/tiers';
import { handleCompleteVrchat } from '../verification/completeVrchat';
import type { VerificationConfig } from '../verification/verificationConfig';
import { createJsonRequest, readJsonResponse } from './httpAdapter';
import { InternalRpcTelemetry } from './telemetry';

type ConnectHandlers = ReturnType<typeof createConnectRoutes>;
type CollabHandlers = ReturnType<typeof createCollabRoutes>;

export const INTERNAL_RPC_PATH = '/__internal/tempo';

const INTERNAL_RPC_IDENTITY = 'internal-rpc';
const telemetry = new InternalRpcTelemetry();
const _INTERNAL_RPC_TIMEOUT_MS = 10_000;
const TELEMETRY_REDACTED_KEYS = new Set([
  'apiSecret',
  'authorization',
  'internalRpcSharedSecret',
  'jinxxyApiKey',
  'licenseKey',
  'panelToken',
  'password',
  'token',
  'twoFactorCode',
]);

export type InternalRpcConfig = {
  apiBaseUrl: string;
  convexApiSecret: string;
  convexSiteUrl: string;
  convexUrl: string;
  encryptionSecret: string;
  internalRpcSharedSecret: string;
  logLevel?: string;
};

type InternalRpcDependencies = {
  collabConfig: CollabConfig;
  collabRoutes: CollabHandlers;
  config: InternalRpcConfig;
  connectConfig: ConnectConfig;
  connectRoutes: ConnectHandlers;
  verificationHandlers: VerificationRouteHandlers;
};

function toTempoLogLevel(value: string | undefined): TempoLogLevel {
  switch ((value ?? '').toLowerCase()) {
    case 'trace':
      return TempoLogLevel.Trace;
    case 'debug':
      return TempoLogLevel.Debug;
    case 'warn':
      return TempoLogLevel.Warn;
    case 'error':
      return TempoLogLevel.Error;
    case 'critical':
      return TempoLogLevel.Critical;
    default:
      return TempoLogLevel.Info;
  }
}

function sanitizeForTelemetry(payload: unknown): unknown {
  if (payload === null || payload === undefined) {
    return payload;
  }
  if (Array.isArray(payload)) {
    return payload.map((entry) => sanitizeForTelemetry(entry));
  }
  if (typeof payload !== 'object') {
    return payload;
  }

  return Object.fromEntries(
    Object.entries(payload).map(([key, value]) => [
      key,
      TELEMETRY_REDACTED_KEYS.has(key) ? '[redacted]' : sanitizeForTelemetry(value),
    ])
  );
}

function estimateTelemetryBytes(payload: unknown): number {
  if (payload === undefined) {
    return 0;
  }

  try {
    return new TextEncoder().encode(JSON.stringify(sanitizeForTelemetry(payload))).length;
  } catch {
    return 0;
  }
}

function createVerificationConfig(deps: InternalRpcDependencies): VerificationConfig {
  return {
    baseUrl: deps.connectConfig.apiBaseUrl,
    frontendUrl: deps.connectConfig.frontendBaseUrl,
    convexUrl: deps.connectConfig.convexUrl,
    convexApiSecret: deps.connectConfig.convexApiSecret,
    gumroadClientId: deps.connectConfig.gumroadClientId,
    gumroadClientSecret: deps.connectConfig.gumroadClientSecret,
    discordClientId: deps.connectConfig.discordClientId,
    discordClientSecret: deps.connectConfig.discordClientSecret,
    encryptionSecret: deps.connectConfig.encryptionSecret,
  };
}

async function withTelemetry<TResponse>(
  method: string,
  request: unknown,
  action: () => Promise<TResponse>
): Promise<TResponse> {
  const startedAt = performance.now();
  const requestBytes = estimateTelemetryBytes(request);
  try {
    const response = await action();
    telemetry.observe({
      method,
      requestBytes,
      responseBytes: estimateTelemetryBytes(response),
      durationMs: performance.now() - startedAt,
    });
    return response;
  } catch (error) {
    telemetry.observe({
      method,
      requestBytes,
      durationMs: performance.now() - startedAt,
      error,
    });
    throw error;
  }
}

async function createCollabSetupToken(
  encryptionSecret: string,
  authUserId: string,
  guildId: string,
  actorDiscordUserId: string
): Promise<string> {
  return createSetupSession(authUserId, guildId, actorDiscordUserId, encryptionSecret);
}

function normalizeTokenResponse(payload: Partial<TokenResponse> | null | undefined): TokenResponse {
  return {
    token: payload?.token,
  };
}

function normalizeProductsResponse(
  payload: Partial<ProductsResponse> | null | undefined
): ProductsResponse {
  return {
    products: (payload?.products ?? []).map((product) => ({
      id: product?.id,
      name: product?.name,
      collaboratorName: product?.collaboratorName,
      productUrl: product?.productUrl,
    })),
    error: payload?.error,
  };
}

function normalizeOptionalInt64(value: unknown): bigint | undefined {
  if (typeof value === 'bigint') {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? BigInt(value) : undefined;
  }
  if (typeof value === 'string' && /^-?\d+$/.test(value)) {
    return BigInt(value);
  }
  return undefined;
}

function normalizeTiersResponse(payload: Partial<TiersResponse> | null | undefined): TiersResponse {
  return {
    tiers: (payload?.tiers ?? []).map((tier) => ({
      id: tier?.id,
      productId: tier?.productId,
      name: tier?.name,
      description: tier?.description,
      amountCents: normalizeOptionalInt64(tier?.amountCents),
      currency: tier?.currency,
      active: tier?.active ?? false,
    })),
    error: payload?.error,
  };
}

export async function listProviderProductsViaApi(
  config: Pick<InternalRpcConfig, 'apiBaseUrl' | 'convexApiSecret'>,
  request: ListProviderProductsRequest,
  handleProducts: typeof handleProviderProducts = handleProviderProducts
): Promise<ProductsResponse> {
  const provider = request.provider ?? '';
  const response = await handleProducts(
    createJsonRequest(`${config.apiBaseUrl}/api/${provider}/products`, {
      apiSecret: config.convexApiSecret,
      authUserId: request.authUserId ?? '',
    }),
    provider
  );
  return normalizeProductsResponse(
    await readJsonResponse<Partial<ProductsResponse>>(response, {
      allowErrorStatuses: [500],
    })
  );
}

export async function listProviderTiersViaApi(
  config: Pick<InternalRpcConfig, 'apiBaseUrl' | 'convexApiSecret'>,
  request: ListProviderTiersRequest,
  handleTiers: typeof handleProviderTiers = handleProviderTiers
): Promise<TiersResponse> {
  const provider = request.provider ?? '';
  const response = await handleTiers(
    createJsonRequest(`${config.apiBaseUrl}/api/${provider}/tiers`, {
      apiSecret: config.convexApiSecret,
      authUserId: request.authUserId ?? '',
      productId: request.productId ?? '',
    }),
    provider
  );
  return normalizeTiersResponse(
    await readJsonResponse<Partial<TiersResponse>>(response, {
      allowErrorStatuses: [500],
    })
  );
}

function normalizeDiscordRoleSetupResult(
  payload: Partial<DiscordRoleSetupResultResponse> | null | undefined
): DiscordRoleSetupResultResponse {
  return {
    completed: payload?.completed ?? false,
    sourceGuildId: payload?.sourceGuildId,
    sourceGuildName: payload?.sourceGuildName,
    sourceRoleId: payload?.sourceRoleId,
    sourceRoleIds: payload?.sourceRoleIds ?? [],
    requiredRoleMatchMode: payload?.requiredRoleMatchMode,
  };
}

function normalizeSuccessResponse(
  payload: Partial<SuccessResponse> | null | undefined,
  fallbackSuccess = false
): SuccessResponse {
  return {
    success: payload?.success ?? fallbackSuccess,
    error: payload?.error,
    supportCode: payload?.supportCode,
  };
}

function normalizeVerificationResponse(
  payload: Partial<VerificationResultResponse> | null | undefined
): VerificationResultResponse {
  return {
    success: payload?.success ?? false,
    error: payload?.error,
    provider: payload?.provider,
    supportCode: payload?.supportCode,
    entitlementIds: payload?.entitlementIds ?? [],
  };
}

function normalizeListConnectionsResponse(
  payload:
    | {
        connections?: CollaboratorConnectionRecord[];
      }
    | null
    | undefined
): ListCollaboratorConnectionsResponse {
  return {
    connections: (payload?.connections ?? []).map((connection) => ({
      id: connection?.id,
      linkType: connection?.linkType,
      status: connection?.status,
      source: connection?.source,
      webhookConfigured: connection?.webhookConfigured ?? false,
      collaboratorDiscordUserId: connection?.collaboratorDiscordUserId,
      collaboratorDisplayName: connection?.collaboratorDisplayName,
      createdAt: connection?.createdAt,
    })),
  };
}

class InternalRpcAuthInterceptor extends AuthInterceptor {
  constructor(private readonly expectedSecret: string) {
    super();
  }

  override async intercept(
    _context: ServerContext,
    authorizationValue: string
  ): Promise<AuthContext> {
    if (!timingSafeStringEqual(authorizationValue, `Bearer ${this.expectedSecret}`)) {
      throw new Error('unauthorized');
    }

    const authContext = new AuthContext();
    authContext.addProperty(INTERNAL_RPC_IDENTITY, 'kind', 'internal');
    authContext.addProperty(INTERNAL_RPC_IDENTITY, 'identity', INTERNAL_RPC_IDENTITY);
    authContext.peerIdentityKey = INTERNAL_RPC_IDENTITY;
    return authContext;
  }
}

function registerServices(deps: InternalRpcDependencies): TempoServiceRegistry {
  TempoServiceRegistry.register(BaseCatalogService.serviceName)(
    class CatalogTempoService extends BaseCatalogService {
      async listProviderProducts(
        request: ListProviderProductsRequest,
        _context: ServerContext
      ): Promise<ProductsResponse> {
        return withTelemetry('CatalogService.listProviderProducts', request, async () => {
          return await listProviderProductsViaApi(deps.config, request);
        });
      }

      async listProviderTiers(
        request: ListProviderTiersRequest,
        _context: ServerContext
      ): Promise<TiersResponse> {
        return withTelemetry('CatalogService.listProviderTiers', request, async () => {
          return await listProviderTiersViaApi(deps.config, request);
        });
      }

      async resolveProductName(
        request: ResolveProductNameRequest,
        _context: ServerContext
      ): Promise<ResolveProductNameResponse> {
        return withTelemetry('CatalogService.resolveProductName', request, async () => {
          const provider = request.provider ?? '';
          const runtime = getProviderRuntime(provider);
          if (!runtime?.resolveProductName) {
            return { name: '', error: 'not_supported' };
          }

          const authUserId = request.authUserId ?? '';
          const convex = getConvexClientFromUrl(deps.config.convexUrl);
          const ctx: ProviderContext = {
            convex,
            apiSecret: deps.config.convexApiSecret,
            authUserId,
            encryptionSecret: deps.config.encryptionSecret,
          };

          const credential = await runtime.getCredential(ctx);
          const result = await runtime.resolveProductName(credential, request.urlOrId ?? '', ctx);
          return { name: result.name ?? '', error: result.error };
        });
      }

      async upsertProductCredential(
        request: UpsertProductCredentialRequest,
        _context: ServerContext
      ): Promise<SuccessResponse> {
        return withTelemetry('CatalogService.upsertProductCredential', request, async () => {
          const result = await deps.connectRoutes.serverUpsertProductCredential({
            authUserId: request.authUserId ?? '',
            providerKey: request.providerKey ?? '',
            productId: request.productId ?? '',
            plaintextSecretKey: request.productSecretKey ?? '',
          });
          return {
            success: result.success,
            error: result.error,
            supportCode: undefined,
          };
        });
      }
    }
  );

  TempoServiceRegistry.register(BaseSetupService.serviceName)(
    class SetupTempoService extends BaseSetupService {
      async createSetupSession(
        request: CreateSetupSessionRequest,
        _context: ServerContext
      ): Promise<TokenResponse> {
        return withTelemetry('SetupService.createSetupSession', request, async () => {
          const response = await deps.connectRoutes.createSessionEndpoint(
            createJsonRequest(`${deps.config.apiBaseUrl}/api/setup/create-session`, {
              authUserId: request.authUserId ?? '',
              guildId: request.guildId ?? '',
              discordUserId: request.discordUserId ?? '',
              apiSecret: deps.config.convexApiSecret,
            })
          );
          return normalizeTokenResponse(await readJsonResponse<Partial<TokenResponse>>(response));
        });
      }

      async createConnectToken(
        request: CreateConnectTokenRequest,
        _context: ServerContext
      ): Promise<TokenResponse> {
        return withTelemetry('SetupService.createConnectToken', request, async () => {
          const response = await deps.connectRoutes.createTokenEndpoint(
            createJsonRequest(`${deps.config.apiBaseUrl}/api/connect/create-token`, {
              discordUserId: request.discordUserId ?? '',
              guildId: request.guildId ?? '',
              apiSecret: deps.config.convexApiSecret,
            })
          );
          return normalizeTokenResponse(await readJsonResponse<Partial<TokenResponse>>(response));
        });
      }

      async createDiscordRoleSetupSession(
        request: CreateDiscordRoleSetupSessionRequest,
        _context: ServerContext
      ): Promise<TokenResponse> {
        return withTelemetry('SetupService.createDiscordRoleSetupSession', request, async () => {
          const response = await deps.connectRoutes.createDiscordRoleSession(
            createJsonRequest(`${deps.config.apiBaseUrl}/api/setup/discord-role-session`, {
              authUserId: request.authUserId ?? '',
              guildId: request.guildId ?? '',
              adminDiscordUserId: request.adminDiscordUserId ?? '',
              apiSecret: deps.config.convexApiSecret,
            })
          );
          return normalizeTokenResponse(await readJsonResponse<Partial<TokenResponse>>(response));
        });
      }

      async getDiscordRoleSetupResult(
        request: GetDiscordRoleSetupResultRequest,
        _context: ServerContext
      ): Promise<DiscordRoleSetupResultResponse> {
        return withTelemetry('SetupService.getDiscordRoleSetupResult', request, async () => {
          const response = await deps.connectRoutes.getDiscordRoleResult(
            new Request(`${deps.config.apiBaseUrl}/api/setup/discord-role-result`, {
              headers: {
                Authorization: `Bearer ${request.token ?? ''}`,
              },
            })
          );
          return normalizeDiscordRoleSetupResult(
            await readJsonResponse<Partial<DiscordRoleSetupResultResponse>>(response)
          );
        });
      }
    }
  );

  TempoServiceRegistry.register(BaseVerificationService.serviceName)(
    class VerificationTempoService extends BaseVerificationService {
      async bindVerifyPanel(
        request: BindVerifyPanelRequest,
        _context: ServerContext
      ): Promise<SuccessResponse> {
        return withTelemetry('VerificationService.bindVerifyPanel', request, async () => {
          const response = await deps.verificationHandlers.bindVerifyPanel(
            createJsonRequest(`${deps.config.apiBaseUrl}/api/verification/panel/bind`, {
              apiSecret: deps.config.convexApiSecret,
              applicationId: request.applicationId ?? '',
              discordUserId: request.discordUserId ?? '',
              guildId: request.guildId ?? '',
              interactionToken: request.interactionToken ?? '',
              messageId: request.messageId ?? '',
              panelToken: request.panelToken ?? '',
              authUserId: request.authUserId ?? '',
            })
          );
          return normalizeSuccessResponse(
            await readJsonResponse<Partial<SuccessResponse>>(response, {
              allowErrorStatuses: [400, 401, 404, 405],
            })
          );
        });
      }

      async completeLicenseVerification(
        request: CompleteLicenseVerificationRequest,
        _context: ServerContext
      ): Promise<VerificationResultResponse> {
        return withTelemetry(
          'VerificationService.completeLicenseVerification',
          request,
          async () => {
            const response = await deps.verificationHandlers.completeLicenseVerification(
              createJsonRequest(
                `${deps.config.apiBaseUrl}/api/verification/complete-license`,
                (request.creatorAuthUserId ?? request.buyerAuthUserId ?? request.buyerSubjectId)
                  ? {
                      apiSecret: deps.config.convexApiSecret,
                      licenseKey: request.licenseKey ?? '',
                      productId: request.productId,
                      provider: request.provider,
                      creatorAuthUserId: request.creatorAuthUserId ?? '',
                      buyerAuthUserId: request.buyerAuthUserId ?? '',
                      buyerSubjectId: request.buyerSubjectId ?? '',
                      discordUserId: request.discordUserId,
                    }
                  : {
                      apiSecret: deps.config.convexApiSecret,
                      licenseKey: request.licenseKey ?? '',
                      productId: request.productId,
                      provider: request.provider,
                      authUserId: request.authUserId ?? '',
                      subjectId: request.subjectId ?? '',
                      discordUserId: request.discordUserId,
                    }
              )
            );
            return normalizeVerificationResponse(
              await readJsonResponse<Partial<VerificationResultResponse>>(response, {
                allowErrorStatuses: [400, 401, 409, 500],
              })
            );
          }
        );
      }

      async completeVrchatVerification(
        request: CompleteVrchatVerificationRequest,
        _context: ServerContext
      ): Promise<VerificationResultResponse> {
        return withTelemetry(
          'VerificationService.completeVrchatVerification',
          request,
          async () => {
            const client = new VrchatApiClient();
            const ownership = await client.verifyOwnership(
              request.username ?? '',
              request.password ?? '',
              request.twoFactorCode
            );
            return normalizeVerificationResponse(
              await handleCompleteVrchat(createVerificationConfig(deps), {
                ...((request.creatorAuthUserId ?? request.buyerAuthUserId ?? request.buyerSubjectId)
                  ? {
                      creatorAuthUserId: request.creatorAuthUserId ?? '',
                      buyerAuthUserId: request.buyerAuthUserId ?? '',
                      buyerSubjectId: request.buyerSubjectId ?? '',
                    }
                  : {
                      authUserId: request.authUserId ?? '',
                      subjectId: request.subjectId ?? '',
                    }),
                vrchatUserId: ownership.vrchatUserId,
                displayName: ownership.displayName,
                ownedAvatarIds: ownership.ownedAvatarIds,
              })
            );
          }
        );
      }

      async disconnectVerification(
        request: DisconnectVerificationRequest,
        _context: ServerContext
      ): Promise<SuccessResponse> {
        return withTelemetry('VerificationService.disconnectVerification', request, async () => {
          const response = await deps.verificationHandlers.disconnectVerification(
            createJsonRequest(`${deps.config.apiBaseUrl}/api/verification/disconnect`, {
              apiSecret: deps.config.convexApiSecret,
              authUserId: request.authUserId ?? '',
              subjectId: request.subjectId ?? '',
              provider: request.provider ?? '',
            })
          );
          return normalizeSuccessResponse(
            await readJsonResponse<Partial<SuccessResponse>>(response, {
              allowErrorStatuses: [400, 401, 500],
            })
          );
        });
      }
    }
  );

  TempoServiceRegistry.register(BaseCollaboratorService.serviceName)(
    class CollaboratorTempoService extends BaseCollaboratorService {
      async createInvite(
        request: CreateCollaboratorInviteRequest,
        _context: ServerContext
      ): Promise<CreateCollaboratorInviteResponse> {
        return withTelemetry('CollaboratorService.createInvite', request, async () => {
          const setupToken = await createCollabSetupToken(
            deps.collabConfig.encryptionSecret,
            request.authUserId ?? '',
            request.guildId ?? '',
            request.actorDiscordUserId ?? ''
          );
          const response = await deps.collabRoutes.handleCollabRequest(
            createJsonRequest(
              `${deps.config.apiBaseUrl}/api/collab/invite`,
              {
                guildId: request.guildId,
                guildName: request.guildName,
                providerKey: request.providerKey,
              },
              {
                headers: {
                  Authorization: `Bearer ${setupToken}`,
                },
              }
            )
          );
          const json = await readJsonResponse<{ inviteUrl?: string; expiresAt?: number }>(response);
          return {
            inviteUrl: json.inviteUrl,
            expiresAt: json.expiresAt !== undefined ? BigInt(json.expiresAt) : undefined,
          };
        });
      }

      async listConnections(
        request: ListCollaboratorConnectionsRequest,
        _context: ServerContext
      ): Promise<ListCollaboratorConnectionsResponse> {
        return withTelemetry('CollaboratorService.listConnections', request, async () => {
          const setupToken = await createCollabSetupToken(
            deps.collabConfig.encryptionSecret,
            request.authUserId ?? '',
            request.guildId ?? '',
            request.actorDiscordUserId ?? ''
          );
          const response = await deps.collabRoutes.handleCollabRequest(
            new Request(`${deps.config.apiBaseUrl}/api/collab/connections`, {
              headers: {
                Authorization: `Bearer ${setupToken}`,
              },
            })
          );
          return normalizeListConnectionsResponse(
            await readJsonResponse<{
              connections?: CollaboratorConnectionRecord[];
            }>(response)
          );
        });
      }

      async addConnectionManual(
        request: AddCollaboratorConnectionManualRequest,
        _context: ServerContext
      ): Promise<AddCollaboratorConnectionManualResponse> {
        return withTelemetry('CollaboratorService.addConnectionManual', request, async () => {
          const setupToken = await createCollabSetupToken(
            deps.collabConfig.encryptionSecret,
            request.authUserId ?? '',
            request.guildId ?? '',
            request.actorDiscordUserId ?? ''
          );
          const response = await deps.collabRoutes.handleCollabRequest(
            createJsonRequest(
              `${deps.config.apiBaseUrl}/api/collab/connections/manual`,
              {
                providerKey: request.providerKey ?? '',
                credential: request.credential ?? '',
                serverName: request.serverName,
              },
              {
                headers: {
                  Authorization: `Bearer ${setupToken}`,
                },
              }
            )
          );
          return await readJsonResponse<AddCollaboratorConnectionManualResponse>(response, {
            allowErrorStatuses: [400, 401, 422, 500],
          });
        });
      }

      async removeConnection(
        request: RemoveCollaboratorConnectionRequest,
        _context: ServerContext
      ): Promise<SuccessResponse> {
        return withTelemetry('CollaboratorService.removeConnection', request, async () => {
          const setupToken = await createCollabSetupToken(
            deps.collabConfig.encryptionSecret,
            request.authUserId ?? '',
            request.guildId ?? '',
            request.actorDiscordUserId ?? ''
          );
          const response = await deps.collabRoutes.handleCollabRequest(
            new Request(
              `${deps.config.apiBaseUrl}/api/collab/connections/${encodeURIComponent(request.connectionId ?? '')}`,
              {
                method: 'DELETE',
                headers: {
                  Authorization: `Bearer ${setupToken}`,
                },
              }
            )
          );
          return normalizeSuccessResponse(
            await readJsonResponse<Partial<SuccessResponse>>(response, {
              allowErrorStatuses: [400, 401],
            })
          );
        });
      }
    }
  );

  const logger = new ConsoleLogger('tempo-registry', toTempoLogLevel(deps.config.logLevel));
  return new TempoServiceRegistry(logger);
}

export function createInternalRpcRouter(deps: InternalRpcDependencies): TempoRouter<undefined> {
  if (!deps.config.internalRpcSharedSecret) {
    throw new Error('INTERNAL_RPC_SHARED_SECRET must be configured for internal RPC');
  }

  const logger = new ConsoleLogger('tempo-router', toTempoLogLevel(deps.config.logLevel));
  const configuration = new TempoRouterConfiguration();
  configuration.enableCors = false;
  configuration.exposeTempo = false;
  configuration.transmitInternalErrors = false;

  return new TempoRouter(
    logger,
    registerServices(deps),
    configuration,
    new InternalRpcAuthInterceptor(deps.config.internalRpcSharedSecret)
  );
}
