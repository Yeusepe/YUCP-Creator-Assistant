import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PackageQuarantineObject } from '../catalog';
import { ACTIVE_PROTECTION_POLICY_ID } from '../storage-core/protectionPolicyId';
import {
  persistCompletedUpload,
  type QuarantineCatalogPort,
  type QuarantineStoragePort,
} from './quarantine';

function pending(versionId: string, objectKey: string, sha256: string, bytes: number) {
  return {
    bytes,
    contentType: 'application/zip',
    createdAt: new Date(0),
    creatorId: 'creator-checkpoint',
    fileIdentifier: null,
    objectKey,
    protectionPolicyId: ACTIVE_PROTECTION_POLICY_ID,
    providerVersion: null,
    sha256,
    state: 'PENDING' as const,
    updatedAt: new Date(0),
    versionId,
  };
}

describe('completed upload quarantine', () => {
  it('records the write intent before storing and verifies the exact version', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yucp-quarantine-'));
    try {
      const path = join(root, 'package.zip');
      const bytes = Buffer.from('complete uploaded package');
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      await writeFile(path, bytes);
      const calls: string[] = [];
      const checkpointInputs: unknown[] = [];
      let record: PackageQuarantineObject | null = null;
      const catalog: QuarantineCatalogPort = {
        async beginQuarantineObject(input) {
          calls.push('intent');
          checkpointInputs.push(input);
          record = pending(input.versionId, input.objectKey, input.sha256, input.bytes);
          return record;
        },
        async commitQuarantineObject(input) {
          calls.push('commit');
          record = {
            ...(record as PackageQuarantineObject),
            fileIdentifier: input.fileIdentifier,
            providerVersion: input.providerVersion,
            state: 'COMMITTED',
          };
          return record;
        },
        async markQuarantineObjectUncertain() {
          throw new Error('must not become uncertain');
        },
      };
      const storage: QuarantineStoragePort = {
        async getExactVersion() {
          throw new Error('must not restore during persistence');
        },
        async headExactVersion() {
          calls.push('head');
          return {
            contentLength: bytes.byteLength,
            contentType: 'application/zip',
            fileIdentifier: 'file-1',
            metadata: { 'yucp-sha256': sha256 },
            providerVersion: 'version-1',
          };
        },
        async listVersions() {
          calls.push('list');
          return [];
        },
        async putFile() {
          calls.push('put');
          return {
            fileIdentifier: 'file-1',
            providerVersion: 'version-1',
          };
        },
      };

      const result = await persistCompletedUpload({
        catalog,
        contentType: 'application/zip',
        creatorId: 'creator-checkpoint',
        path,
        protectionPolicyId: ACTIVE_PROTECTION_POLICY_ID,
        storage,
        versionId: '018f8c03-3880-7d40-a8d5-b190a64141cc',
      });

      expect(result).toMatchObject({
        fileIdentifier: 'file-1',
        providerVersion: 'version-1',
        sha256,
        state: 'COMMITTED',
      });
      expect(checkpointInputs).toEqual([
        expect.objectContaining({
          creatorId: 'creator-checkpoint',
          protectionPolicyId: ACTIVE_PROTECTION_POLICY_ID,
        }),
      ]);
      expect(calls).toEqual(['intent', 'list', 'put', 'head', 'commit']);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it('adopts one verified version after an interrupted database commit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yucp-quarantine-'));
    try {
      const path = join(root, 'package.zip');
      const bytes = Buffer.from('recoverable uploaded package');
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      await writeFile(path, bytes);
      const versionId = '018f8c03-3880-7d40-a8d5-b190a64141cc';
      const objectKey = `raw/${versionId}/${sha256}.zip`;
      const calls: string[] = [];
      const catalog: QuarantineCatalogPort = {
        async beginQuarantineObject() {
          calls.push('intent');
          return pending(versionId, objectKey, sha256, bytes.byteLength);
        },
        async commitQuarantineObject(input) {
          calls.push('commit');
          return {
            ...pending(versionId, objectKey, sha256, bytes.byteLength),
            fileIdentifier: input.fileIdentifier,
            providerVersion: input.providerVersion,
            state: 'COMMITTED',
          };
        },
        async markQuarantineObjectUncertain() {
          throw new Error('must not become uncertain');
        },
      };
      const storage: QuarantineStoragePort = {
        async getExactVersion() {
          throw new Error('must not restore during persistence');
        },
        async headExactVersion() {
          calls.push('head');
          return {
            contentLength: bytes.byteLength,
            contentType: 'application/zip',
            fileIdentifier: 'existing-file',
            metadata: { 'yucp-sha256': sha256 },
            providerVersion: 'existing-version',
          };
        },
        async listVersions() {
          calls.push('list');
          return [
            {
              fileIdentifier: 'existing-file',
              providerVersion: 'existing-version',
            },
          ];
        },
        async putFile() {
          throw new Error('must not upload a duplicate version');
        },
      };

      const result = await persistCompletedUpload({
        catalog,
        contentType: 'application/zip',
        creatorId: 'creator-checkpoint',
        path,
        protectionPolicyId: ACTIVE_PROTECTION_POLICY_ID,
        storage,
        versionId,
      });

      expect(result.providerVersion).toBe('existing-version');
      expect(calls).toEqual(['intent', 'list', 'head', 'commit']);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
