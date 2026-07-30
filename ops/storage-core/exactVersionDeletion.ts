import type { CasConfig } from './config';
import { S3ExactStoragePort, type StorageRole } from './exactStorage';

type GcStorageRole = Extract<StorageRole, 'common' | 'metadata' | 'protected'>;

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

export function createExactVersionDeletionPort(
  configs: Record<GcStorageRole, CasConfig>
): ExactVersionDeletionPort {
  return new S3ExactVersionDeletionPort(configs);
}
