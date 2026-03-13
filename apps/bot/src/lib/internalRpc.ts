import { BearerCredential, NoStorageStrategy, TempoChannel } from '@tempojs/client';
import { ConsoleLogger, TempoLogLevel } from '@tempojs/common';
import {
  type AddCollaboratorConnectionManualResponse,
  CatalogClient,
  CollaboratorClient,
  type CreateCollaboratorInviteResponse,
  type DiscordRoleSetupResultResponse,
  type ResolveVrchatAvatarNameResponse,
  SetupClient,
  type SuccessResponse,
  VerificationClient,
  type VerificationResultResponse,
} from '@yucp/private-rpc';
import { getApiUrls } from './apiUrls';

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
  const sharedSecret = process.env.INTERNAL_RPC_SHARED_SECRET;
  if (!sharedSecret) {
    throw new Error('INTERNAL_RPC_SHARED_SECRET is not configured for the bot service');
  }

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
  products: Array<{ collaboratorName?: string; id?: string; name?: string }> | undefined
): Array<{ collaboratorName?: string; id: string; name: string }> {
  return (products ?? []).map((product) => ({
    id: product.id ?? '',
    name: product.name ?? product.id ?? 'Unknown product',
    collaboratorName: product.collaboratorName,
  }));
}

export async function listGumroadProducts(authUserId: string): Promise<{
  error?: string;
  products: Array<{ collaboratorName?: string; id: string; name: string }>;
}> {
  const response = await (await getClients()).catalog.listGumroadProducts({ authUserId });
  return {
    products: normalizeProducts(response.products),
    error: response.error,
  };
}

export async function listJinxxyProducts(authUserId: string): Promise<{
  error?: string;
  products: Array<{ collaboratorName?: string; id: string; name: string }>;
}> {
  const response = await (await getClients()).catalog.listJinxxyProducts({ authUserId });
  return {
    products: normalizeProducts(response.products),
    error: response.error,
  };
}

export async function listLemonSqueezyProducts(authUserId: string): Promise<{
  error?: string;
  products: Array<{ collaboratorName?: string; id: string; name: string }>;
}> {
  const response = await (await getClients()).catalog.listLemonSqueezyProducts({ authUserId });
  return {
    products: normalizeProducts(response.products),
    error: response.error,
  };
}

export async function resolveVrchatAvatarName(params: {
  avatarId: string;
  authUserId: string;
}): Promise<ResolveVrchatAvatarNameResponse> {
  const response = await (await getClients()).catalog.resolveVrchatAvatarName(params);
  return {
    name: response.name,
  };
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

export async function completeLicenseVerification(params: {
  discordUserId?: string;
  licenseKey: string;
  productId?: string;
  subjectId: string;
  authUserId: string;
}): Promise<VerificationResultResponse> {
  const response = await (await getClients()).verification.completeLicenseVerification(params);
  return {
    success: response.success ?? false,
    error: response.error,
    provider: response.provider,
    supportCode: response.supportCode,
    entitlementIds: response.entitlementIds ?? [],
  };
}

export async function completeVrchatVerification(params: {
  password: string;
  subjectId: string;
  authUserId: string;
  twoFactorCode?: string;
  username: string;
}): Promise<VerificationResultResponse> {
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
  jinxxyApiKey: string;
  serverName?: string;
  authUserId: string;
}): Promise<AddCollaboratorConnectionManualResponse> {
  const response = await (await getClients()).collaborator.addConnectionManual(params);
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
