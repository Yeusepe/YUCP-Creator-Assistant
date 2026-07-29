import type { CasConfig } from './config';
import { S3ExactStoragePort, type StorageRole } from './exactStorage';

type GcStorageRole = Extract<StorageRole, 'common' | 'metadata' | 'protected'>;
export type BackblazeFetch = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

export type ExactVersionDeletionInput = {
  fileIdentifier: string;
  objectKey: string;
  providerVersion: string;
  role: GcStorageRole;
};

export interface ExactVersionDeletionPort {
  deleteExactVersion(input: ExactVersionDeletionInput): Promise<void>;
}

export class ExactVersionDeletionBlockedError extends Error {
  constructor() {
    super('Exact provider version is protected by Object Lock');
    this.name = 'ExactVersionDeletionBlockedError';
  }
}

type BackblazeAuthorization = {
  apiUrl: string;
  authorizationToken: string;
  authorizedAt: number;
  bucketNames: Set<string>;
  capabilities: Set<string>;
  namePrefix: string | null;
  s3ApiUrl: string;
};

type BackblazeError = {
  code: string;
  message: string;
  status: number;
};

const B2_AUTHORIZE_ACCOUNT_URL = 'https://api.backblazeb2.com/b2api/v4/b2_authorize_account';
const B2_AUTHORIZATION_CACHE_MS = 23 * 60 * 60 * 1_000;

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Backblaze ${name} is invalid`);
  }
  return value.trim();
}

function safeBackblazeUrl(value: unknown, name: string): string {
  const url = new URL(requiredString(value, name));
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    !url.hostname.endsWith('.backblazeb2.com')
  ) {
    throw new Error(`Backblaze ${name} is invalid`);
  }
  return url.origin;
}

async function jsonObject(response: Response, operation: string): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new Error(`Backblaze ${operation} returned invalid JSON`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Backblaze ${operation} returned an invalid response`);
  }
  return value as Record<string, unknown>;
}

async function backblazeError(response: Response, operation: string): Promise<BackblazeError> {
  const value = await jsonObject(response, operation);
  return {
    code: requiredString(value.code, `${operation} error code`),
    message: requiredString(value.message, `${operation} error message`),
    status:
      typeof value.status === 'number' && Number.isSafeInteger(value.status)
        ? value.status
        : response.status,
  };
}

function backblazeFailure(operation: string, error: BackblazeError): Error {
  return new Error(
    `Backblaze ${operation} failed with HTTP status ${error.status} and code ${error.code}`
  );
}

function isBackblazeS3Endpoint(config: CasConfig): boolean {
  const url = new URL(config.endpoint);
  return (
    url.protocol === 'https:' &&
    /^s3\.[a-z0-9-]+\.backblazeb2\.com$/u.test(url.hostname) &&
    url.pathname === '/'
  );
}

export class S3ExactVersionDeletionPort implements ExactVersionDeletionPort {
  readonly #storage: S3ExactStoragePort;

  constructor(configs: Partial<Record<GcStorageRole, CasConfig>>) {
    this.#storage = new S3ExactStoragePort(configs);
  }

  deleteExactVersion(input: ExactVersionDeletionInput): Promise<void> {
    return this.#storage.deleteExactVersion({
      objectKey: input.objectKey,
      providerVersion: input.providerVersion,
      role: input.role,
    });
  }
}

/**
 * Backblaze authorization response:
 * https://www.backblaze.com/apidocs/b2-authorize-account
 *
 * Exact file-version deletion:
 * https://www.backblaze.com/apidocs/b2-delete-file-version
 */
export class BackblazeB2ExactVersionDeletionPort implements ExactVersionDeletionPort {
  readonly #authorizations = new Map<GcStorageRole, Promise<BackblazeAuthorization>>();
  readonly #configs: Readonly<Partial<Record<GcStorageRole, CasConfig>>>;
  readonly #fetch: BackblazeFetch;

  constructor(
    configs: Partial<Record<GcStorageRole, CasConfig>>,
    fetchImpl: BackblazeFetch = fetch
  ) {
    this.#configs = Object.fromEntries(
      Object.entries(configs).map(([role, config]) => [role, config ? { ...config } : config])
    );
    this.#fetch = fetchImpl;
  }

  #config(role: GcStorageRole): CasConfig {
    const config = this.#configs[role];
    if (!config) {
      throw new Error(`Storage role ${role} is not configured for Backblaze deletion`);
    }
    if (!isBackblazeS3Endpoint(config)) {
      throw new Error(`Storage role ${role} is not configured with a Backblaze S3 endpoint`);
    }
    return config;
  }

  async #authorize(role: GcStorageRole): Promise<BackblazeAuthorization> {
    const config = this.#config(role);
    const response = await this.#fetch(B2_AUTHORIZE_ACCOUNT_URL, {
      headers: {
        authorization: `Basic ${Buffer.from(
          `${config.accessKeyId}:${config.secretAccessKey}`,
          'utf8'
        ).toString('base64')}`,
      },
      method: 'GET',
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    });
    if (!response.ok) {
      throw backblazeFailure(
        'b2_authorize_account',
        await backblazeError(response, 'b2_authorize_account')
      );
    }
    const value = await jsonObject(response, 'b2_authorize_account');
    const apiInfo =
      value.apiInfo && typeof value.apiInfo === 'object' && !Array.isArray(value.apiInfo)
        ? (value.apiInfo as Record<string, unknown>)
        : undefined;
    const storageApi =
      apiInfo?.storageApi &&
      typeof apiInfo.storageApi === 'object' &&
      !Array.isArray(apiInfo.storageApi)
        ? (apiInfo.storageApi as Record<string, unknown>)
        : undefined;
    const allowed =
      storageApi?.allowed &&
      typeof storageApi.allowed === 'object' &&
      !Array.isArray(storageApi.allowed)
        ? (storageApi.allowed as Record<string, unknown>)
        : undefined;
    if (!storageApi || !allowed) {
      throw new Error('Backblaze b2_authorize_account omitted storage API authorization');
    }
    const capabilities = new Set(
      Array.isArray(allowed.capabilities)
        ? allowed.capabilities.map((capability) =>
            requiredString(capability, 'authorization capability')
          )
        : []
    );
    if (!capabilities.has('deleteFiles')) {
      throw new Error('Backblaze application key requires the deleteFiles capability');
    }
    const bucketNames = new Set(
      Array.isArray(allowed.buckets)
        ? allowed.buckets.flatMap((bucket) => {
            if (!bucket || typeof bucket !== 'object' || Array.isArray(bucket)) {
              throw new Error('Backblaze authorization bucket is invalid');
            }
            const name = (bucket as Record<string, unknown>).name;
            return name === null ? [] : [requiredString(name, 'authorization bucket name')];
          })
        : []
    );
    if (!bucketNames.has(config.bucket)) {
      throw new Error(`Backblaze application key is not authorized for bucket ${config.bucket}`);
    }
    const apiUrl = safeBackblazeUrl(storageApi.apiUrl, 'storage API URL');
    const s3ApiUrl = safeBackblazeUrl(storageApi.s3ApiUrl, 'S3 API URL');
    if (s3ApiUrl !== new URL(config.endpoint).origin) {
      throw new Error('Backblaze authorization returned an unexpected S3 API endpoint');
    }
    const namePrefix =
      allowed.namePrefix === null
        ? null
        : requiredString(allowed.namePrefix, 'authorization name prefix');
    return {
      apiUrl,
      authorizationToken: requiredString(value.authorizationToken, 'authorization token'),
      authorizedAt: Date.now(),
      bucketNames,
      capabilities,
      namePrefix,
      s3ApiUrl,
    };
  }

  async #authorization(role: GcStorageRole, forceRefresh = false): Promise<BackblazeAuthorization> {
    const existing = this.#authorizations.get(role);
    if (!forceRefresh && existing) {
      const authorization = await existing;
      if (Date.now() - authorization.authorizedAt < B2_AUTHORIZATION_CACHE_MS) {
        return authorization;
      }
    }
    const authorization = this.#authorize(role);
    this.#authorizations.set(role, authorization);
    try {
      return await authorization;
    } catch (error) {
      if (this.#authorizations.get(role) === authorization) {
        this.#authorizations.delete(role);
      }
      throw error;
    }
  }

  async deleteExactVersion(input: ExactVersionDeletionInput): Promise<void> {
    const fileIdentifier = requiredString(input.fileIdentifier, 'file identifier');
    const objectKey = requiredString(input.objectKey, 'file name');
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const authorization = await this.#authorization(input.role, attempt > 0);
      if (authorization.namePrefix !== null && !objectKey.startsWith(authorization.namePrefix)) {
        throw new Error('Backblaze application key name prefix does not allow the object key');
      }
      const config = this.#config(input.role);
      const response = await this.#fetch(
        `${authorization.apiUrl}/b2api/v4/b2_delete_file_version`,
        {
          body: JSON.stringify({
            fileId: fileIdentifier,
            fileName: objectKey,
          }),
          headers: {
            authorization: authorization.authorizationToken,
            'content-type': 'application/json',
          },
          method: 'POST',
          signal: AbortSignal.timeout(config.requestTimeoutMs),
        }
      );
      if (response.ok) {
        const value = await jsonObject(response, 'b2_delete_file_version');
        if (
          requiredString(value.fileId, 'deleted file identifier') !== fileIdentifier ||
          requiredString(value.fileName, 'deleted file name') !== objectKey
        ) {
          throw new Error('Backblaze exact-version deletion returned a different file');
        }
        return;
      }
      const error = await backblazeError(response, 'b2_delete_file_version');
      if (error.status === 400 && error.code === 'file_not_present') {
        return;
      }
      if (error.status === 401 && error.code === 'access_denied') {
        throw new ExactVersionDeletionBlockedError();
      }
      if (
        attempt === 0 &&
        error.status === 401 &&
        (error.code === 'bad_auth_token' || error.code === 'expired_auth_token')
      ) {
        this.#authorizations.delete(input.role);
        continue;
      }
      throw backblazeFailure('b2_delete_file_version', error);
    }
    throw new Error('Backblaze exact-version deletion exhausted authorization refresh');
  }
}

class RoutedExactVersionDeletionPort implements ExactVersionDeletionPort {
  readonly #backblaze: BackblazeB2ExactVersionDeletionPort;
  readonly #configs: Readonly<Record<GcStorageRole, CasConfig>>;
  readonly #s3: S3ExactVersionDeletionPort;

  constructor(configs: Record<GcStorageRole, CasConfig>, fetchImpl: BackblazeFetch) {
    this.#configs = Object.fromEntries(
      Object.entries(configs).map(([role, config]) => [role, { ...config }])
    ) as Record<GcStorageRole, CasConfig>;
    this.#backblaze = new BackblazeB2ExactVersionDeletionPort(configs, fetchImpl);
    this.#s3 = new S3ExactVersionDeletionPort(configs);
  }

  deleteExactVersion(input: ExactVersionDeletionInput): Promise<void> {
    return isBackblazeS3Endpoint(this.#configs[input.role])
      ? this.#backblaze.deleteExactVersion(input)
      : this.#s3.deleteExactVersion(input);
  }
}

export function createExactVersionDeletionPort(
  configs: Record<GcStorageRole, CasConfig>,
  fetchImpl: BackblazeFetch = fetch
): ExactVersionDeletionPort {
  return new RoutedExactVersionDeletionPort(configs, fetchImpl);
}
