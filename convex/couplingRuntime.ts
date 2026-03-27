'use node';

import { existsSync, readFileSync } from 'node:fs';
import { v } from 'convex/values';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { type ActionCtx, internalAction } from './_generated/server';
import { deriveCouplingRuntimeEnvelopeKeyBytes } from './lib/couplingRuntimeEnvelope';
import { DEFAULT_COUPLING_RUNTIME_DELIVERY_NAME } from './lib/couplingRuntimeConfig';
import { DEFAULT_COUPLING_RUNTIME_PACKAGE_DELIVERY_NAME } from './lib/couplingRuntimePackageConfig';
import { encryptArtifactEnvelope, sha256HexBytes } from './lib/releaseArtifactEnvelope';
import {
  RELEASE_ARTIFACT_KEYS,
  RELEASE_CHANNELS,
  RELEASE_PLATFORMS,
} from './lib/releaseArtifactKeys';

const COUPLING_RUNTIME_METADATA_VERSION = 1;
const COUPLING_RUNTIME_CONTENT_TYPE = 'application/octet-stream';
const COUPLING_RUNTIME_PACKAGE_CONTENT_TYPE = 'application/zip';
const COUPLING_RUNTIME_ENVELOPE_CIPHER = 'aes-256-gcm';

const runtimePublishResultValidator = v.object({
  success: v.boolean(),
  artifactId: v.optional(v.id('signed_release_artifacts')),
  plaintextSha256: v.optional(v.string()),
  ciphertextSha256: v.optional(v.string()),
  sourcePath: v.optional(v.string()),
  error: v.optional(v.string()),
});

type RuntimePublishArgs = {
  version: string;
  channel?: string;
  platform?: string;
  deliveryName?: string;
  codeSigningSubject?: string;
  codeSigningThumbprint?: string;
};

type RuntimePublishResult = {
  success: boolean;
  artifactId?: Id<'signed_release_artifacts'>;
  plaintextSha256?: string;
  ciphertextSha256?: string;
  sourcePath?: string;
  error?: string;
};

type ReleaseArtifactDetails = {
  artifactKey: string;
  defaultDeliveryName: string;
  contentType: string;
};

const COUPLING_RUNTIME_ARTIFACT: ReleaseArtifactDetails = {
  artifactKey: RELEASE_ARTIFACT_KEYS.couplingRuntime,
  defaultDeliveryName: DEFAULT_COUPLING_RUNTIME_DELIVERY_NAME,
  contentType: COUPLING_RUNTIME_CONTENT_TYPE,
};

const COUPLING_RUNTIME_PACKAGE_ARTIFACT: ReleaseArtifactDetails = {
  artifactKey: RELEASE_ARTIFACT_KEYS.couplingRuntimePackage,
  defaultDeliveryName: DEFAULT_COUPLING_RUNTIME_PACKAGE_DELIVERY_NAME,
  contentType: COUPLING_RUNTIME_PACKAGE_CONTENT_TYPE,
};

const runtimeManifestDataValidator = v.object({
  success: v.boolean(),
  artifactKey: v.optional(v.string()),
  channel: v.optional(v.string()),
  platform: v.optional(v.string()),
  version: v.optional(v.string()),
  metadataVersion: v.optional(v.number()),
  deliveryName: v.optional(v.string()),
  contentType: v.optional(v.string()),
  envelopeCipher: v.optional(v.string()),
  envelopeIvBase64: v.optional(v.string()),
  ciphertextSha256: v.optional(v.string()),
  ciphertextSize: v.optional(v.number()),
  plaintextSha256: v.optional(v.string()),
  plaintextSize: v.optional(v.number()),
  codeSigningSubject: v.optional(v.string()),
  codeSigningThumbprint: v.optional(v.string()),
  error: v.optional(v.string()),
});

async function publishReleaseArtifact(
  ctx: ActionCtx,
  args: RuntimePublishArgs,
  plaintext: Uint8Array,
  sourcePath: string,
  details: ReleaseArtifactDetails
): Promise<RuntimePublishResult> {
  const channel = (args.channel || '').trim() || RELEASE_CHANNELS.stable;
  const platform = (args.platform || '').trim() || RELEASE_PLATFORMS.winX64;
  const deliveryName = (args.deliveryName || '').trim() || details.defaultDeliveryName;
  const plaintextSha256 = await sha256HexBytes(plaintext);
  const envelopeKey = await deriveCouplingRuntimeEnvelopeKeyBytes({
    artifactKey: details.artifactKey,
    channel,
    platform,
    version: args.version,
    plaintextSha256,
  });
  const encrypted = await encryptArtifactEnvelope(plaintext, envelopeKey);
  const ciphertextBuffer = Uint8Array.from(encrypted.ciphertext).buffer;
  const storageId = await ctx.storage.store(
    new Blob([ciphertextBuffer], { type: details.contentType })
  );

  const artifactId = await ctx.runMutation(internal.releaseArtifacts.publishArtifact, {
    artifactKey: details.artifactKey,
    channel,
    platform,
    version: args.version,
    metadataVersion: COUPLING_RUNTIME_METADATA_VERSION,
    storageId,
    contentType: details.contentType,
    deliveryName,
    envelopeCipher: COUPLING_RUNTIME_ENVELOPE_CIPHER,
    envelopeIvBase64: encrypted.ivBase64,
    ciphertextSha256: encrypted.ciphertextSha256,
    ciphertextSize: encrypted.ciphertext.byteLength,
    plaintextSha256: encrypted.plaintextSha256,
    plaintextSize: plaintext.byteLength,
    codeSigningSubject: args.codeSigningSubject,
    codeSigningThumbprint: args.codeSigningThumbprint,
  });

  await ctx.runMutation(internal.releaseArtifacts.recordArtifactPublishedAudit, {
    artifactKey: details.artifactKey,
    channel,
    platform,
    version: args.version,
    plaintextSha256: encrypted.plaintextSha256,
    ciphertextSha256: encrypted.ciphertextSha256,
  });

  return {
    success: true,
    artifactId,
    plaintextSha256: encrypted.plaintextSha256,
    ciphertextSha256: encrypted.ciphertextSha256,
    sourcePath,
  };
}

function readPlaintextFromArgs(
  args: { plaintextBase64?: string; sourcePath?: string },
  invalidBase64Error: string,
  sourceNotFoundLabel: string,
  missingPayloadError: string
): RuntimePublishResult & { plaintext?: Uint8Array; sourcePath: string } {
  const sourcePath = (args.sourcePath || '').trim();
  const plaintextBase64 = (args.plaintextBase64 || '').trim();

  if (plaintextBase64) {
    try {
      return {
        success: true,
        plaintext: Uint8Array.from(Buffer.from(plaintextBase64, 'base64')),
        sourcePath: '[inline payload]',
      };
    } catch {
      return {
        success: false,
        error: invalidBase64Error,
        sourcePath,
      };
    }
  }

  if (sourcePath) {
    if (!existsSync(sourcePath)) {
      return {
        success: false,
        error: `${sourceNotFoundLabel} not found: ${sourcePath}`,
        sourcePath,
      };
    }
    return {
      success: true,
      plaintext: new Uint8Array(readFileSync(sourcePath)),
      sourcePath,
    };
  }

  return {
    success: false,
    error: missingPayloadError,
    sourcePath,
  };
}

async function getActiveArtifactManifestData(
  ctx: ActionCtx,
  args: { channel?: string; platform?: string },
  details: ReleaseArtifactDetails,
  missingError: string
): Promise<{
  success: boolean;
  artifactKey?: string;
  channel?: string;
  platform?: string;
  version?: string;
  metadataVersion?: number;
  deliveryName?: string;
  contentType?: string;
  envelopeCipher?: string;
  envelopeIvBase64?: string;
  ciphertextSha256?: string;
  ciphertextSize?: number;
  plaintextSha256?: string;
  plaintextSize?: number;
  codeSigningSubject?: string;
  codeSigningThumbprint?: string;
  error?: string;
}> {
  const channel = (args.channel || '').trim() || RELEASE_CHANNELS.stable;
  const platform = (args.platform || '').trim() || RELEASE_PLATFORMS.winX64;
  const artifact = await ctx.runQuery(internal.releaseArtifacts.getActiveArtifact, {
    artifactKey: details.artifactKey,
    channel,
    platform,
  });
  if (!artifact) {
    return {
      success: false,
      error: missingError,
    };
  }

  await deriveCouplingRuntimeEnvelopeKeyBytes({
    artifactKey: artifact.artifactKey,
    channel: artifact.channel,
    platform: artifact.platform,
    version: artifact.version,
    plaintextSha256: artifact.plaintextSha256,
  });

  return {
    success: true,
    artifactKey: artifact.artifactKey,
    channel: artifact.channel,
    platform: artifact.platform,
    version: artifact.version,
    metadataVersion: artifact.metadataVersion,
    deliveryName: artifact.deliveryName,
    contentType: artifact.contentType,
    envelopeCipher: artifact.envelopeCipher,
    envelopeIvBase64: artifact.envelopeIvBase64,
    ciphertextSha256: artifact.ciphertextSha256,
    ciphertextSize: artifact.ciphertextSize,
    plaintextSha256: artifact.plaintextSha256,
    plaintextSize: artifact.plaintextSize,
    codeSigningSubject: artifact.codeSigningSubject,
    codeSigningThumbprint: artifact.codeSigningThumbprint,
  };
}

/**
 * Publish the active coupling runtime artifact to Convex storage.
 *
 * Manual publish:
 *   bun run convex:publish:coupling-runtime
 *   bun run convex:publish:coupling-runtime -- --version 2026.03.25.153000
 *
 * Override `sourcePath` when you need to publish a non-default local build output.
 */
export const publishRuntimeFromLocalSource = internalAction({
  args: {
    version: v.string(),
    channel: v.optional(v.string()),
    platform: v.optional(v.string()),
    deliveryName: v.optional(v.string()),
    plaintextBase64: v.optional(v.string()),
    sourcePath: v.optional(v.string()),
    codeSigningSubject: v.optional(v.string()),
    codeSigningThumbprint: v.optional(v.string()),
  },
  returns: runtimePublishResultValidator,
  handler: async (ctx, args): Promise<RuntimePublishResult> => {
    const payload = readPlaintextFromArgs(
      args,
      'Coupling runtime payload is not valid base64',
      'Coupling runtime source',
      'Coupling runtime payload is required. Use bun run convex:publish:coupling-runtime or provide sourcePath explicitly.'
    );
    if (!payload.success || !payload.plaintext) {
      return payload;
    }

    return await publishReleaseArtifact(
      ctx,
      args,
      payload.plaintext,
      payload.sourcePath,
      COUPLING_RUNTIME_ARTIFACT
    );
  },
});

export const publishUploadedRuntime = internalAction({
  args: {
    storageId: v.id('_storage'),
    version: v.string(),
    channel: v.optional(v.string()),
    platform: v.optional(v.string()),
    deliveryName: v.optional(v.string()),
    codeSigningSubject: v.optional(v.string()),
    codeSigningThumbprint: v.optional(v.string()),
    deleteSourceAfterPublish: v.optional(v.boolean()),
  },
  returns: runtimePublishResultValidator,
  handler: async (ctx, args): Promise<RuntimePublishResult> => {
    const uploaded = await ctx.storage.get(args.storageId);
    if (!uploaded) {
      return {
        success: false,
        error: `Uploaded coupling runtime not found: ${args.storageId}`,
      };
    }

    const plaintext = new Uint8Array(await uploaded.arrayBuffer());
    const result = await publishReleaseArtifact(
      ctx,
      args,
      plaintext,
      `storage:${args.storageId}`,
      COUPLING_RUNTIME_ARTIFACT
    );
    if (!result.success) {
      return result;
    }

    if (args.deleteSourceAfterPublish ?? true) {
      await ctx.storage.delete(args.storageId);
    }

    return result;
  },
});

export const getActiveRuntimeManifestData = internalAction({
  args: {
    channel: v.optional(v.string()),
    platform: v.optional(v.string()),
  },
  returns: runtimeManifestDataValidator,
  handler: async (ctx, args) => {
    return await getActiveArtifactManifestData(
      ctx,
      args,
      COUPLING_RUNTIME_ARTIFACT,
      'Coupling runtime is not configured on the server'
    );
  },
});

export const publishRuntimePackageFromLocalSource = internalAction({
  args: {
    version: v.string(),
    channel: v.optional(v.string()),
    platform: v.optional(v.string()),
    deliveryName: v.optional(v.string()),
    plaintextBase64: v.optional(v.string()),
    sourcePath: v.optional(v.string()),
    codeSigningSubject: v.optional(v.string()),
    codeSigningThumbprint: v.optional(v.string()),
  },
  returns: runtimePublishResultValidator,
  handler: async (ctx, args): Promise<RuntimePublishResult> => {
    const payload = readPlaintextFromArgs(
      args,
      'Coupling runtime package payload is not valid base64',
      'Coupling runtime package source',
      'Coupling runtime package payload is required. Use bun run convex:publish:coupling-runtime-package or provide sourcePath explicitly.'
    );
    if (!payload.success || !payload.plaintext) {
      return payload;
    }

    return await publishReleaseArtifact(
      ctx,
      args,
      payload.plaintext,
      payload.sourcePath,
      COUPLING_RUNTIME_PACKAGE_ARTIFACT
    );
  },
});

export const publishUploadedRuntimePackage = internalAction({
  args: {
    storageId: v.id('_storage'),
    version: v.string(),
    channel: v.optional(v.string()),
    platform: v.optional(v.string()),
    deliveryName: v.optional(v.string()),
    codeSigningSubject: v.optional(v.string()),
    codeSigningThumbprint: v.optional(v.string()),
    deleteSourceAfterPublish: v.optional(v.boolean()),
  },
  returns: runtimePublishResultValidator,
  handler: async (ctx, args): Promise<RuntimePublishResult> => {
    const uploaded = await ctx.storage.get(args.storageId);
    if (!uploaded) {
      return {
        success: false,
        error: `Uploaded coupling runtime package not found: ${args.storageId}`,
      };
    }

    const plaintext = new Uint8Array(await uploaded.arrayBuffer());
    const result = await publishReleaseArtifact(
      ctx,
      args,
      plaintext,
      `storage:${args.storageId}`,
      COUPLING_RUNTIME_PACKAGE_ARTIFACT
    );
    if (!result.success) {
      return result;
    }

    if (args.deleteSourceAfterPublish ?? true) {
      await ctx.storage.delete(args.storageId);
    }

    return result;
  },
});

export const getActiveRuntimePackageManifestData = internalAction({
  args: {
    channel: v.optional(v.string()),
    platform: v.optional(v.string()),
  },
  returns: runtimeManifestDataValidator,
  handler: async (ctx, args) => {
    return await getActiveArtifactManifestData(
      ctx,
      args,
      COUPLING_RUNTIME_PACKAGE_ARTIFACT,
      'Coupling runtime package is not configured on the server'
    );
  },
});

