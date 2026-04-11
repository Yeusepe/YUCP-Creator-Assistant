import type { StructuredLogger } from '@yucp/shared';
import {
  CredentialExpiredError,
  type LicenseVerificationPlugin,
  type ProductRecord,
  type ProviderContext,
  type ProviderPurposes,
  type ProviderRuntimeClient,
  type ProviderRuntimeModule,
} from '../contracts';

export const ITCHIO_PURPOSES = {
  credential: 'itchio-oauth-access-token',
  buyerCredential: 'itchio-oauth-buyer-access-token',
} as const satisfies ProviderPurposes;

export const ITCHIO_DISPLAY_META = {
  label: 'itch.io',
  icon: 'ItchIo.png',
  color: '#fa5c5c',
  shadowColor: '#fa5c5c',
  textColor: '#ffffff',
  connectedColor: '#d94b4b',
  confettiColors: ['#fa5c5c', '#d94b4b', '#ffd5d5', '#ffffff'],
  description: 'Marketplace',
  dashboardConnectPath: '/api/connect/itchio/begin',
  dashboardConnectParamStyle: 'snakeCase',
  dashboardIconBg: '#fa5c5c',
  dashboardQuickStartBg: 'rgba(250,92,92,0.12)',
  dashboardQuickStartBorder: 'rgba(250,92,92,0.32)',
  dashboardServerTileHint: 'Allow users to verify itch.io download keys in this Discord server.',
} as const;

const ITCHIO_SERVER_API_BASE = 'https://itch.io/api/1/key';
const ITCHIO_OAUTH_API_BASE = 'https://api.itch.io';

type ItchioRuntimeLogger = Pick<StructuredLogger, 'warn'>;
type ItchioFetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface ItchioCredentialsInfo {
  scopes?: string[];
  expires_at?: string;
}

export interface ItchioCurrentUser {
  id: string;
  username?: string;
  displayName?: string;
  profileUrl?: string;
}

export interface ItchioOwnedKeyRecord {
  ownedKeyId: string;
  gameId: string;
  purchaseId?: string;
  gameTitle?: string;
  gameUrl?: string;
}

export interface ItchioRuntimePorts<TClient extends ProviderRuntimeClient = ProviderRuntimeClient> {
  readonly logger: ItchioRuntimeLogger;
  getEncryptedCredential(authUserId: string, ctx: ProviderContext<TClient>): Promise<string | null>;
  decryptCredential(encryptedCredential: string, ctx: ProviderContext<TClient>): Promise<string>;
  listCollaboratorConnections?(ctx: ProviderContext<TClient>): Promise<
    Array<{
      id: string;
      provider: string;
      credentialEncrypted?: string;
      collaboratorDisplayName?: string;
    }>
  >;
  fetchImpl?: ItchioFetchLike;
}

export type ItchioProviderRuntime<TClient extends ProviderRuntimeClient = ProviderRuntimeClient> =
  Omit<ProviderRuntimeModule<never, TClient>, 'backfill' | 'buyerVerification'> & {
    readonly buyerVerification?: undefined;
  };

type ItchioGameRecord = {
  id?: number;
  title?: string;
  url?: string;
  published?: boolean;
};

function getFetch(ports: Pick<ItchioRuntimePorts, 'fetchImpl'>): ItchioFetchLike {
  return ports.fetchImpl ?? fetch;
}

function buildItchioApiUrl(path: string, searchParams?: Record<string, string>): string {
  const url = new URL(`${ITCHIO_SERVER_API_BASE}${path}`);
  for (const [key, value] of Object.entries(searchParams ?? {})) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

function extractItchioError(data: { errors?: string[] }, status: number): string {
  return data.errors?.[0] ?? `itch.io API error: HTTP ${status}`;
}

function normalizeItchioGames(games: unknown): ItchioGameRecord[] {
  if (Array.isArray(games)) {
    return games;
  }
  if (games && typeof games === 'object') {
    return Object.values(games).filter((game): game is ItchioGameRecord =>
      Boolean(game && typeof game === 'object')
    );
  }
  return [];
}

async function readItchioJson<T extends { errors?: string[] }>(
  response: Response,
  options: { treatUnauthorizedAsExpired?: boolean } = {}
): Promise<T> {
  if (response.status === 401 && options.treatUnauthorizedAsExpired) {
    throw new CredentialExpiredError('itchio');
  }

  const data = (await response.json()) as T;
  if (!response.ok) {
    throw new Error(extractItchioError(data, response.status));
  }
  return data;
}

export function itchioScopeSatisfied(
  grantedScopes: readonly string[],
  requiredScope: string
): boolean {
  return grantedScopes.some(
    (grantedScope) => grantedScope === requiredScope || requiredScope.startsWith(`${grantedScope}:`)
  );
}

export async function fetchItchioCredentialsInfo(
  accessToken: string,
  ports: Pick<ItchioRuntimePorts, 'fetchImpl'> = {}
): Promise<ItchioCredentialsInfo> {
  // itch.io OAuth and server-side API docs:
  // https://itch.io/docs/api/oauth
  // https://itch.io/docs/api/serverside#reference/httpsitchioapi1keycredentialsinfo
  const response = await getFetch(ports)(buildItchioApiUrl('/credentials/info'), {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
  });

  return await readItchioJson<ItchioCredentialsInfo & { errors?: string[] }>(response, {
    treatUnauthorizedAsExpired: true,
  });
}

export async function fetchItchioCurrentUser(
  accessToken: string,
  ports: Pick<ItchioRuntimePorts, 'fetchImpl'> = {}
): Promise<ItchioCurrentUser> {
  // itch.io server-side API docs:
  // https://itch.io/docs/api/serverside#reference/profileme-httpsitchioapi1keyme
  const response = await getFetch(ports)(buildItchioApiUrl('/me'), {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
  });

  const data = await readItchioJson<{
    errors?: string[];
    user?: {
      id?: number;
      username?: string;
      display_name?: string;
      url?: string;
    };
  }>(response, { treatUnauthorizedAsExpired: true });

  const userId = data.user?.id;
  if (userId == null) {
    throw new Error('itch.io API response did not include a user id');
  }

  return {
    id: String(userId),
    username: data.user?.username,
    displayName: data.user?.display_name,
    profileUrl: data.user?.url,
  };
}

export async function fetchItchioOwnedKeys(
  accessToken: string,
  ports: Pick<ItchioRuntimePorts, 'fetchImpl'> = {}
): Promise<ItchioOwnedKeyRecord[]> {
  const ownedKeys: ItchioOwnedKeyRecord[] = [];

  for (let page = 1; page <= 100; page += 1) {
    // itch.io OAuth docs:
    // https://itch.io/docs/api/oauth
    // Community pagination/reference shape:
    // https://github.com/ericlewis/playdate-itchio-sync/blob/main/src/itchio.ts
    const url = new URL(`${ITCHIO_OAUTH_API_BASE}/profile/owned-keys`);
    url.searchParams.set('page', String(page));

    const response = await getFetch(ports)(url.toString(), {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
    });

    const data = await readItchioJson<{
      errors?: string[];
      owned_keys?: Array<{
        id?: number;
        game_id?: number;
        purchase_id?: number;
        game?: {
          id?: number;
          title?: string;
          url?: string;
        };
      }>;
    }>(response, { treatUnauthorizedAsExpired: true });

    const pageRecords = (data.owned_keys ?? [])
      .filter(
        (ownedKey): ownedKey is NonNullable<typeof ownedKey> & { id: number; game_id: number } =>
          ownedKey?.id != null && ownedKey.game_id != null
      )
      .map((ownedKey) => ({
        ownedKeyId: String(ownedKey.id),
        gameId: String(ownedKey.game_id),
        purchaseId: ownedKey.purchase_id != null ? String(ownedKey.purchase_id) : undefined,
        gameTitle: ownedKey.game?.title,
        gameUrl: ownedKey.game?.url,
      }));

    if (pageRecords.length === 0) {
      break;
    }

    ownedKeys.push(...pageRecords);
  }

  return ownedKeys;
}

async function listItchioGames(
  accessToken: string,
  ports: Pick<ItchioRuntimePorts, 'fetchImpl'>
): Promise<ProductRecord[]> {
  // itch.io server-side API docs:
  // https://itch.io/docs/api/serverside#reference/profilegames-httpsitchioapi1keymy-games
  const response = await getFetch(ports)(buildItchioApiUrl('/my-games'), {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
  });

  const data = await readItchioJson<{
    errors?: string[];
    games?: ItchioGameRecord[] | Record<string, ItchioGameRecord>;
  }>(response, { treatUnauthorizedAsExpired: true });

  return normalizeItchioGames(data.games)
    .filter((game): game is NonNullable<typeof game> & { id: number } => game?.id != null)
    .map((game) => ({
      id: String(game.id),
      name: game.title,
      productUrl: game.url,
      published: game.published ?? false,
    }));
}

export async function verifyItchioDownloadKey(
  downloadKey: string,
  gameId: string,
  accessToken: string,
  ports: Pick<ItchioRuntimePorts, 'fetchImpl'> = {}
): Promise<{
  valid: boolean;
  externalOrderId?: string;
  providerProductId?: string;
  providerUserId?: string;
  error?: string;
}> {
  // itch.io server-side API docs:
  // https://itch.io/docs/api/serverside#reference/gameviewpurchases-httpsitchioapi1keygamegame-iddownload-keys
  const response = await getFetch(ports)(
    buildItchioApiUrl(`/game/${encodeURIComponent(gameId)}/download_keys`, {
      download_key: downloadKey,
    }),
    {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );

  const data = (await response.json()) as {
    errors?: string[];
    download_key?: {
      id?: number;
      game_id?: number;
      owner?: { id?: number };
    };
  };

  if (response.status === 401) {
    throw new CredentialExpiredError('itchio');
  }

  if (!response.ok || data.errors?.length) {
    return {
      valid: false,
      error: extractItchioError(data, response.status),
    };
  }

  return {
    valid: true,
    externalOrderId: data.download_key?.id != null ? String(data.download_key.id) : undefined,
    providerProductId:
      data.download_key?.game_id != null ? String(data.download_key.game_id) : undefined,
    providerUserId:
      data.download_key?.owner?.id != null ? String(data.download_key.owner.id) : undefined,
  };
}

export function createItchioLicenseVerification<
  TClient extends ProviderRuntimeClient = ProviderRuntimeClient,
>(ports: ItchioRuntimePorts<TClient>): LicenseVerificationPlugin<TClient> {
  return {
    async verifyLicense(downloadKey, productId, authUserId, ctx) {
      if (!productId) {
        return { valid: false, error: 'Game ID is required for itch.io verification' };
      }

      const encryptedToken = await ports.getEncryptedCredential(authUserId, ctx);
      if (!encryptedToken) {
        return {
          valid: false,
          error: 'itch.io is not connected for this creator. Ask them to reconnect and try again.',
        };
      }

      try {
        const accessToken = await ports.decryptCredential(encryptedToken, ctx);
        return await verifyItchioDownloadKey(downloadKey, productId, accessToken, ports);
      } catch (error) {
        if (error instanceof CredentialExpiredError) {
          return {
            valid: false,
            error:
              'The creator itch.io connection has expired. Ask them to reconnect the store and try again.',
          };
        }
        throw error;
      }
    },
  };
}

export function createItchioProviderModule<
  TClient extends ProviderRuntimeClient = ProviderRuntimeClient,
>(ports: ItchioRuntimePorts<TClient>): ItchioProviderRuntime<TClient> {
  return {
    id: 'itchio',
    needsCredential: true,
    supportsCollab: true,
    purposes: ITCHIO_PURPOSES,
    displayMeta: ITCHIO_DISPLAY_META,
    async getCredential(ctx) {
      const encryptedToken = await ports.getEncryptedCredential(ctx.authUserId, ctx);
      if (!encryptedToken) {
        return null;
      }
      return await ports.decryptCredential(encryptedToken, ctx);
    },
    async fetchProducts(credential, ctx): Promise<ProductRecord[]> {
      const products: ProductRecord[] = [];

      if (credential) {
        products.push(...(await listItchioGames(credential, ports)));
      }

      try {
        const collabConnections = (await ports.listCollaboratorConnections?.(ctx)) ?? [];
        for (const collab of collabConnections) {
          if (collab.provider !== 'itchio' || !collab.credentialEncrypted) {
            continue;
          }
          try {
            const collabCredential = await ports.decryptCredential(collab.credentialEncrypted, ctx);
            const collabProducts = await listItchioGames(collabCredential, ports);
            for (const product of collabProducts) {
              products.push({
                ...product,
                collaboratorName: collab.collaboratorDisplayName ?? 'Collaborator',
              });
            }
          } catch (error) {
            ports.logger.warn('Failed to fetch products for itch.io collaborator', {
              collabId: collab.id,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      } catch (error) {
        ports.logger.warn('Failed to fetch collaborator connections for itch.io product list', {
          error: error instanceof Error ? error.message : String(error),
        });
      }

      const seen = new Set<string>();
      return products.filter((product) => {
        if (seen.has(product.id)) {
          return false;
        }
        seen.add(product.id);
        return true;
      });
    },
    verification: createItchioLicenseVerification(ports),
    async collabValidate(credential: string): Promise<void> {
      await fetchItchioCredentialsInfo(credential, ports);
      await fetchItchioCurrentUser(credential, ports);
    },
    collabCredentialPurpose: ITCHIO_PURPOSES.credential,
  };
}
