import { BearerCredential, NoStorageStrategy, TempoChannel } from '@tempojs/client';
import { ConsoleLogger, TempoLogLevel } from '@tempojs/common';
import {
  type AddCollaboratorConnectionManualResponse,
  CatalogClient,
  CollaboratorClient,
  type CreateCollaboratorInviteResponse,
  type DiscordRoleSetupResultResponse,
  type ResolveProductNameResponse,
  SetupClient,
  type SuccessResponse,
  VerificationClient,
  type VerificationResultResponse,
} from '@yucp/private-rpc';
import { getInternalRpcSharedSecret } from '@yucp/shared';
import { getApiUrls } from './apiUrls';
import { normalizeProviderTiers } from './internalRpcTiers';

const INTERNAL_RPC_PATH = '/__internal/tempo';

type PrivateRpcClients = {
  catalog: CatalogClient;
  collaborator: CollaboratorClient;
  setup: SetupClient;
  verification: VerificationClient;
};

let clientsPromise: Promise<PrivateRpcClients> | null = null;

function getRpcBaseUrl(): string {
  const { apiInternal, apiPublic } = getApiUrls();
  const candidates = [apiInternal, apiPublic]
    .filter((value): value is string => Boolean(value))
    .map((value) => value.replace(/\/$/, ''));
  if (candidates.length === 0) {
    throw new Error('API_BASE_URL or API_INTERNAL_URL is not configured for the bot service');
  }

  const secureCandidate = candidates.find((value) => value.startsWith('https://'));
  return secureCandidate ?? candidates[0];
}

async function createClients(): Promise<PrivateRpcClients> {
  const sharedSecret = getInternalRpcSharedSecret(process.env);

  const credential = BearerCredential.create(new NoStorageStrategy(), 'internal-rpc');
  await credential.storeCredential({ token: sharedSecret });

  const rpcBaseUrl = getRpcBaseUrl();
  const isSecure = rpcBaseUrl.startsWith('https://');
  const isProduction = process.env.NODE_ENV === 'production';
  if (isProduction && !isSecure) {
    throw new Error('Internal RPC must use HTTPS in production');
  }

  const channel = TempoChannel.forAddress(`${rpcBaseUrl}${INTERNAL_RPC_PATH}`, {
    credential,
    logger: new ConsoleLogger('internal-rpc', TempoLogLevel.Warn),
    unsafeUseInsecureChannelCallCredential: !isSecure && !isProduction,
  });

  return {
    catalog: channel.getClient(CatalogClient),
    collaborator: channel.getClient(CollaboratorClient),
    setup: channel.getClient(SetupClient),
    verification: channel.getClient(VerificationClient),
  };
}

async function getClients(): Promise<PrivateRpcClients> {
  if (!clientsPromise) {
    const creationPromise = createClients();
    clientsPromise = creationPromise.catch((error) => {
      clientsPromise = null;
      throw error;
    });
  }

  return clientsPromise;
}

export async function createSetupSessionToken(params: {
  discordUserId: string;
  guildId: string;
  authUserId: string;
}): Promise<string | undefined> {
  const response = await (await getClients()).setup.createSetupSession(params);
  return response.token;
}

export async function createConnectToken(params: {
  discordUserId: string;
  guildId: string;
}): Promise<string | undefined> {
  const response = await (await getClients()).setup.createConnectToken(params);
  return response.token;
}

export async function createDiscordRoleSetupSessionToken(params: {
  adminDiscordUserId: string;
  guildId: string;
  authUserId: string;
}): Promise<string | undefined> {
  const response = await (await getClients()).setup.createDiscordRoleSetupSession(params);
  return response.token;
}

export async function getDiscordRoleSetupResult(token: string): Promise<
  Omit<DiscordRoleSetupResultResponse, 'requiredRoleMatchMode'> & {
    requiredRoleMatchMode?: 'all' | 'any';
  }
> {
  const response = await (await getClients()).setup.getDiscordRoleSetupResult({ token });
  return {
    completed: response.completed ?? false,
    sourceGuildId: response.sourceGuildId,
    sourceGuildName: response.sourceGuildName,
    sourceRoleId: response.sourceRoleId,
    sourceRoleIds: response.sourceRoleIds ?? [],
    requiredRoleMatchMode:
      response.requiredRoleMatchMode === 'all'
        ? 'all'
        : response.requiredRoleMatchMode === 'any'
          ? 'any'
          : undefined,
  };
}

function normalizeProducts(
  products:
    | Array<{
        collaboratorName?: string;
        id?: string;
        name?: string;
        productUrl?: string;
        thumbnailUrl?: string;
      }>
    | undefined
): Array<{
  collaboratorName?: string;
  id: string;
  name: string;
  productUrl?: string;
  thumbnailUrl?: string;
}> {
  return (products ?? []).map((product) => ({
    id: product.id ?? '',
    name: product.name ?? product.id ?? 'Unknown product',
    collaboratorName: product.collaboratorName,
    productUrl: product.productUrl,
    thumbnailUrl: product.thumbnailUrl,
  }));
}

/** Generic product listing, calls the provider-specific RPC via the catalog service. */
export async function listProviderProducts(
  provider: string,
  authUserId: string
): Promise<{
  error?: string;
  products: Array<{
    collaboratorName?: string;
    id: string;
    name: string;
    productUrl?: string;
    thumbnailUrl?: string;
  }>;
}> {
  const response = await (await getClients()).catalog.listProviderProducts({
    provider,
    authUserId,
  });
  return {
    products: normalizeProducts(response.products),
    error: response.error,
  };
}

export async function listProviderTiers(
  provider: string,
  authUserId: string,
  productId: string
): Promise<{
  error?: string;
  tiers: Array<{
    active: boolean;
    amountCents?: number;
    currency?: string;
    description?: string;
    id: string;
    name: string;
    productId: string;
  }>;
}> {
  const response = await (await getClients()).catalog.listProviderTiers({
    provider,
    authUserId,
    productId,
  });
  return {
    tiers: normalizeProviderTiers(response.tiers),
    error: response.error,
  };
}

/** Resolve a human-readable display name for a product URL or ID. */
export async function resolveProductName(params: {
  provider: string;
  authUserId: string;
  urlOrId: string;
}): Promise<ResolveProductNameResponse> {
  const response = await (await getClients()).catalog.resolveProductName(params);
  return {
    name: response.name,
    error: response.error,
  };
}

/** @deprecated Use listProviderProducts instead */
export const listGumroadProducts = (authUserId: string) =>
  listProviderProducts('gumroad', authUserId);
/** @deprecated Use listProviderProducts instead */
export const listJinxxyProducts = (authUserId: string) =>
  listProviderProducts('jinxxy', authUserId);
/** @deprecated Use listProviderProducts instead */
export const listLemonSqueezyProducts = (authUserId: string) =>
  listProviderProducts('lemonsqueezy', authUserId);
/** @deprecated Use listProviderProducts instead */
export const listVrchatProducts = (authUserId: string) =>
  listProviderProducts('vrchat', authUserId);

/** @deprecated Use resolveProductName instead */
export async function resolveVrchatProductName(params: {
  urlOrId: string;
  authUserId: string;
}): Promise<ResolveProductNameResponse> {
  return resolveProductName({ provider: 'vrchat', ...params });
}

export async function bindVerifyPanel(params: {
  applicationId: string;
  discordUserId: string;
  guildId: string;
  interactionToken: string;
  messageId: string;
  panelToken: string;
  authUserId: string;
}): Promise<SuccessResponse> {
  const response = await (await getClients()).verification.bindVerifyPanel(params);
  return {
    success: response.success ?? false,
    error: response.error,
    supportCode: response.supportCode,
  };
}

export async function completeLicenseVerification(
  params: {
    discordUserId?: string;
    licenseKey: string;
    productId?: string;
    provider?: string;
  } & (
    | {
        subjectId: string;
        authUserId: string;
        creatorAuthUserId?: never;
        buyerAuthUserId?: never;
        buyerSubjectId?: never;
      }
    | {
        creatorAuthUserId: string;
        buyerAuthUserId: string;
        buyerSubjectId: string;
        authUserId?: never;
        subjectId?: never;
      }
  )
): Promise<VerificationResultResponse> {
  const response = await (await getClients()).verification.completeLicenseVerification(params);
  return {
    success: response.success ?? false,
    error: response.error,
    provider: response.provider,
    supportCode: response.supportCode,
    entitlementIds: response.entitlementIds ?? [],
  };
}

export async function completeVrchatVerification(
  params: {
    password: string;
    twoFactorCode?: string;
    username: string;
  } & (
    | {
        subjectId: string;
        authUserId: string;
        creatorAuthUserId?: never;
        buyerAuthUserId?: never;
        buyerSubjectId?: never;
      }
    | {
        creatorAuthUserId: string;
        buyerAuthUserId: string;
        buyerSubjectId: string;
        authUserId?: never;
        subjectId?: never;
      }
  )
): Promise<VerificationResultResponse> {
  const response = await (await getClients()).verification.completeVrchatVerification(params);
  return {
    success: response.success ?? false,
    error: response.error,
    provider: response.provider,
    supportCode: response.supportCode,
    entitlementIds: response.entitlementIds ?? [],
  };
}

export async function disconnectVerification(params: {
  provider: string;
  subjectId: string;
  authUserId: string;
}): Promise<SuccessResponse> {
  const response = await (await getClients()).verification.disconnectVerification(params);
  return {
    success: response.success ?? false,
    error: response.error,
    supportCode: response.supportCode,
  };
}

export async function createCollaboratorInvite(params: {
  actorDiscordUserId: string;
  guildId: string;
  guildName: string;
  authUserId: string;
  providerKey: string;
}): Promise<CreateCollaboratorInviteResponse> {
  const response = await (await getClients()).collaborator.createInvite(params);
  return {
    inviteUrl: response.inviteUrl,
    expiresAt: response.expiresAt,
  };
}

export async function listCollaboratorConnections(params: {
  actorDiscordUserId: string;
  guildId: string;
  authUserId: string;
}): Promise<
  Array<{
    collaboratorDiscordUserId: string;
    collaboratorDisplayName: string;
    createdAt: number;
    id: string;
    linkType: 'account' | 'api';
    source?: 'invite' | 'manual';
    status: string;
    webhookConfigured: boolean;
  }>
> {
  const response = await (await getClients()).collaborator.listConnections(params);
  return (response.connections ?? []).map((connection) => ({
    id: connection.id ?? '',
    linkType: connection.linkType === 'account' ? 'account' : 'api',
    status: connection.status ?? 'unknown',
    source: connection.source === 'manual' ? 'manual' : 'invite',
    webhookConfigured: connection.webhookConfigured ?? false,
    collaboratorDiscordUserId: connection.collaboratorDiscordUserId ?? 'unknown',
    collaboratorDisplayName: connection.collaboratorDisplayName ?? 'Unknown collaborator',
    createdAt: connection.createdAt === undefined ? Date.now() : Number(connection.createdAt),
  }));
}

export async function addCollaboratorConnectionManual(params: {
  actorDiscordUserId: string;
  guildId: string;
  providerKey: string;
  credential: string;
  serverName?: string;
  authUserId: string;
}): Promise<AddCollaboratorConnectionManualResponse> {
  const response = await (await getClients()).collaborator.addConnectionManual({
    actorDiscordUserId: params.actorDiscordUserId,
    guildId: params.guildId,
    credential: params.credential,
    providerKey: params.providerKey,
    serverName: params.serverName,
    authUserId: params.authUserId,
  });
  return {
    success: response.success ?? false,
    connectionId: response.connectionId,
    displayName: response.displayName,
    error: response.error,
  };
}

export async function removeCollaboratorConnection(params: {
  actorDiscordUserId: string;
  connectionId: string;
  guildId: string;
  authUserId: string;
}): Promise<SuccessResponse> {
  const response = await (await getClients()).collaborator.removeConnection(params);
  return {
    success: response.success ?? false,
    error: response.error,
    supportCode: response.supportCode,
  };
}

export async function upsertProductCredential(params: {
  authUserId: string;
  providerKey: string;
  productId: string;
  productSecretKey: string;
}): Promise<SuccessResponse> {
  const response = await (await getClients()).catalog.upsertProductCredential(params);
  return {
    success: response.success ?? false,
    error: response.error,
    supportCode: response.supportCode,
  };
}
