/**
 * Publish a Backstage package artifact through the public API contract that the Unity exporter should use.
 *
 * Usage:
 *   bun run publish:backstage-package -- --packageId com.yucp.example --catalogProductId product_123 --version 1.2.3 --sourcePath E:\exports\example.unitypackage
 *   bun run publish:backstage-package -- --packageId com.yucp.example --catalogProductId product_123 --version 1.2.3 --storageId kg2abc123...
 *
 * Authentication:
 *   Provide a Better Auth access token with the public API audience and at least the `profile:read`
 *   scope. The external Unity exporter can reuse the same OAuth token it already obtains for YUCP.
 */

import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { prepareBackstageArtifactForPublish } from '@yucp/shared/backstageVpmPackage';

type FetchLike = typeof fetch;

export type PublishBackstagePackageConfig = {
  apiBaseUrl: string;
  accessToken: string;
  packageId: string;
  catalogProductId: string;
  version: string;
  sourcePath?: string;
  storageId?: string;
  zipSha256?: string;
  channel?: string;
  packageName?: string;
  displayName?: string;
  description?: string;
  repositoryVisibility?: 'hidden' | 'listed';
  defaultChannel?: string;
  unityVersion?: string;
  metadata?: unknown;
  deliveryName?: string;
  contentType?: string;
  releaseStatus?: 'draft' | 'published' | 'revoked' | 'superseded';
};

type UploadUrlResponse = {
  packageId: string;
  uploadUrl: string;
};

type UploadStorageResponse = {
  storageId?: string;
};

export type PublishBackstagePackageResult = {
  deliveryPackageReleaseId: string;
  artifactId: string;
  artifactKey: string;
  zipSha256: string;
  version: string;
  channel: string;
};

function inferBackstageArtifactContentType(sourcePath: string): string {
  return sourcePath.toLowerCase().endsWith('.unitypackage')
    ? 'application/octet-stream'
    : 'application/zip';
}

const SHA256_HEX_RE = /^[a-f0-9]{64}$/;

function trimOptional(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function trimRequired(value: string | undefined, label: string): string {
  const normalized = trimOptional(value);
  if (!normalized) {
    throw new Error(`${label} is required`);
  }
  return normalized;
}

function parseMetadata(value: string | undefined): unknown {
  const normalized = trimOptional(value);
  if (!normalized) {
    return undefined;
  }
  return JSON.parse(normalized);
}

export function printUsage(): void {
  console.log(`publish-backstage-package

Usage:
  bun run publish:backstage-package -- --packageId com.yucp.example --catalogProductId product_123 --version 1.2.3 --sourcePath E:\\exports\\example.unitypackage
  bun run publish:backstage-package -- --packageId com.yucp.example --catalogProductId product_123 --version 1.2.3 --storageId kg2abc123...

Options:
  --apiBaseUrl <url>                Public API base URL. Defaults to YUCP_API_BASE_URL or http://localhost:3001.
  --accessToken <token>             Better Auth access token. Defaults to YUCP_ACCESS_TOKEN.
  --packageId <id>                  Backstage package id to publish.
  --catalogProductId <id>           Catalog product id that grants entitlement access.
  --version <value>                 Version string to publish.
  --sourcePath <path>               Package artifact to upload before publishing.
  --storageId <id>                  Reuse an existing Convex Storage upload instead of uploading a file.
  --zipSha256 <hex>                 SHA-256 digest for the artifact. Auto-computed when sourcePath is provided.
  --channel <value>                 Release channel. Defaults to stable.
  --packageName <value>             Optional package name metadata.
  --displayName <value>             Optional display name metadata.
  --description <value>             Optional description metadata.
  --repositoryVisibility <value>    hidden or listed.
  --defaultChannel <value>          Default channel metadata for the package.
  --unityVersion <value>            Optional Unity version metadata for the release.
  --metadataJson <json>             Optional release metadata JSON object.
  --deliveryName <value>            Override the delivered filename.
  --contentType <value>             Override the uploaded content type. Defaults to an inferred value from the source file.
  --releaseStatus <value>           draft, published, revoked, or superseded. Defaults to published.
  --help                            Show this message.

Environment:
  YUCP_API_BASE_URL                 Default value for --apiBaseUrl.
  YUCP_ACCESS_TOKEN                 Default value for --accessToken.
`);
}

export function resolvePublishBackstagePackageConfig(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env
): PublishBackstagePackageConfig {
  const { values } = parseArgs({
    args: argv,
    options: {
      apiBaseUrl: { type: 'string' },
      accessToken: { type: 'string' },
      packageId: { type: 'string' },
      catalogProductId: { type: 'string' },
      version: { type: 'string' },
      sourcePath: { type: 'string' },
      storageId: { type: 'string' },
      zipSha256: { type: 'string' },
      channel: { type: 'string' },
      packageName: { type: 'string' },
      displayName: { type: 'string' },
      description: { type: 'string' },
      repositoryVisibility: { type: 'string' },
      defaultChannel: { type: 'string' },
      unityVersion: { type: 'string' },
      metadataJson: { type: 'string' },
      deliveryName: { type: 'string' },
      contentType: { type: 'string' },
      releaseStatus: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.help) {
    printUsage();
    process.exit(0);
  }

  const sourcePath = trimOptional(values.sourcePath);
  const storageId = trimOptional(values.storageId);
  const zipSha256 = trimOptional(values.zipSha256)?.toLowerCase();
  if (!sourcePath && !storageId) {
    throw new Error('Either sourcePath or storageId is required');
  }
  if (sourcePath && !existsSync(sourcePath)) {
    throw new Error(`Backstage package artifact not found: ${sourcePath}`);
  }
  if (zipSha256 && !SHA256_HEX_RE.test(zipSha256)) {
    throw new Error('zipSha256 must be a lowercase 64-character SHA-256 hex digest');
  }
  if (storageId && !sourcePath && !zipSha256) {
    throw new Error('zipSha256 is required when publishing an existing storageId');
  }

  const repositoryVisibility = trimOptional(values.repositoryVisibility);
  if (
    repositoryVisibility &&
    repositoryVisibility !== 'hidden' &&
    repositoryVisibility !== 'listed'
  ) {
    throw new Error('repositoryVisibility must be hidden or listed');
  }

  const releaseStatus = trimOptional(values.releaseStatus);
  if (
    releaseStatus &&
    releaseStatus !== 'draft' &&
    releaseStatus !== 'published' &&
    releaseStatus !== 'revoked' &&
    releaseStatus !== 'superseded'
  ) {
    throw new Error('releaseStatus must be draft, published, revoked, or superseded');
  }

  return {
    apiBaseUrl: trimRequired(values.apiBaseUrl ?? env.YUCP_API_BASE_URL, 'apiBaseUrl'),
    accessToken: trimRequired(values.accessToken ?? env.YUCP_ACCESS_TOKEN, 'accessToken'),
    packageId: trimRequired(values.packageId, 'packageId'),
    catalogProductId: trimRequired(values.catalogProductId, 'catalogProductId'),
    version: trimRequired(values.version, 'version'),
    sourcePath,
    storageId,
    zipSha256,
    channel: trimOptional(values.channel),
    packageName: trimOptional(values.packageName),
    displayName: trimOptional(values.displayName),
    description: trimOptional(values.description),
    repositoryVisibility: repositoryVisibility as
      | PublishBackstagePackageConfig['repositoryVisibility']
      | undefined,
    defaultChannel: trimOptional(values.defaultChannel),
    unityVersion: trimOptional(values.unityVersion),
    metadata: parseMetadata(values.metadataJson),
    deliveryName: trimOptional(values.deliveryName),
    contentType: trimOptional(values.contentType),
    releaseStatus: releaseStatus as PublishBackstagePackageConfig['releaseStatus'] | undefined,
  };
}

async function readJsonResponse<T>(response: Response): Promise<T | undefined> {
  const text = await response.text();
  if (!text.trim()) {
    return undefined;
  }
  return JSON.parse(text) as T;
}

async function assertApiResponse<T>(response: Response, fallback: string): Promise<T> {
  const payload = await readJsonResponse<{ error?: string } & T>(response);
  if (!response.ok) {
    throw new Error(payload?.error || `${fallback} (${response.status} ${response.statusText})`);
  }
  return payload as T;
}

export async function computeFileSha256(sourcePath: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(sourcePath);
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

function buildApiUrl(apiBaseUrl: string, path: string): string {
  return new URL(path, apiBaseUrl.endsWith('/') ? apiBaseUrl : `${apiBaseUrl}/`).toString();
}

export async function requestBackstageUploadUrl(
  config: Pick<PublishBackstagePackageConfig, 'apiBaseUrl' | 'accessToken' | 'packageId'>,
  fetchImpl: FetchLike = fetch
): Promise<string> {
  const response = await fetchImpl(
    buildApiUrl(
      config.apiBaseUrl,
      `/api/packages/${encodeURIComponent(config.packageId)}/backstage/upload-url`
    ),
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.accessToken}`,
      },
    }
  );
  const payload = await assertApiResponse<UploadUrlResponse>(
    response,
    'Failed to create Backstage upload URL'
  );
  const uploadUrl = trimOptional(payload.uploadUrl);
  if (!uploadUrl) {
    throw new Error('Backstage upload URL response did not include uploadUrl');
  }
  return uploadUrl;
}

export async function uploadBackstagePackageArtifact(
  uploadUrl: string,
  artifactBody: BodyInit,
  contentType: string,
  fetchImpl: FetchLike = fetch
): Promise<string> {
  const response = await fetchImpl(uploadUrl, {
    method: 'POST',
    headers: {
      'Content-Type': contentType,
    },
    body: artifactBody,
  });
  const payload = await assertApiResponse<UploadStorageResponse>(
    response,
    'Failed to upload Backstage package artifact'
  );
  const storageId = trimOptional(payload.storageId);
  if (!storageId) {
    throw new Error('Backstage artifact upload did not return storageId');
  }
  return storageId;
}

export async function publishBackstageRelease(
  config: PublishBackstagePackageConfig,
  storageId: string,
  zipSha256: string,
  fetchImpl: FetchLike = fetch
): Promise<PublishBackstagePackageResult> {
  const response = await fetchImpl(
    buildApiUrl(
      config.apiBaseUrl,
      `/api/packages/${encodeURIComponent(config.packageId)}/backstage/releases`
    ),
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        catalogProductId: config.catalogProductId,
        storageId,
        version: config.version,
        zipSha256,
        ...(config.channel ? { channel: config.channel } : {}),
        ...(config.packageName ? { packageName: config.packageName } : {}),
        ...(config.displayName ? { displayName: config.displayName } : {}),
        ...(config.description ? { description: config.description } : {}),
        ...(config.repositoryVisibility
          ? { repositoryVisibility: config.repositoryVisibility }
          : {}),
        ...(config.defaultChannel ? { defaultChannel: config.defaultChannel } : {}),
        ...(config.unityVersion ? { unityVersion: config.unityVersion } : {}),
        ...(config.metadata !== undefined ? { metadata: config.metadata } : {}),
        ...(config.deliveryName ? { deliveryName: config.deliveryName } : {}),
        ...(config.contentType ? { contentType: config.contentType } : {}),
        ...(config.releaseStatus ? { releaseStatus: config.releaseStatus } : {}),
      }),
    }
  );
  return await assertApiResponse<PublishBackstagePackageResult>(
    response,
    'Failed to publish Backstage release'
  );
}

export async function publishBackstagePackage(
  config: PublishBackstagePackageConfig,
  fetchImpl: FetchLike = fetch
): Promise<PublishBackstagePackageResult> {
  const sourcePath = config.sourcePath;
  const sourceIsUnitypackage = sourcePath?.toLowerCase().endsWith('.unitypackage') ?? false;
  const preparedArtifact =
    sourcePath && sourceIsUnitypackage
      ? await prepareBackstageArtifactForPublish({
          packageId: config.packageId,
          version: config.version,
          displayName: config.displayName,
          description: config.description,
          unityVersion: config.unityVersion,
          metadata: config.metadata,
          deliveryName: config.deliveryName,
          sourceBytes: new Uint8Array(await Bun.file(sourcePath).arrayBuffer()),
          sourceFileName: sourcePath.split(/[\\/]/).pop() ?? sourcePath,
        })
      : null;
  const zipSha256 =
    preparedArtifact?.zipSha256 ||
    config.zipSha256 ||
    (sourcePath ? await computeFileSha256(sourcePath) : undefined);
  if (!zipSha256) {
    throw new Error('zipSha256 is required before publishing a Backstage artifact');
  }
  const storageId =
    config.storageId ||
    (await uploadBackstagePackageArtifact(
      await requestBackstageUploadUrl(config, fetchImpl),
      preparedArtifact ? preparedArtifact.bytes : Bun.file(sourcePath as string),
      preparedArtifact?.contentType ??
        config.contentType ??
        inferBackstageArtifactContentType(sourcePath as string),
      fetchImpl
    ));
  return await publishBackstageRelease(
    {
      ...config,
      ...(preparedArtifact
        ? {
            contentType: preparedArtifact.contentType,
            deliveryName: preparedArtifact.deliveryName,
            metadata: config.metadata === undefined ? preparedArtifact.metadata : config.metadata,
          }
        : {}),
    },
    storageId,
    zipSha256,
    fetchImpl
  );
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const config = resolvePublishBackstagePackageConfig(argv);
  const result = await publishBackstagePackage(config);
  console.log(
    `[publish-backstage-package] published ${config.packageId}@${result.version} channel=${result.channel}`
  );
  console.log(
    `[publish-backstage-package] releaseId=${result.deliveryPackageReleaseId} artifactId=${result.artifactId}`
  );
}

if (import.meta.main) {
  main().catch((error) => {
    console.error('[publish-backstage-package]', error);
    process.exit(1);
  });
}
