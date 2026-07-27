import type { CasConfig } from '../storage-core/config';
import { type ExactObjectHead, S3ExactStoragePort } from '../storage-core/exactStorage';

export type RenditionUploadTicket = {
  bucketName: string;
  headers: Record<string, string>;
  objectKey: string;
  storageRole: 'renditions';
  url: string;
};

export interface RenditionStoragePort {
  readonly bucketName: string;
  createUploadTicket(input: {
    bytes: number;
    expiresSeconds: number;
    objectKey: string;
    now: Date;
    sha256Hex: string;
  }): Promise<RenditionUploadTicket>;
  getExactVersion(objectKey: string, providerVersion: string): Promise<Response>;
  headExactVersion(objectKey: string, providerVersion: string): Promise<ExactObjectHead>;
}

export class S3RenditionStoragePort implements RenditionStoragePort {
  readonly bucketName: string;
  private readonly storage: S3ExactStoragePort;

  constructor(config: CasConfig) {
    this.storage = new S3ExactStoragePort({ renditions: config });
    this.bucketName = config.bucket;
  }

  async createUploadTicket(input: {
    bytes: number;
    expiresSeconds: number;
    objectKey: string;
    now: Date;
    sha256Hex: string;
  }): Promise<RenditionUploadTicket> {
    const ticket = await this.storage.createUploadTicket({
      bytes: input.bytes,
      contentType: 'application/zip',
      expiresSeconds: input.expiresSeconds,
      objectKey: input.objectKey,
      now: input.now,
      role: 'renditions',
      sha256: input.sha256Hex,
    });
    return {
      bucketName: this.bucketName,
      headers: ticket.headers,
      objectKey: input.objectKey,
      storageRole: 'renditions',
      url: ticket.url,
    };
  }

  getExactVersion(objectKey: string, providerVersion: string): Promise<Response> {
    return this.storage.getExactVersion({
      objectKey,
      providerVersion,
      role: 'renditions',
    });
  }

  headExactVersion(objectKey: string, providerVersion: string): Promise<ExactObjectHead> {
    return this.storage.headExactVersion({
      objectKey,
      providerVersion,
      role: 'renditions',
    });
  }
}
