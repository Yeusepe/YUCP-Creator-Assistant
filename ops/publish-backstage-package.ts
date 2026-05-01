/**
 * Publish a Backstage package artifact through the public API contract that the Unity exporter should use.
 *
 * Usage:
 *   bun run publish:backstage-package -- --packageId com.yucp.example --catalogProductId product_123 --version 1.2.3 --sourcePath E:\exports\example.unitypackage
 *
 * Authentication:
 *   Provide a Better Auth access token with the public API audience and at least the `profile:read`
 *   scope. The external Unity exporter can reuse the same OAuth token it already obtains for YUCP.
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import type { CdngineBackstageSourceReference } from '@yucp/shared/cdngineBackstageDelivery';

type FetchLike = typeof fetch;

export type PublishBackstagePackageConfig = {
  apiBaseUrl: string;
  accessToken: string;
  packageId: string;
  catalogProductId: string;
  version: string;
  sourcePath: string;
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

type UploadSessionResponse = {
  completeUrl: string;
  packageId: string;
  uploadSessionId: string;
  uploadTarget: {
    method: string;
    protocol: 'tus';
    url: string;
  };
};

type UploadStorageResponse = {
  cdngineSource?: CdngineBackstageSourceReference;
  deliveryName?: string;
  sourceContentType?: string;
};

type UploadedBackstageSource = {
  cdngineSource: CdngineBackstageSourceReference;
  deliveryName?: string;
  sourceContentType?: string;
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
  --sourcePath <path>               Package source artifact to upload to CDNgine before publishing.
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
  deliveryName: string,
  fetchImpl: FetchLike = fetch
): Promise<UploadedBackstageSource> {
  const response = await fetchImpl(uploadUrl, {
    method: 'POST',
    headers: {
      'Content-Type': contentType,
      'X-YUCP-File-Name': encodeURIComponent(deliveryName),
    },
    body: artifactBody,
  });
  const payload = await assertApiResponse<UploadStorageResponse>(
    response,
    'Failed to upload Backstage package artifact'
  );
  if (!payload?.cdngineSource) {
    throw new Error('Backstage artifact upload did not return CDNgine source coordinates');
  }
  return {
    cdngineSource: payload.cdngineSource,
    deliveryName: payload.deliveryName,
    sourceContentType: payload.sourceContentType,
  };
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

export async function requestBackstageUploadSession(
  config: Pick<PublishBackstagePackageConfig, 'apiBaseUrl' | 'accessToken' | 'packageId'> & {
    byteSize: number;
    contentType: string;
    deliveryName: string;
    sha256: string;
  },
  fetchImpl: FetchLike = fetch
): Promise<UploadSessionResponse> {
  const response = await fetchImpl(
    buildApiUrl(
      config.apiBaseUrl,
      `/api/packages/${encodeURIComponent(config.packageId)}/backstage/upload-session`
    ),
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        byteSize: config.byteSize,
        deliveryName: config.deliveryName,
        sha256: config.sha256,
        sourceContentType: config.contentType,
      }),
    }
  );
  return await assertApiResponse<UploadSessionResponse>(
    response,
    'Failed to create Backstage upload session'
  );
}

export async function uploadBackstagePackageArtifactDirect(
  config: PublishBackstagePackageConfig,
  fetchImpl: FetchLike = fetch
): Promise<UploadedBackstageSource> {
  const sourcePath = config.sourcePath;
  const deliveryName = config.deliveryName ?? sourcePath.split(/[\\/]/).pop() ?? sourcePath;
  const contentType = config.contentType ?? inferBackstageArtifactContentType(sourcePath);
  const digest = await sha256FilePath(sourcePath);
  const session = await requestBackstageUploadSession(
    {
      ...config,
      byteSize: digest.byteSize,
      contentType,
      deliveryName,
      sha256: digest.sha256,
    },
    fetchImpl
  );
  if (session.uploadTarget.protocol !== 'tus') {
    throw new Error(`Unsupported Backstage upload protocol "${session.uploadTarget.protocol}".`);
  }
  const uploadResponse = await fetchImpl(session.uploadTarget.url, {
    method: session.uploadTarget.method,
    headers: {
      'Content-Type': 'application/offset+octet-stream',
      'Tus-Resumable': '1.0.0',
      'Upload-Offset': '0',
    },
    body: Bun.file(sourcePath),
  });
  if (!uploadResponse.ok) {
    throw new Error(
      `Failed to upload Backstage package artifact to CDNgine (${uploadResponse.status} ${uploadResponse.statusText})`
    );
  }

  const completionResponse = await fetchImpl(session.completeUrl, {
    method: 'POST',
  });
  const payload = await assertApiResponse<UploadStorageResponse>(
    completionResponse,
    'Failed to complete Backstage package artifact upload'
  );
  if (!payload?.cdngineSource) {
    throw new Error('Backstage artifact upload did not return CDNgine source coordinates');
  }
  return {
    cdngineSource: payload.cdngineSource,
    deliveryName: payload.deliveryName,
    sourceContentType: payload.sourceContentType,
  };
}

export async function publishBackstageRelease(
  config: PublishBackstagePackageConfig,
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
        cdngineSource: uploadedSource.cdngineSource,
        version: config.version,
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
