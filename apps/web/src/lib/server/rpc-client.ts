import { BearerCredential, NoStorageStrategy, TempoChannel } from '@tempojs/client';
import { ConsoleLogger, TempoLogLevel } from '@tempojs/common';
import {
  CatalogClient,
  CollaboratorClient,
  SetupClient,
  VerificationClient,
} from '@yucp/private-rpc';
import { getInternalRpcSharedSecret } from '@yucp/shared';

/**
 * Bebop RPC client for server-to-server calls from TanStack Start
 * to the Bun API's Tempo RPC services.
 *
 * Uses the same pattern as apps/bot/src/lib/internalRpc.ts but
 * runs in TanStack Start's server environment (Nitro/Vinxi).
 *
 * Available services:
 * - Catalog: listProviderProducts, resolveProductName
 * - Setup: createSetupSession, createConnectToken
 * - Collaborator: createInvite, listConnections
 * - Verification: completeLicenseVerification, completeVrchatVerification
 */

const INTERNAL_RPC_PATH = '/__internal/tempo';

export interface RpcClients {
  catalog: CatalogClient;
  collaborator: CollaboratorClient;
  setup: SetupClient;
  verification: VerificationClient;
}

let clientsPromise: Promise<RpcClients> | null = null;

function getRpcBaseUrl(): string {
  const base = process.env.API_BASE_URL ?? 'http://localhost:3001';
  return base.replace(/\/$/, '');
}

async function initClients(): Promise<RpcClients> {
  const sharedSecret = getInternalRpcSharedSecret(process.env);

  const credential = BearerCredential.create(new NoStorageStrategy(), 'web-rpc');
  await credential.storeCredential({ token: sharedSecret });

  const rpcBaseUrl = getRpcBaseUrl();
  const isSecure = rpcBaseUrl.startsWith('https://');
  const isProduction = process.env.NODE_ENV === 'production';

  const channel = TempoChannel.forAddress(`${rpcBaseUrl}${INTERNAL_RPC_PATH}`, {
    credential,
    logger: new ConsoleLogger('web-rpc', TempoLogLevel.Warn),
    unsafeUseInsecureChannelCallCredential: !isSecure && !isProduction,
  });

  return {
    catalog: channel.getClient(CatalogClient),
    collaborator: channel.getClient(CollaboratorClient),
    setup: channel.getClient(SetupClient),
    verification: channel.getClient(VerificationClient),
  };
}

/**
 * Returns a singleton RPC client set. Safe to call multiple times;
 * the channel is created once and reused.
 */
export function getRpcClients(): Promise<RpcClients> {
  if (!clientsPromise) {
    clientsPromise = initClients();
  }
  return clientsPromise;
}
