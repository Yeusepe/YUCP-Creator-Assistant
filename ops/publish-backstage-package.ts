/**
 * Publish a Backstage package artifact through the public API contract that the Unity exporter should use.
 *
 * Usage:
 *   bun run publish:backstage-package -- --packageId com.yucp.example --catalogProductId product_123 --version 1.2.3 --sourcePath E:\exports\example.unitypackage
 *
 * Authentication:
 *   Provide a Better Auth access token with the public API audience and at least the `products:write`
 *   scope. The external Unity exporter can reuse the same OAuth token it already obtains for YUCP.
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { assertSecureLoreUrl } from '@yucp/shared/loreBackstageClient';
import { Upload } from 'tus-js-client';
import { pollBackstageIngestJob } from './lib/backstageIngestPoll';

type FetchLike = typeof fetch;

const BACKSTAGE_TUS_CHUNK_SIZE = 64 * 1024 * 1024;
const BACKSTAGE_TUS_UPLOAD_TIMEOUT_MS = 10 * 60 * 1000;

export type PublishBackstageReleaseConfig = {
  apiBaseUrl: string;
  accessToken: string;
  packageId: string;
  catalogProductId: string;
  version: string;
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

export type PublishBackstagePackageConfig = PublishBackstageReleaseConfig & {
  sourcePath: string;
};

type UploadAuthorizationResponse = {
  tusEndpoint: string;
  uploadToken: string;
  uploadMetadataKey: string;
  maxByteSize: number;
};

type UploadedBackstageSource = {
  ingestResult: string;
  deliveryName: string;
  sourceContentType: string;
  version: string;
};

export type PublishBackstagePackageResult = {
  deliveryPackageReleaseId: string;
  artifactId?: string;
  artifactKey?: string;
  zipSha256: string;
  version: string;
  channel: string;
};

function inferBackstageArtifactContentType(sourcePath: string): string {
  return sourcePath.toLowerCase().endsWith('.unitypackage')
    ? 'application/octet-stream'
    : 'application/zip';
}

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

Options:
  --apiBaseUrl <url>                Public API base URL. Defaults to YUCP_API_BASE_URL or http://localhost:3001.
  --accessToken <token>             Better Auth access token. Defaults to YUCP_ACCESS_TOKEN.
  --packageId <id>                  Backstage package id to publish.
  --catalogProductId <id>           Catalog product id that grants entitlement access.
  --version <value>                 Version string to publish.
  --sourcePath <path>               Package source artifact to upload to Lore before publishing.
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

Authentication:
  YUCP_ACCESS_TOKEN must include the public API audience and the products:write scope.
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
  if (!sourcePath) {
    throw new Error('sourcePath is required');
  }
  if (sourcePath && !existsSync(sourcePath)) {
    throw new Error(`Backstage package artifact not found: ${sourcePath}`);
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

function buildApiUrl(apiBaseUrl: string, path: string): string {
  return new URL(path, apiBaseUrl.endsWith('/') ? apiBaseUrl : `${apiBaseUrl}/`).toString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function sha256FilePath(sourcePath: string): Promise<{ byteSize: number; sha256: string }> {
  const hash = createHash('sha256');
  let byteSize = 0;
  const reader = Bun.file(sourcePath).stream().getReader();
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      hash.update(chunk.value);
      byteSize += chunk.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  return {
    byteSize,
    sha256: hash.digest('hex'),
  };
}

export async function uploadBackstagePackageArtifactDirect(
  config: PublishBackstagePackageConfig,
  fetchImpl: FetchLike = fetch
): Promise<UploadedBackstageSource> {
  const sourcePath = config.sourcePath;
  const deliveryName = config.deliveryName ?? sourcePath.split(/[\\/]/).pop() ?? sourcePath;
  const contentType = config.contentType ?? inferBackstageArtifactContentType(sourcePath);
  const { byteSize, sha256 } = await sha256FilePath(sourcePath);
  const authorizationResponse = await fetchImpl(
    buildApiUrl(
      config.apiBaseUrl,
      `/api/packages/${encodeURIComponent(config.packageId)}/backstage/upload-authorization`
    ),
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        version: config.version,
        deliveryName,
        sourceContentType: contentType,
        sha256,
        byteSize,
      }),
    }
  );
  const authorization = await assertApiResponse<UploadAuthorizationResponse>(
    authorizationResponse,
    'Failed to authorize Backstage package artifact upload'
  );
  const tusEndpoint = authorization.tusEndpoint?.trim();
  const uploadToken = authorization.uploadToken?.trim();
  const uploadMetadataKey = authorization.uploadMetadataKey?.trim();
  if (!tusEndpoint || !uploadToken || !uploadMetadataKey) {
    throw new Error('Backstage upload authorization response is missing TUS upload fields');
  }
  assertSecureLoreUrl(tusEndpoint, 'tusEndpoint');
  if (!Number.isSafeInteger(authorization.maxByteSize) || authorization.maxByteSize < 1) {
    throw new Error('Backstage upload authorization returned an invalid maxByteSize');
  }
  if (byteSize > authorization.maxByteSize) {
    throw new Error(
      `Source exceeds the authorized upload limit. bytes=${byteSize} maxByteSize=${authorization.maxByteSize}`
    );
  }

  // ponytail: buffering a full 2-3 GB source can OOM the operator or CI host; upgrade the TUS upload to use a file-stream source.
  const sourceBuffer = Buffer.from(await Bun.file(sourcePath).arrayBuffer());
  const ingestResult = await new Promise<string>((resolveUpload, rejectUpload) => {
    let uploadFinished = false;
    let uploadTimeout: ReturnType<typeof setTimeout>;
    const finishUpload = (): boolean => {
      if (uploadFinished) return false;
      uploadFinished = true;
      clearTimeout(uploadTimeout);
      return true;
    };
    const upload = new Upload(sourceBuffer, {
      endpoint: tusEndpoint,
      metadata: {
        [uploadMetadataKey]: uploadToken,
      },
      chunkSize: BACKSTAGE_TUS_CHUNK_SIZE,
      retryDelays: [0, 1000, 3000, 5000],
      removeFingerprintOnSuccess: true,
      onSuccess: () => {
        if (!finishUpload()) return;
        const uploadUrl = upload.url;
        if (!uploadUrl) {
          rejectUpload(new Error('Backstage ingest sidecar did not return the completed upload URL'));
          return;
        }
        if (!uploadUrl.includes('/files/')) {
          rejectUpload(
            new Error('Backstage ingest upload URL does not contain the expected /files/ path')
          );
          return;
        }
        let uploadOrigin: string;
        try {
          uploadOrigin = new URL(uploadUrl).origin;
        } catch {
          rejectUpload(new Error('Backstage ingest sidecar returned an invalid completed upload URL'));
          return;
        }
        if (uploadOrigin !== new URL(tusEndpoint).origin) {
          rejectUpload(
            new Error(
              'Backstage ingest completed upload URL does not match the authorized TUS endpoint origin'
            )
          );
          return;
        }
        const jobUrl = uploadUrl.replace('/files/', '/jobs/');
        try {
          assertSecureLoreUrl(jobUrl, 'jobUrl');
        } catch (error) {
          rejectUpload(error);
          return;
        }
        void pollBackstageIngestJob(jobUrl, uploadToken, { fetchImpl }).then(
          resolveUpload,
          rejectUpload
        );
      },
      onError: (error) => {
        if (finishUpload()) rejectUpload(error);
      },
    });
    uploadTimeout = setTimeout(() => {
      if (!finishUpload()) return;
      void upload.abort().catch(() => undefined);
      rejectUpload(
        new Error(`Backstage TUS upload timed out after ${BACKSTAGE_TUS_UPLOAD_TIMEOUT_MS}ms`)
      );
    }, BACKSTAGE_TUS_UPLOAD_TIMEOUT_MS);
    try {
      upload.start();
    } catch (error) {
      if (finishUpload()) rejectUpload(error);
    }
  });

  return {
    ingestResult,
    deliveryName,
    sourceContentType: contentType,
    version: config.version,
  };
}

export async function publishBackstageRelease(
  config: PublishBackstageReleaseConfig,
  uploadedSource: UploadedBackstageSource,
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
        ingestResult: uploadedSource.ingestResult,
        version: uploadedSource.version,
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
        ...(uploadedSource.deliveryName || config.deliveryName
          ? { deliveryName: uploadedSource.deliveryName ?? config.deliveryName }
          : {}),
        ...(uploadedSource.sourceContentType || config.contentType
          ? { sourceContentType: uploadedSource.sourceContentType ?? config.contentType }
          : {}),
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
  const uploadedSource = await uploadBackstagePackageArtifactDirect(config, fetchImpl);
  return await publishBackstageRelease(config, uploadedSource, fetchImpl);
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const config = resolvePublishBackstagePackageConfig(argv);
  const result = await publishBackstagePackage(config);
  console.log(
    `[publish-backstage-package] published ${config.packageId}@${result.version} channel=${result.channel}`
  );
  console.log(
    `[publish-backstage-package] releaseId=${result.deliveryPackageReleaseId}${result.artifactId ? ` artifactId=${result.artifactId}` : ''}`
  );
}

if (import.meta.main) {
  main().catch((error) => {
    console.error('[publish-backstage-package]', error);
    process.exit(1);
  });
}
