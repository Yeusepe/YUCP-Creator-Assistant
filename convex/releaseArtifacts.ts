import { normalizeBackstageRawPayload } from '@yucp/shared/backstageRawPayload';
import { materializeBackstageReleaseArtifact } from '@yucp/shared/backstageReleaseMaterialization';
import type { CdngineBackstageDeliveryReference } from '@yucp/shared/cdngineBackstageDelivery';
import { sha256Hex } from '@yucp/shared/crypto';
import { v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { internalAction, internalMutation, internalQuery } from './_generated/server';

const signedReleaseArtifactValidator = v.object({
  artifactKey: v.string(),
  channel: v.string(),
  platform: v.string(),
  version: v.string(),
  metadataVersion: v.number(),
  storageId: v.id('_storage'),
  contentType: v.string(),
  deliveryName: v.string(),
  envelopeCipher: v.string(),
  envelopeIvBase64: v.string(),
  ciphertextSha256: v.string(),
  ciphertextSize: v.number(),
  plaintextSha256: v.string(),
  plaintextSize: v.number(),
  codeSigningSubject: v.optional(v.string()),
  codeSigningThumbprint: v.optional(v.string()),
  status: v.union(v.literal('active'), v.literal('inactive'), v.literal('revoked')),
  activatedAt: v.optional(v.number()),
  createdAt: v.number(),
  updatedAt: v.number(),
});

const deliveryArtifactModeValidator = v.union(
  v.literal('legacy_signed'),
  v.literal('server_materialized')
);
const deliveryMaterializationStrategyValidator = v.union(
  v.literal('passthrough'),
  v.literal('normalized_repack')
);
const cdngineDeliveryReferenceValidator = v.object({
  assetId: v.string(),
  assetOwner: v.string(),
  byteSize: v.number(),
  deliveryScopeId: v.string(),
  serviceNamespaceId: v.string(),
  sha256: v.string(),
  tenantId: v.optional(v.string()),
  uploadedAt: v.number(),
  variant: v.string(),
  versionId: v.string(),
});

const deliveryReleaseArtifactValidator = v.object({
  deliveryPackageReleaseId: v.id('delivery_package_releases'),
  artifactRole: v.union(v.literal('raw_upload'), v.literal('server_deliverable')),
  ownership: v.union(v.literal('creator_upload'), v.literal('server_materialized')),
  materializationStrategy: v.optional(deliveryMaterializationStrategyValidator),
  sourceArtifactId: v.optional(v.id('delivery_release_artifacts')),
  storageId: v.optional(v.id('_storage')),
  contentType: v.string(),
  deliveryName: v.string(),
  sha256: v.string(),
  byteSize: v.number(),
  cdngineDelivery: v.optional(cdngineDeliveryReferenceValidator),
  status: v.union(v.literal('active'), v.literal('inactive')),
  activatedAt: v.optional(v.number()),
  createdAt: v.number(),
  updatedAt: v.number(),
});

function toSignedReleaseArtifact(row: Doc<'signed_release_artifacts'> | null) {
  if (!row) {
    return null;
  }

  const { _id: _artifactId, _creationTime: _docCreationTime, ...artifact } = row;
  return artifact;
}

function toDeliveryReleaseArtifact(row: Doc<'delivery_release_artifacts'> | null) {
  if (!row) {
    return null;
  }

  const { _id: _artifactId, _creationTime: _docCreationTime, ...artifact } = row;
  return artifact;
}

type MaterializedReleaseDeliverableResult = {
  deliveryArtifactMode: 'server_materialized';
  rawArtifactId: Id<'delivery_release_artifacts'>;
  deliverableArtifactId: Id<'delivery_release_artifacts'>;
  deliverableSha256: string;
  materializationStrategy: 'normalized_repack';
};

type RepairMaterializedReleaseDeliverableResult =
  | {
      status: 'missing_raw_upload';
      deliveryPackageReleaseId: Id<'delivery_package_releases'>;
    }
  | {
      status: 'current';
      deliveryPackageReleaseId: Id<'delivery_package_releases'>;
      previousSha256?: string;
      nextSha256: string;
    }
  | {
      status: 'repaired';
      deliveryPackageReleaseId: Id<'delivery_package_releases'>;
      previousSha256?: string;
      nextSha256: string;
      deliverableArtifactId: Id<'delivery_release_artifacts'>;
    };

type CdngineBackstagePublishConfig = {
  accessToken: string;
  apiBaseUrl: string;
  deliveryScopeId: string;
  required: boolean;
  serviceNamespaceId: string;
  timeoutMs: number;
  variant: string;
};

function trimOptionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : undefined;
}

function getCdngineBackstagePublishConfig(): CdngineBackstagePublishConfig | null {
  const apiBaseUrl =
    trimOptionalEnv('CDNGINE_API_BASE_URL') ?? trimOptionalEnv('CDNGINE_PUBLIC_API_BASE_URL');
  const accessToken =
    trimOptionalEnv('CDNGINE_ACCESS_TOKEN') ?? trimOptionalEnv('CDNGINE_API_TOKEN');
  if (!apiBaseUrl || !accessToken) {
    return null;
  }

  const configuredTimeout = Number.parseInt(
    trimOptionalEnv('CDNGINE_BACKSTAGE_TIMEOUT_MS') ?? '15000',
    10
  );
  return {
    accessToken,
    apiBaseUrl: apiBaseUrl.replace(/\/+$/, ''),
    deliveryScopeId: trimOptionalEnv('CDNGINE_BACKSTAGE_DELIVERY_SCOPE_ID') ?? 'paid-downloads',
    required: trimOptionalEnv('CDNGINE_BACKSTAGE_REQUIRED') === 'true',
    serviceNamespaceId:
      trimOptionalEnv('CDNGINE_BACKSTAGE_SERVICE_NAMESPACE_ID') ?? 'yucp-backstage',
    timeoutMs:
      Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 15000,
    variant: trimOptionalEnv('CDNGINE_BACKSTAGE_VARIANT') ?? 'vpm-package',
  };
}

function sanitizeObjectKeySegment(value: string): string {
  return value
    .trim()
    .replace(/[\\/]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9._:-]+/g, '-')
    .slice(0, 160);
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function requestCdngineJson<T>(
  config: CdngineBackstagePublishConfig,
  input: {
    body: unknown;
    idempotencyKey: string;
    pathname: string;
  }
): Promise<T> {
  const response = await fetchWithTimeout(
    `${config.apiBaseUrl}${input.pathname}`,
    {
      body: JSON.stringify(input.body),
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${config.accessToken}`,
        'content-type': 'application/json',
        'idempotency-key': input.idempotencyKey,
      },
      method: 'POST',
    },
    config.timeoutMs
  );
  const text = await response.text();
  const payload = text.length > 0 ? JSON.parse(text) : null;
  if (!response.ok) {
    const detail =
      payload && typeof payload === 'object' && 'detail' in payload
        ? String((payload as { detail?: unknown }).detail)
        : `${response.status} ${response.statusText}`;
    throw new Error(`CDNgine request failed: ${detail}`);
  }
  return payload as T;
}

function getStringField(value: unknown, fieldName: string): string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`CDNgine response missing ${fieldName}.`);
  }
  const fieldValue = (value as Record<string, unknown>)[fieldName];
  if (typeof fieldValue !== 'string' || fieldValue.length === 0) {
    throw new Error(`CDNgine response missing ${fieldName}.`);
  }
  return fieldValue;
}

async function publishBackstageDeliverableToCdngine(input: {
  bytes: ArrayBuffer;
  byteSize: number;
  contentType: string;
  deliveryName: string;
  release: Pick<Doc<'delivery_package_releases'>, '_id' | 'authUserId' | 'packageId' | 'channel'>;
  sha256: string;
}): Promise<CdngineBackstageDeliveryReference> {
  const config = getCdngineBackstagePublishConfig();
  if (!config) {
    throw new Error(
      'CDNgine Backstage delivery is required; configure CDNGINE_API_BASE_URL and CDNGINE_ACCESS_TOKEN.'
    );
  }

  const tenantId = input.release.authUserId;
  const assetOwner = `creator:${input.release.authUserId}`;
  const assetSeed = [
    input.release.authUserId,
    input.release.packageId,
    input.release.channel,
    String(input.release._id),
  ].join(':');
  const assetId = `backstage-${(await sha256Hex(assetSeed)).slice(0, 32)}`;
  const objectKey = [
    'staging',
    sanitizeObjectKeySegment(config.serviceNamespaceId),
    sanitizeObjectKeySegment(tenantId),
    'backstage',
    sanitizeObjectKeySegment(String(input.release._id)),
    input.sha256,
    sanitizeObjectKeySegment(input.deliveryName),
  ].join('/');
  const idempotencyBase = `backstage-deliverable:${String(input.release._id)}:${input.sha256}`;

  try {
    const session = await requestCdngineJson<unknown>(config, {
      body: {
        assetId,
        assetOwner,
        serviceNamespaceId: config.serviceNamespaceId,
        tenantId,
        source: {
          contentType: input.contentType,
          filename: input.deliveryName,
        },
        upload: {
          byteLength: input.byteSize,
          checksum: {
            algorithm: 'sha256',
            value: input.sha256,
          },
          objectKey,
        },
      },
      idempotencyKey: `${idempotencyBase}:create`,
      pathname: '/v1/upload-sessions',
    });
    const uploadSessionId = getStringField(session, 'uploadSessionId');
    const uploadTarget = (session as { uploadTarget?: unknown }).uploadTarget;
    const uploadTargetUrl = getStringField(uploadTarget, 'url');
    const uploadTargetMethod = getStringField(uploadTarget, 'method');

    const uploadResponse = await fetchWithTimeout(
      uploadTargetUrl,
      {
        body: input.bytes,
        headers: {
          'content-type': 'application/offset+octet-stream',
          'tus-resumable': '1.0.0',
          'upload-offset': '0',
        },
        method: uploadTargetMethod,
      },
      config.timeoutMs
    );
    if (!uploadResponse.ok) {
      throw new Error(
        `CDNgine upload target rejected the deliverable with ${uploadResponse.status} ${uploadResponse.statusText}.`
      );
    }

    const completion = await requestCdngineJson<unknown>(config, {
      body: {
        stagedObject: {
          byteLength: input.byteSize,
          checksum: {
            algorithm: 'sha256',
            value: input.sha256,
          },
          objectKey,
        },
      },
      idempotencyKey: `${idempotencyBase}:complete`,
      pathname: `/v1/upload-sessions/${encodeURIComponent(uploadSessionId)}/complete`,
    });

    return {
      assetId: getStringField(completion, 'assetId'),
      assetOwner,
      byteSize: input.byteSize,
      deliveryScopeId: config.deliveryScopeId,
      serviceNamespaceId: config.serviceNamespaceId,
      sha256: input.sha256,
      tenantId,
      uploadedAt: Date.now(),
      variant: config.variant,
      versionId: getStringField(completion, 'versionId'),
    };
  } catch (error) {
    throw new Error(
      `CDNgine Backstage publish failed for ${String(input.release._id)}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

export const getActiveArtifact = internalQuery({
  args: {
    artifactKey: v.string(),
    channel: v.string(),
    platform: v.string(),
  },
  returns: v.union(signedReleaseArtifactValidator, v.null()),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('signed_release_artifacts')
      .withIndex('by_artifact_key_status', (q) =>
        q.eq('artifactKey', args.artifactKey).eq('status', 'active')
      )
      .collect();

    const active = rows
      .filter((row) => row.channel === args.channel && row.platform === args.platform)
      .sort(
        (left, right) =>
          (right.activatedAt ?? right.createdAt) - (left.activatedAt ?? left.createdAt)
      )[0];

    return toSignedReleaseArtifact(active);
  },
});

export const getArtifactById = internalQuery({
  args: {
    artifactId: v.id('signed_release_artifacts'),
  },
  returns: v.union(signedReleaseArtifactValidator, v.null()),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.artifactId);
    return toSignedReleaseArtifact(row);
  },
});

export const getArtifactDownloadById = internalQuery({
  args: {
    artifactId: v.id('signed_release_artifacts'),
  },
  returns: v.union(
    v.null(),
    v.object({
      storageId: v.optional(v.id('_storage')),
      downloadUrl: v.string(),
      contentType: v.string(),
      deliveryName: v.string(),
      plaintextSha256: v.string(),
    })
  ),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.artifactId);
    if (!row) {
      return null;
    }
    const downloadUrl = await ctx.storage.getUrl(row.storageId);
    if (!downloadUrl) {
      return null;
    }
    return {
      storageId: row.storageId,
      downloadUrl,
      contentType: row.contentType,
      deliveryName: row.deliveryName,
      plaintextSha256: row.plaintextSha256,
    };
  },
});

export const getLatestActiveArtifactByKey = internalQuery({
  args: {
    artifactKey: v.string(),
  },
  returns: v.union(signedReleaseArtifactValidator, v.null()),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('signed_release_artifacts')
      .withIndex('by_artifact_key_status', (q) =>
        q.eq('artifactKey', args.artifactKey).eq('status', 'active')
      )
      .collect();
    const latest = rows.sort(
      (left, right) => (right.activatedAt ?? right.createdAt) - (left.activatedAt ?? left.createdAt)
    )[0];
    return toSignedReleaseArtifact(latest ?? null);
  },
});

export const getLatestActiveArtifactDownloadByKey = internalQuery({
  args: {
    artifactKey: v.string(),
  },
  returns: v.union(
    v.null(),
    v.object({
      storageId: v.optional(v.id('_storage')),
      downloadUrl: v.string(),
      contentType: v.string(),
      deliveryName: v.string(),
      plaintextSha256: v.string(),
    })
  ),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('signed_release_artifacts')
      .withIndex('by_artifact_key_status', (q) =>
        q.eq('artifactKey', args.artifactKey).eq('status', 'active')
      )
      .collect();
    const latest = rows.sort(
      (left, right) => (right.activatedAt ?? right.createdAt) - (left.activatedAt ?? left.createdAt)
    )[0];
    if (!latest) {
      return null;
    }
    const downloadUrl = await ctx.storage.getUrl(latest.storageId);
    if (!downloadUrl) {
      return null;
    }
    return {
      storageId: latest.storageId,
      downloadUrl,
      contentType: latest.contentType,
      deliveryName: latest.deliveryName,
      plaintextSha256: latest.plaintextSha256,
    };
  },
});

export const publishArtifact = internalMutation({
  args: {
    artifactKey: v.string(),
    channel: v.string(),
    platform: v.string(),
    version: v.string(),
    metadataVersion: v.number(),
    storageId: v.id('_storage'),
    contentType: v.string(),
    deliveryName: v.string(),
    envelopeCipher: v.string(),
    envelopeIvBase64: v.string(),
    ciphertextSha256: v.string(),
    ciphertextSize: v.number(),
    plaintextSha256: v.string(),
    plaintextSize: v.number(),
    codeSigningSubject: v.optional(v.string()),
    codeSigningThumbprint: v.optional(v.string()),
  },
  returns: v.id('signed_release_artifacts'),
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await ctx.db
      .query('signed_release_artifacts')
      .withIndex('by_artifact_key', (q) => q.eq('artifactKey', args.artifactKey))
      .collect();

    for (const row of existing) {
      if (
        row.channel === args.channel &&
        row.platform === args.platform &&
        row.status === 'active'
      ) {
        await ctx.db.patch(row._id, {
          status: 'inactive',
          updatedAt: now,
        });
      }
    }

    return await ctx.db.insert('signed_release_artifacts', {
      ...args,
      status: 'active',
      activatedAt: now,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const recordArtifactPublishedAudit = internalMutation({
  args: {
    artifactKey: v.string(),
    channel: v.string(),
    platform: v.string(),
    version: v.string(),
    plaintextSha256: v.string(),
    ciphertextSha256: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert('audit_events', {
      eventType: 'release.artifact.published',
      actorType: 'system',
      metadata: {
        artifactKey: args.artifactKey,
        channel: args.channel,
        platform: args.platform,
        version: args.version,
        plaintextSha256: args.plaintextSha256,
        ciphertextSha256: args.ciphertextSha256,
      },
      correlationId: `${args.artifactKey}:${args.channel}:${args.platform}:${args.version}`,
      createdAt: Date.now(),
    });
  },
});

export const getDeliveryArtifactById = internalQuery({
  args: {
    artifactId: v.id('delivery_release_artifacts'),
  },
  returns: v.union(deliveryReleaseArtifactValidator, v.null()),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.artifactId);
    return toDeliveryReleaseArtifact(row);
  },
});

export const getActiveDeliveryArtifactForRelease = internalQuery({
  args: {
    deliveryPackageReleaseId: v.id('delivery_package_releases'),
    artifactRole: v.union(v.literal('raw_upload'), v.literal('server_deliverable')),
  },
  returns: v.union(deliveryReleaseArtifactValidator, v.null()),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query('delivery_release_artifacts')
      .withIndex('by_release_role_status', (q) =>
        q
          .eq('deliveryPackageReleaseId', args.deliveryPackageReleaseId)
          .eq('artifactRole', args.artifactRole)
          .eq('status', 'active')
      )
      .first();
    return toDeliveryReleaseArtifact(row);
  },
});

export const getActiveDeliveryArtifactRecordForRelease = internalQuery({
  args: {
    deliveryPackageReleaseId: v.id('delivery_package_releases'),
    artifactRole: v.union(v.literal('raw_upload'), v.literal('server_deliverable')),
  },
  returns: v.union(
    v.null(),
    v.object({
      _id: v.id('delivery_release_artifacts'),
      deliveryPackageReleaseId: v.id('delivery_package_releases'),
      artifactRole: v.union(v.literal('raw_upload'), v.literal('server_deliverable')),
      ownership: v.union(v.literal('creator_upload'), v.literal('server_materialized')),
      materializationStrategy: v.optional(deliveryMaterializationStrategyValidator),
      sourceArtifactId: v.optional(v.id('delivery_release_artifacts')),
      storageId: v.optional(v.id('_storage')),
      contentType: v.string(),
      deliveryName: v.string(),
      sha256: v.string(),
      byteSize: v.number(),
      cdngineDelivery: v.optional(cdngineDeliveryReferenceValidator),
      status: v.union(v.literal('active'), v.literal('inactive')),
      activatedAt: v.optional(v.number()),
      createdAt: v.number(),
      updatedAt: v.number(),
    })
  ),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query('delivery_release_artifacts')
      .withIndex('by_release_role_status', (q) =>
        q
          .eq('deliveryPackageReleaseId', args.deliveryPackageReleaseId)
          .eq('artifactRole', args.artifactRole)
          .eq('status', 'active')
      )
      .first();
    return row
      ? {
          _id: row._id,
          deliveryPackageReleaseId: row.deliveryPackageReleaseId,
          artifactRole: row.artifactRole,
          ownership: row.ownership,
          materializationStrategy: row.materializationStrategy,
          sourceArtifactId: row.sourceArtifactId,
          storageId: row.storageId,
          contentType: row.contentType,
          deliveryName: row.deliveryName,
          sha256: row.sha256,
          byteSize: row.byteSize,
          cdngineDelivery: row.cdngineDelivery,
          status: row.status,
          activatedAt: row.activatedAt,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        }
      : null;
  },
});

export const getDeliveryArtifactDownloadById = internalQuery({
  args: {
    artifactId: v.id('delivery_release_artifacts'),
  },
  returns: v.union(
    v.null(),
    v.object({
      storageId: v.id('_storage'),
      downloadUrl: v.string(),
      contentType: v.string(),
      deliveryName: v.string(),
      sha256: v.string(),
    })
  ),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.artifactId);
    if (!row?.storageId) {
      return null;
    }
    const downloadUrl = await ctx.storage.getUrl(row.storageId);
    if (!downloadUrl) {
      return null;
    }
    return {
      storageId: row.storageId,
      downloadUrl,
      contentType: row.contentType,
      deliveryName: row.deliveryName,
      sha256: row.sha256,
    };
  },
});

export const publishDeliveryArtifact = internalMutation({
  args: {
    deliveryPackageReleaseId: v.id('delivery_package_releases'),
    artifactRole: v.union(v.literal('raw_upload'), v.literal('server_deliverable')),
    ownership: v.union(v.literal('creator_upload'), v.literal('server_materialized')),
    materializationStrategy: v.optional(deliveryMaterializationStrategyValidator),
    sourceArtifactId: v.optional(v.id('delivery_release_artifacts')),
    storageId: v.optional(v.id('_storage')),
    contentType: v.string(),
    deliveryName: v.string(),
    sha256: v.string(),
    byteSize: v.number(),
    cdngineDelivery: v.optional(cdngineDeliveryReferenceValidator),
  },
  returns: v.id('delivery_release_artifacts'),
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await ctx.db
      .query('delivery_release_artifacts')
      .withIndex('by_release_role_status', (q) =>
        q
          .eq('deliveryPackageReleaseId', args.deliveryPackageReleaseId)
          .eq('artifactRole', args.artifactRole)
          .eq('status', 'active')
      )
      .collect();

    for (const row of existing) {
      await ctx.db.patch(row._id, {
        status: 'inactive',
        updatedAt: now,
      });
    }

    return await ctx.db.insert('delivery_release_artifacts', {
      ...args,
      status: 'active',
      activatedAt: now,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const generateDeliveryArtifactUploadUrl = internalMutation({
  args: {},
  returns: v.string(),
  handler: async (ctx) => {
    return await ctx.storage.generateUploadUrl();
  },
});

export const materializeUploadedReleaseDeliverable = internalAction({
  args: {
    deliveryPackageReleaseId: v.id('delivery_package_releases'),
    storageId: v.id('_storage'),
    contentType: v.string(),
    deliveryName: v.string(),
    sha256: v.string(),
    metadata: v.optional(v.any()),
  },
  returns: v.object({
    deliveryArtifactMode: deliveryArtifactModeValidator,
    rawArtifactId: v.id('delivery_release_artifacts'),
    deliverableArtifactId: v.id('delivery_release_artifacts'),
    deliverableSha256: v.string(),
    materializationStrategy: v.union(v.literal('normalized_repack')),
  }),
  handler: async (ctx, args): Promise<MaterializedReleaseDeliverableResult> => {
    const uploaded = await ctx.storage.get(args.storageId);
    if (!uploaded) {
      throw new Error(`Uploaded release storage not found: ${args.storageId}`);
    }
    const release = await ctx.runQuery(internal.packageRegistry.getDeliveryPackageReleaseById, {
      deliveryPackageReleaseId: args.deliveryPackageReleaseId,
    });
    if (!release) {
      throw new Error(`Delivery package release not found: ${args.deliveryPackageReleaseId}`);
    }
    const deliveryPackage = await ctx.runQuery(internal.packageRegistry.getDeliveryPackageById, {
      deliveryPackageId: release.deliveryPackageId,
    });
    if (!deliveryPackage) {
      throw new Error(`Delivery package not found: ${release.deliveryPackageId}`);
    }

    const byteSize = uploaded.size;
    const rawArtifactId: Id<'delivery_release_artifacts'> = await ctx.runMutation(
      internal.releaseArtifacts.publishDeliveryArtifact,
      {
        deliveryPackageReleaseId: args.deliveryPackageReleaseId,
        artifactRole: 'raw_upload',
        ownership: 'creator_upload',
        storageId: args.storageId,
        contentType: args.contentType,
        deliveryName: args.deliveryName,
        sha256: args.sha256,
        byteSize,
      }
    );

    const materialized = await materializeBackstageReleaseArtifact({
      sourceBytes: new Uint8Array(await uploaded.arrayBuffer()),
      deliveryName: args.deliveryName,
      contentType: args.contentType,
      packageId: release.packageId,
      version: release.version,
      displayName: deliveryPackage.displayName ?? deliveryPackage.packageName,
      metadata: args.metadata as Record<string, unknown> | undefined,
    });
    const deliverableBytes = materialized.bytes.buffer.slice(
      materialized.bytes.byteOffset,
      materialized.bytes.byteOffset + materialized.bytes.byteLength
    ) as ArrayBuffer;
    const cdngineDelivery = await publishBackstageDeliverableToCdngine({
      bytes: deliverableBytes,
      byteSize: materialized.byteSize,
      contentType: materialized.contentType,
      deliveryName: materialized.deliveryName,
      release,
      sha256: materialized.sha256,
    });
    const deliverableArtifactId: Id<'delivery_release_artifacts'> = await ctx.runMutation(
      internal.releaseArtifacts.publishDeliveryArtifact,
      {
        deliveryPackageReleaseId: args.deliveryPackageReleaseId,
        artifactRole: 'server_deliverable',
        ownership: 'server_materialized',
        materializationStrategy: materialized.materializationStrategy,
        sourceArtifactId: rawArtifactId,
        contentType: materialized.contentType,
        deliveryName: materialized.deliveryName,
        sha256: materialized.sha256,
        byteSize: materialized.byteSize,
        cdngineDelivery,
      }
    );
    await ctx.storage.delete(args.storageId);
    await ctx.runMutation(internal.packageRegistry.updateMaterializedReleaseDigest, {
      deliveryPackageReleaseId: args.deliveryPackageReleaseId,
      zipSha256: materialized.sha256,
    });

    return {
      deliveryArtifactMode: 'server_materialized',
      rawArtifactId,
      deliverableArtifactId,
      deliverableSha256: materialized.sha256,
      materializationStrategy: materialized.materializationStrategy,
    };
  },
});

export const repairMaterializedReleaseDeliverable = internalAction({
  args: {
    deliveryPackageReleaseId: v.id('delivery_package_releases'),
    apply: v.optional(v.boolean()),
  },
  returns: v.union(
    v.object({
      status: v.literal('missing_raw_upload'),
      deliveryPackageReleaseId: v.id('delivery_package_releases'),
    }),
    v.object({
      status: v.literal('current'),
      deliveryPackageReleaseId: v.id('delivery_package_releases'),
      previousSha256: v.optional(v.string()),
      nextSha256: v.string(),
    }),
    v.object({
      status: v.literal('repaired'),
      deliveryPackageReleaseId: v.id('delivery_package_releases'),
      previousSha256: v.optional(v.string()),
      nextSha256: v.string(),
      deliverableArtifactId: v.id('delivery_release_artifacts'),
    })
  ),
  handler: async (ctx, args): Promise<RepairMaterializedReleaseDeliverableResult> => {
    let rawArtifact = await ctx.runQuery(
      internal.releaseArtifacts.getActiveDeliveryArtifactRecordForRelease,
      {
        deliveryPackageReleaseId: args.deliveryPackageReleaseId,
        artifactRole: 'raw_upload',
      }
    );
    const currentDeliverable = await ctx.runQuery(
      internal.releaseArtifacts.getActiveDeliveryArtifactForRelease,
      {
        deliveryPackageReleaseId: args.deliveryPackageReleaseId,
        artifactRole: 'server_deliverable',
      }
    );
    const release = await ctx.runQuery(internal.packageRegistry.getDeliveryPackageReleaseById, {
      deliveryPackageReleaseId: args.deliveryPackageReleaseId,
    });
    if (!release) {
      throw new Error(`Delivery package release not found: ${args.deliveryPackageReleaseId}`);
    }
    const deliveryPackage = await ctx.runQuery(internal.packageRegistry.getDeliveryPackageById, {
      deliveryPackageId: release.deliveryPackageId,
    });
    if (!deliveryPackage) {
      throw new Error(`Delivery package not found: ${release.deliveryPackageId}`);
    }

    let rawSourceBytes: Uint8Array | null = null;
    let rawSourceContentType: string | null = null;
    let rawSourceDeliveryName: string | null = null;
    let rawSourceSha256: string | null = null;
    let rawArtifactNeedsReplace = false;
    if (!rawArtifact) {
      const signedArtifact = release.signedArtifactId
        ? await ctx.runQuery(internal.releaseArtifacts.getArtifactById, {
            artifactId: release.signedArtifactId,
          })
        : release.artifactKey
          ? await ctx.runQuery(internal.releaseArtifacts.getLatestActiveArtifactByKey, {
              artifactKey: release.artifactKey,
            })
          : null;
      const legacyWrapperStorageId = currentDeliverable?.storageId ?? signedArtifact?.storageId;
      const recoveringFromCurrentDeliverable =
        Boolean(currentDeliverable?.storageId) &&
        legacyWrapperStorageId === currentDeliverable?.storageId;
      if (!legacyWrapperStorageId) {
        return {
          status: 'missing_raw_upload',
          deliveryPackageReleaseId: args.deliveryPackageReleaseId,
        };
      }
      const legacyWrapperBlob = await ctx.storage.get(legacyWrapperStorageId);
      if (!legacyWrapperBlob) {
        throw new Error(`Deliverable release storage not found: ${legacyWrapperStorageId}`);
      }
      const recoveredRawPayload = normalizeBackstageRawPayload({
        sourceBytes: new Uint8Array(await legacyWrapperBlob.arrayBuffer()),
        contentType: currentDeliverable?.contentType ?? signedArtifact?.contentType,
        deliveryName:
          currentDeliverable?.deliveryName ??
          signedArtifact?.deliveryName ??
          `${release.packageId}-${release.version}.zip`,
        packageId: release.packageId,
        version: release.version,
      });
      if (
        recoveringFromCurrentDeliverable &&
        recoveredRawPayload.payloadSourceKind !== 'legacy-wrapper'
      ) {
        return {
          status: 'missing_raw_upload',
          deliveryPackageReleaseId: args.deliveryPackageReleaseId,
        };
      }
      rawSourceBytes = recoveredRawPayload.bytes;
      rawSourceContentType = recoveredRawPayload.contentType;
      rawSourceDeliveryName = recoveredRawPayload.deliveryName;
      rawSourceSha256 = await sha256Hex(recoveredRawPayload.bytes);
      rawArtifactNeedsReplace = true;
    } else {
      if (!rawArtifact.storageId) {
        throw new Error(
          `Raw upload storage is unavailable for ${args.deliveryPackageReleaseId}; republish the release to CDNgine.`
        );
      }
      const uploaded = await ctx.storage.get(rawArtifact.storageId);
      if (!uploaded) {
        throw new Error(`Uploaded release storage not found: ${rawArtifact.storageId}`);
      }
      const normalizedRawPayload = normalizeBackstageRawPayload({
        sourceBytes: new Uint8Array(await uploaded.arrayBuffer()),
        contentType: rawArtifact.contentType,
        deliveryName: rawArtifact.deliveryName,
        packageId: release.packageId,
        version: release.version,
      });
      rawSourceBytes = normalizedRawPayload.bytes;
      rawSourceContentType = normalizedRawPayload.contentType;
      rawSourceDeliveryName = normalizedRawPayload.deliveryName;
      rawSourceSha256 = await sha256Hex(normalizedRawPayload.bytes);
      rawArtifactNeedsReplace =
        rawArtifact.sha256 !== rawSourceSha256 ||
        rawArtifact.contentType !== rawSourceContentType ||
        rawArtifact.deliveryName !== rawSourceDeliveryName;
    }

    if (!rawSourceBytes || !rawSourceContentType || !rawSourceDeliveryName || !rawSourceSha256) {
      throw new Error(`Failed to resolve raw source payload for ${args.deliveryPackageReleaseId}`);
    }

    const materialized = await materializeBackstageReleaseArtifact({
      sourceBytes: rawSourceBytes,
      deliveryName: rawSourceDeliveryName,
      contentType: rawSourceContentType,
      packageId: release.packageId,
      version: release.version,
      displayName: deliveryPackage.displayName ?? deliveryPackage.packageName,
      metadata:
        release.metadata && typeof release.metadata === 'object' && !Array.isArray(release.metadata)
          ? (release.metadata as Record<string, unknown>)
          : undefined,
    });
    const previousSha256 = currentDeliverable?.sha256 ?? release.zipSha256;
    const deliverableChanged =
      currentDeliverable?.sha256 !== materialized.sha256 ||
      currentDeliverable?.contentType !== materialized.contentType ||
      currentDeliverable?.deliveryName !== materialized.deliveryName ||
      release.zipSha256 !== materialized.sha256;
    const deliverableNeedsRepublish =
      deliverableChanged ||
      rawArtifactNeedsReplace ||
      (rawArtifact != null && currentDeliverable?.sourceArtifactId !== rawArtifact._id);

    if (!deliverableNeedsRepublish || !args.apply) {
      return {
        status: 'current',
        deliveryPackageReleaseId: args.deliveryPackageReleaseId,
        previousSha256,
        nextSha256: materialized.sha256,
      };
    }

    if (rawArtifactNeedsReplace) {
      const recoveredStorageId: Id<'_storage'> = await ctx.storage.store(
        new Blob(
          [
            rawSourceBytes.buffer.slice(
              rawSourceBytes.byteOffset,
              rawSourceBytes.byteOffset + rawSourceBytes.byteLength
            ) as ArrayBuffer,
          ],
          {
            type: rawSourceContentType,
          }
        )
      );
      const recoveredRawArtifactId: Id<'delivery_release_artifacts'> = await ctx.runMutation(
        internal.releaseArtifacts.publishDeliveryArtifact,
        {
          deliveryPackageReleaseId: args.deliveryPackageReleaseId,
          artifactRole: 'raw_upload',
          ownership: 'creator_upload',
          storageId: recoveredStorageId,
          contentType: rawSourceContentType,
          deliveryName: rawSourceDeliveryName,
          sha256: rawSourceSha256,
          byteSize: rawSourceBytes.byteLength,
        }
      );
      rawArtifact = await ctx.runQuery(
        internal.releaseArtifacts.getActiveDeliveryArtifactRecordForRelease,
        {
          deliveryPackageReleaseId: args.deliveryPackageReleaseId,
          artifactRole: 'raw_upload',
        }
      );
      if (!rawArtifact || String(rawArtifact._id) !== String(recoveredRawArtifactId)) {
        throw new Error(
          `Recovered raw upload could not be activated: ${args.deliveryPackageReleaseId}`
        );
      }
    }

    const deliverableBytes = materialized.bytes.buffer.slice(
      materialized.bytes.byteOffset,
      materialized.bytes.byteOffset + materialized.bytes.byteLength
    ) as ArrayBuffer;
    const cdngineDelivery = await publishBackstageDeliverableToCdngine({
      bytes: deliverableBytes,
      byteSize: materialized.byteSize,
      contentType: materialized.contentType,
      deliveryName: materialized.deliveryName,
      release,
      sha256: materialized.sha256,
    });
    const deliverableArtifactId: Id<'delivery_release_artifacts'> = await ctx.runMutation(
      internal.releaseArtifacts.publishDeliveryArtifact,
      {
        deliveryPackageReleaseId: args.deliveryPackageReleaseId,
        artifactRole: 'server_deliverable',
        ownership: 'server_materialized',
        materializationStrategy: materialized.materializationStrategy,
        sourceArtifactId: rawArtifact?._id,
        contentType: materialized.contentType,
        deliveryName: materialized.deliveryName,
        sha256: materialized.sha256,
        byteSize: materialized.byteSize,
        cdngineDelivery,
      }
    );
    await ctx.runMutation(internal.packageRegistry.updateMaterializedReleaseDigest, {
      deliveryPackageReleaseId: args.deliveryPackageReleaseId,
      zipSha256: materialized.sha256,
      sourceKind: materialized.originalSourceKind,
    });

    return {
      status: 'repaired',
      deliveryPackageReleaseId: args.deliveryPackageReleaseId,
      previousSha256,
      nextSha256: materialized.sha256,
      deliverableArtifactId,
    };
  },
});
