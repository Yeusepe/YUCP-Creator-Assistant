import type { CasConfig } from './config';
import {
  copyS3ObjectVersion,
  createS3PutObjectUploadTicket,
  deleteS3ObjectVersion,
  getS3ObjectRetention,
  getS3ObjectVersion,
  headS3ObjectVersion,
  listS3ObjectVersions,
  putS3FileVersioned,
  putS3ObjectImmutable,
  putS3ObjectVersioned,
  type S3ObjectRetention,
} from './s3Control';

export const STORAGE_ROLES = [
  'common',
  'metadata',
  'protected',
  'quarantine',
  'renditions',
] as const;

export type StorageRole = (typeof STORAGE_ROLES)[number];

export type ExactObjectVersion = {
  bucketName: string;
  fileIdentifier: string;
  objectKey: string;
  providerVersion: string;
  storageRole: StorageRole;
};

export type ExactObjectHead = ExactObjectVersion & {
  contentLength: number;
  contentType: string | null;
  etag: string | null;
  metadata: Record<string, string>;
};

export type ExactImmutableObjectVersion = ExactObjectVersion & {
  bytes: number;
  sha256: string;
  status: 'created' | 'existing';
  /**
   * True when the write response itself proved the stored bytes (ETag == body MD5, or a
   * versioning provider echoed the new version id). Absent or false means the caller must
   * keep its own read-back verification.
   */
  writeProven?: boolean;
};

export type ExactVersionedObjectVersion = ExactObjectVersion & {
  bytes: number;
  sha256: string;
};

export type ExactFileVersion = ExactObjectVersion & {
  multipart: boolean;
  parts: number;
};

export type ExactUploadTicket = {
  bucketName: string;
  headers: Record<string, string>;
  objectKey: string;
  storageRole: StorageRole;
  url: string;
};

export interface ExactStoragePort {
  bucketName(role: StorageRole): string;
  copyExactVersion(input: {
    destinationKey: string;
    destinationRole: StorageRole;
    sourceKey: string;
    sourceProviderVersion: string;
    sourceRole: StorageRole;
  }): Promise<ExactObjectVersion>;
  createUploadTicket(input: {
    bytes: number;
    contentType: string;
    expiresSeconds: number;
    objectKey: string;
    now: Date;
    role: StorageRole;
    sha256: string;
  }): Promise<ExactUploadTicket>;
  deleteExactVersion(input: {
    objectKey: string;
    providerVersion: string;
    role: StorageRole;
  }): Promise<void>;
  getExactVersion(input: {
    expectedBytes?: number;
    objectKey: string;
    providerVersion: string;
    role: StorageRole;
  }): Promise<Response>;
  getRetention(input: {
    objectKey: string;
    providerVersion: string;
    role: StorageRole;
  }): Promise<S3ObjectRetention>;
  headExactVersion(input: {
    objectKey: string;
    providerVersion: string;
    role: StorageRole;
  }): Promise<ExactObjectHead>;
  listExactVersions(input: { objectKey: string; role: StorageRole }): Promise<ExactObjectVersion[]>;
  putFile(input: {
    bytes: number;
    contentType: string;
    objectKey: string;
    path: string;
    precomputedSha256?: boolean;
    role: StorageRole;
    sha256: string;
  }): Promise<ExactFileVersion>;
  putImmutable(input: {
    body: Uint8Array | string;
    contentType: string;
    objectKey: string;
    role: StorageRole;
  }): Promise<ExactImmutableObjectVersion>;
  putVersioned(input: {
    body: Uint8Array | string;
    contentType: string;
    objectKey: string;
    role: StorageRole;
  }): Promise<ExactVersionedObjectVersion>;
}

export class S3ExactStoragePort implements ExactStoragePort {
  readonly #configs: Readonly<Partial<Record<StorageRole, CasConfig>>>;

  constructor(configs: Partial<Record<StorageRole, CasConfig>>) {
    this.#configs = Object.fromEntries(
      Object.entries(configs).map(([role, config]) => [role, config ? { ...config } : config])
    );
  }

  #config(role: StorageRole): CasConfig {
    const config = this.#configs[role];
    if (!config) {
      throw new Error(`Storage role ${role} is not configured`);
    }
    return config;
  }

  #version(
    role: StorageRole,
    objectKey: string,
    version: { fileIdentifier: string; versionId: string }
  ): ExactObjectVersion {
    return {
      bucketName: this.#config(role).bucket,
      fileIdentifier: version.fileIdentifier,
      objectKey,
      providerVersion: version.versionId,
      storageRole: role,
    };
  }

  bucketName(role: StorageRole): string {
    return this.#config(role).bucket;
  }

  async copyExactVersion(input: {
    destinationKey: string;
    destinationRole: StorageRole;
    sourceKey: string;
    sourceProviderVersion: string;
    sourceRole: StorageRole;
  }): Promise<ExactObjectVersion> {
    const version = await copyS3ObjectVersion({
      destination: this.#config(input.destinationRole),
      destinationKey: input.destinationKey,
      source: this.#config(input.sourceRole),
      sourceKey: input.sourceKey,
      sourceVersionId: input.sourceProviderVersion,
    });
    return this.#version(input.destinationRole, input.destinationKey, version);
  }

  async createUploadTicket(input: {
    bytes: number;
    contentType: string;
    expiresSeconds: number;
    objectKey: string;
    now: Date;
    role: StorageRole;
    sha256: string;
  }): Promise<ExactUploadTicket> {
    const ticket = await createS3PutObjectUploadTicket({
      bytes: input.bytes,
      config: this.#config(input.role),
      contentType: input.contentType,
      expiresSeconds: input.expiresSeconds,
      key: input.objectKey,
      now: input.now,
      sha256Hex: input.sha256,
    });
    return {
      bucketName: this.bucketName(input.role),
      headers: ticket.headers,
      objectKey: input.objectKey,
      storageRole: input.role,
      url: ticket.url,
    };
  }

  deleteExactVersion(input: {
    objectKey: string;
    providerVersion: string;
    role: StorageRole;
  }): Promise<void> {
    return deleteS3ObjectVersion(this.#config(input.role), input.objectKey, input.providerVersion);
  }

  getExactVersion(input: {
    expectedBytes?: number;
    objectKey: string;
    providerVersion: string;
    role: StorageRole;
  }): Promise<Response> {
    return getS3ObjectVersion(this.#config(input.role), input.objectKey, input.providerVersion, {
      ...(input.expectedBytes ? { expectedBytes: input.expectedBytes } : {}),
    });
  }

  getRetention(input: {
    objectKey: string;
    providerVersion: string;
    role: StorageRole;
  }): Promise<S3ObjectRetention> {
    return getS3ObjectRetention(this.#config(input.role), input.objectKey, input.providerVersion);
  }

  async headExactVersion(input: {
    objectKey: string;
    providerVersion: string;
    role: StorageRole;
  }): Promise<ExactObjectHead> {
    const head = await headS3ObjectVersion(
      this.#config(input.role),
      input.objectKey,
      input.providerVersion
    );
    return {
      ...this.#version(input.role, input.objectKey, head),
      contentLength: head.contentLength,
      contentType: head.contentType,
      etag: head.etag,
      metadata: head.metadata,
    };
  }

  async listExactVersions(input: {
    objectKey: string;
    role: StorageRole;
  }): Promise<ExactObjectVersion[]> {
    return (await listS3ObjectVersions(this.#config(input.role), input.objectKey))
      .filter((version) => !version.deleteMarker && version.key === input.objectKey)
      .map((version) =>
        this.#version(input.role, input.objectKey, {
          fileIdentifier: version.versionId,
          versionId: version.versionId,
        })
      );
  }

  async putFile(input: {
    bytes: number;
    contentType: string;
    objectKey: string;
    path: string;
    precomputedSha256?: boolean;
    role: StorageRole;
    sha256: string;
  }): Promise<ExactFileVersion> {
    const version = await putS3FileVersioned({
      config: this.#config(input.role),
      contentType: input.contentType,
      expectedBytes: input.bytes,
      expectedSha256: input.sha256,
      key: input.objectKey,
      path: input.path,
      ...(input.precomputedSha256 ? { precomputedSha256: true } : {}),
    });
    return {
      ...this.#version(input.role, input.objectKey, version),
      multipart: version.multipart,
      parts: version.parts,
    };
  }

  async putImmutable(input: {
    body: Uint8Array | string;
    contentType: string;
    objectKey: string;
    role: StorageRole;
  }): Promise<ExactImmutableObjectVersion> {
    const version = await putS3ObjectImmutable({
      body: input.body,
      config: this.#config(input.role),
      contentType: input.contentType,
      key: input.objectKey,
    });
    return {
      ...this.#version(input.role, input.objectKey, version),
      bytes: version.bytes,
      sha256: version.sha256,
      status: version.status,
      writeProven: version.writeProven,
    };
  }

  async putVersioned(input: {
    body: Uint8Array | string;
    contentType: string;
    objectKey: string;
    role: StorageRole;
  }): Promise<ExactVersionedObjectVersion> {
    const version = await putS3ObjectVersioned({
      body: input.body,
      config: this.#config(input.role),
      contentType: input.contentType,
      key: input.objectKey,
    });
    return {
      ...this.#version(input.role, input.objectKey, version),
      bytes: version.bytes,
      sha256: version.sha256,
    };
  }
}
