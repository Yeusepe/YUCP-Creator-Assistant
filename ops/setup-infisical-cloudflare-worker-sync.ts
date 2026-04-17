import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { type ParseError, parse as parseJsonc, printParseErrorCode } from 'jsonc-parser';
import { readFlag } from './cli-utils';

const WEB_WRANGLER_CONFIG_PATH = resolve(import.meta.dir, '..', 'apps', 'web', 'wrangler.jsonc');
const DEFAULT_INFISICAL_URL = 'https://app.infisical.com';
const CREATE_SYNC_ENDPOINT = '/api/v1/secret-syncs/cloudflare-workers';

type FetchLike = typeof fetch;

interface UniversalAuthResponse {
  accessToken: string;
}

interface CloudflareWorkerSyncSummary {
  id: string;
  name: string;
  projectId: string;
  connectionId: string;
  environment?: { slug?: string };
  folder?: { path?: string };
  destinationConfig?: { scriptId?: string };
}

interface CloudflareWorkerSyncResponse {
  secretSync: CloudflareWorkerSyncSummary;
}

interface CloudflareWorkerSyncListResponse {
  secretSyncs: CloudflareWorkerSyncSummary[];
}

interface SetupSyncConfig {
  infisicalUrl: string;
  clientId: string;
  clientSecret: string;
  projectId: string;
  connectionId: string;
  environment: string;
  secretPath: string;
  scriptId: string;
  syncName: string;
  description: string;
  autoSync: boolean;
}

interface SetupSyncResult {
  syncId: string;
  action: 'created' | 'updated';
  syncStatus?: string;
}

function normalizeOptional(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function loadWranglerScriptId(): string {
  const text = readFileSync(WEB_WRANGLER_CONFIG_PATH, 'utf8');
  const errors: ParseError[] = [];
  const value = parseJsonc(text, errors, { allowTrailingComma: true }) as unknown;

  if (errors.length > 0) {
    const first = errors[0];
    if (!first) {
      throw new Error(`Failed to parse ${WEB_WRANGLER_CONFIG_PATH}`);
    }

    throw new Error(
      `Failed to parse ${WEB_WRANGLER_CONFIG_PATH}: ${printParseErrorCode(first.error)} at offset ${first.offset}`
    );
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Expected ${WEB_WRANGLER_CONFIG_PATH} to contain a JSON object`);
  }

  const scriptId = normalizeOptional((value as { name?: string }).name);
  if (!scriptId) {
    throw new Error(`Expected ${WEB_WRANGLER_CONFIG_PATH} to define a Worker name`);
  }

  return scriptId;
}

export function resolveSetupSyncConfig(env: NodeJS.ProcessEnv = process.env): SetupSyncConfig {
  const clientId = normalizeOptional(env.INFISICAL_CLIENT_ID ?? env.INFISICAL_MACHINE_IDENTITY_ID);
  const clientSecret = normalizeOptional(
    env.INFISICAL_CLIENT_SECRET ?? env.INFISICAL_MACHINE_IDENTITY_SECRET
  );
  const projectId = normalizeOptional(readFlag('--projectId') ?? env.INFISICAL_PROJECT_ID);
  const connectionId = normalizeOptional(
    readFlag('--connectionId') ?? env.INFISICAL_CLOUDFLARE_CONNECTION_ID
  );
  const environment = normalizeOptional(readFlag('--env') ?? env.INFISICAL_ENV) ?? 'prod';
  const secretPath = normalizeOptional(readFlag('--path') ?? env.INFISICAL_WEB_SECRETS_PATH) ?? '/';
  const scriptId = normalizeOptional(readFlag('--scriptId')) ?? loadWranglerScriptId();
  const syncName =
    normalizeOptional(readFlag('--name')) ?? `${scriptId}-${environment}-cloudflare-workers`;
  const description =
    normalizeOptional(readFlag('--description')) ??
    `Sync ${environment} secrets from ${secretPath} to Cloudflare Worker ${scriptId}`;
  const infisicalUrl = normalizeOptional(env.INFISICAL_URL) ?? DEFAULT_INFISICAL_URL;
  const autoSyncRaw = normalizeOptional(readFlag('--autoSync') ?? env.INFISICAL_AUTO_SYNC);
  const autoSync = autoSyncRaw ? autoSyncRaw !== 'false' : true;

  if (!clientId || !clientSecret) {
    throw new Error(
      'Set INFISICAL_CLIENT_ID/INFISICAL_CLIENT_SECRET or INFISICAL_MACHINE_IDENTITY_ID/INFISICAL_MACHINE_IDENTITY_SECRET before creating the Cloudflare Worker sync.'
    );
  }

  if (!projectId) {
    throw new Error('INFISICAL_PROJECT_ID or --projectId=<id> is required.');
  }

  if (!connectionId) {
    throw new Error(
      'INFISICAL_CLOUDFLARE_CONNECTION_ID or --connectionId=<id> is required to create the Cloudflare Worker sync.'
    );
  }

  return {
    infisicalUrl,
    clientId,
    clientSecret,
    projectId,
    connectionId,
    environment,
    secretPath,
    scriptId,
    syncName,
    description,
    autoSync,
  };
}

async function infisicalRequest<T>(
  apiBaseUrl: string,
  path: string,
  init: RequestInit,
  fetchImpl: FetchLike
): Promise<T> {
  const response = await fetchImpl(new URL(path, apiBaseUrl), init);
  const text = await response.text();
  const payload = text ? (JSON.parse(text) as T | { message?: string }) : undefined;

  if (!response.ok) {
    const message =
      payload && typeof payload === 'object' && payload !== null && 'message' in payload
        ? payload.message
        : undefined;
    throw new Error(message || `Infisical API request failed with ${response.status}`);
  }

  return payload as T;
}

export async function loginWithUniversalAuth(
  config: Pick<SetupSyncConfig, 'infisicalUrl' | 'clientId' | 'clientSecret'>,
  fetchImpl: FetchLike = fetch
): Promise<string> {
  const response = await infisicalRequest<UniversalAuthResponse>(
    config.infisicalUrl,
    '/api/v1/auth/universal-auth/login',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        clientId: config.clientId,
        clientSecret: config.clientSecret,
      }),
    },
    fetchImpl
  );

  const token = normalizeOptional(response.accessToken);
  if (!token) {
    throw new Error('Infisical universal auth login returned no access token.');
  }

  return token;
}

export async function listCloudflareWorkerSyncs(
  config: Pick<SetupSyncConfig, 'infisicalUrl' | 'projectId'>,
  accessToken: string,
  fetchImpl: FetchLike = fetch
): Promise<CloudflareWorkerSyncSummary[]> {
  const response = await infisicalRequest<CloudflareWorkerSyncListResponse>(
    config.infisicalUrl,
    `${CREATE_SYNC_ENDPOINT}?projectId=${encodeURIComponent(config.projectId)}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
    fetchImpl
  );

  return response.secretSyncs ?? [];
}

function buildSyncPayload(config: SetupSyncConfig): Record<string, unknown> {
  return {
    name: config.syncName,
    projectId: config.projectId,
    description: config.description,
    connectionId: config.connectionId,
    environment: config.environment,
    secretPath: config.secretPath,
    isAutoSyncEnabled: config.autoSync,
    syncOptions: {
      initialSyncBehavior: 'overwrite-destination',
    },
    destinationConfig: {
      scriptId: config.scriptId,
    },
  };
}

function findMatchingSync(
  syncs: CloudflareWorkerSyncSummary[],
  config: Pick<
    SetupSyncConfig,
    'connectionId' | 'projectId' | 'scriptId' | 'environment' | 'secretPath'
  >
): CloudflareWorkerSyncSummary | undefined {
  return syncs.find(
    (sync) =>
      sync.connectionId === config.connectionId &&
      sync.projectId === config.projectId &&
      sync.destinationConfig?.scriptId === config.scriptId &&
      sync.environment?.slug === config.environment &&
      sync.folder?.path === config.secretPath
  );
}

export async function createOrUpdateCloudflareWorkerSync(
  config: SetupSyncConfig,
  fetchImpl: FetchLike = fetch
): Promise<SetupSyncResult> {
  const accessToken = await loginWithUniversalAuth(config, fetchImpl);
  const syncs = await listCloudflareWorkerSyncs(config, accessToken, fetchImpl);
  const existing = findMatchingSync(syncs, config);
  const endpoint = existing ? `${CREATE_SYNC_ENDPOINT}/${existing.id}` : CREATE_SYNC_ENDPOINT;
  const method = existing ? 'PATCH' : 'POST';

  const response = await infisicalRequest<CloudflareWorkerSyncResponse>(
    config.infisicalUrl,
    endpoint,
    {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(buildSyncPayload(config)),
    },
    fetchImpl
  );

  const syncId = response.secretSync.id;
  if (!syncId) {
    throw new Error('Infisical create/update sync response did not include a sync id.');
  }

  const syncResponse = await infisicalRequest<CloudflareWorkerSyncResponse>(
    config.infisicalUrl,
    `${CREATE_SYNC_ENDPOINT}/${syncId}/sync-secrets`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
    fetchImpl
  );

  return {
    syncId,
    action: existing ? 'updated' : 'created',
    syncStatus: syncResponse.secretSync.syncStatus,
  };
}

async function main(): Promise<void> {
  const config = resolveSetupSyncConfig();
  const result = await createOrUpdateCloudflareWorkerSync(config);
  console.log(
    `setup-infisical-cloudflare-worker-sync: ${result.action} sync ${result.syncId} for Worker ${config.scriptId} (${config.environment} ${config.secretPath})`
  );
  if (result.syncStatus) {
    console.log(`setup-infisical-cloudflare-worker-sync: sync status ${result.syncStatus}`);
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error('setup-infisical-cloudflare-worker-sync:', error);
    process.exit(1);
  });
}
