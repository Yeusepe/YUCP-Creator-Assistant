import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import * as ed25519 from '@noble/ed25519';
import { zipSync } from 'fflate';
import { type CatalogDatabase, openCatalogDatabase, runCatalogMigrations } from '../catalog';
import {
  computeOutputTreeRootV2,
  packageContractKeyId,
  verifyDeliveryGrantV2,
  verifyMaterializationReceiptV2,
} from '../storage-core/packageContractsV2';
import { ACTIVE_PROTECTION_POLICY_ID } from '../storage-core/protectionPolicyId';
import { waitForPostgres } from '../testing/postgresReadiness';
import type { MaterializationKeyBrokerPort } from './keyBrokerClient';
import { MaterializationBroker } from './materializationBroker';
import type { RenditionStoragePort } from './renditionStorage';

const postgresImage =
  'postgres@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193';
const databaseName = 'materialization_test';
const databasePassword = 'materialization-test-password';
const containerName = `yucp-materialization-${randomUUID()}`;
const capabilityPrivateKey = new Uint8Array(32).fill(0x19);
const capabilityKeyId = packageContractKeyId('materialization-test-2026-01');
const sourceGrantPrivateKey = new Uint8Array(32).fill(0x29);
const sourceGrantKeyId = packageContractKeyId('source-grant-test-2026-01');
const receiptPrivateKey = new Uint8Array(32).fill(0x39);
const receiptKeyId = packageContractKeyId('receipt-test-2026-01');
const nowSeconds = 2_000_000_000;
const sourceVersionId = '018f8c03-3880-7d40-a8d5-b190a64141cc';

const keyBroker: MaterializationKeyBrokerPort = {
  async prepareSubject(input) {
    return {
      buyerSubjectPseudonym: createHash('sha256')
        .update(input.creatorId)
        .update('\0')
        .update(input.buyerId)
        .digest('base64url'),
      encryptedSubjectMapping: createHash('sha256')
        .update(input.jobId)
        .update('\0')
        .update(input.buyerId)
        .digest(),
      pseudonymMethod: 'hmac-sha256-hkdf-v2',
    };
  },
};

let sql: CatalogDatabase | undefined;
let containerStarted = false;
let renditionArchive = new Uint8Array();
let renditionVersion = 'rendition-version-1';

const renditionStorage: RenditionStoragePort = {
  bucketName: 'renditions-test',
  async createUploadTicket(input) {
    return {
      bucketName: 'renditions-test',
      headers: {
        'content-length': String(input.bytes),
        'content-type': 'application/zip',
        'x-amz-content-sha256': input.sha256Hex,
      },
      objectKey: input.objectKey,
      storageRole: 'renditions',
      url: `https://storage.example.test/renditions-test/${input.objectKey}`,
    };
  },
  async getExactVersion() {
    return new Response(renditionArchive);
  },
  async headExactVersion(objectKey, providerVersion) {
    return {
      bucketName: 'renditions-test',
      contentLength: renditionArchive.byteLength,
      contentType: 'application/zip',
      etag: '"test-etag"',
      fileIdentifier: providerVersion,
      metadata: {
        'yucp-sha256': createHash('sha256').update(renditionArchive).digest('hex'),
      },
      objectKey,
      providerVersion,
      storageRole: 'renditions',
    };
  },
};

type CommandResult = {
  exitCode: number;
  stderr: string;
  stdout: string;
};

async function runDocker(args: string[]): Promise<CommandResult> {
  const process = Bun.spawn(['docker', ...args], {
    stderr: 'pipe',
    stdin: 'ignore',
    stdout: 'pipe',
  });
  const [exitCode, stderr, stdout] = await Promise.all([
    process.exited,
    new Response(process.stderr).text(),
    new Response(process.stdout).text(),
  ]);
  return { exitCode, stderr: stderr.trim(), stdout: stdout.trim() };
}

async function requireDocker(args: string[]): Promise<string> {
  const result = await runDocker(args);
  if (result.exitCode !== 0) {
    throw new Error(`Docker failed with exit code ${result.exitCode}: ${result.stderr}`);
  }
  return result.stdout;
}

async function removeContainer(): Promise<void> {
  if (!containerStarted) {
    return;
  }
  const result = await runDocker(['rm', '--force', containerName]);
  containerStarted = false;
  if (result.exitCode !== 0 && !result.stderr.includes('No such container')) {
    throw new Error(`PostgreSQL cleanup failed: ${result.stderr}`);
  }
}

function requireSql(): CatalogDatabase {
  if (!sql) {
    throw new Error('The materialization test database is unavailable');
  }
  return sql;
}

function createBroker(): MaterializationBroker {
  return new MaterializationBroker({
    keyBroker,
    receiptSigning: {
      keyId: receiptKeyId,
      lifetimeSeconds: 7 * 24 * 60 * 60,
      privateKey: receiptPrivateKey,
    },
    renditionStorage,
    sourceGrant: {
      audience: 'yucp-materialization-source',
      baseUrl: 'https://delivery.example.test',
      issuer: 'https://api.example.test',
      keyId: sourceGrantKeyId,
      lifetimeSeconds: 300,
      privateKey: sourceGrantPrivateKey,
    },
    sql: requireSql(),
  });
}

beforeAll(async () => {
  try {
    await requireDocker(['version']);
    await requireDocker([
      'run',
      '--detach',
      '--rm',
      '--name',
      containerName,
      '--env',
      `POSTGRES_PASSWORD=${databasePassword}`,
      '--env',
      `POSTGRES_DB=${databaseName}`,
      '--publish',
      '127.0.0.1::5432',
      '--tmpfs',
      '/var/lib/postgresql/data',
      postgresImage,
    ]);
    containerStarted = true;
    await waitForPostgres({ containerName, databaseName, runDocker });
    const portOutput = await requireDocker(['port', containerName, '5432/tcp']);
    const port = /127\.0\.0\.1:(\d+)$/.exec(portOutput)?.[1];
    if (!port) {
      throw new Error(`PostgreSQL port output is invalid: ${portOutput}`);
    }
    sql = openCatalogDatabase(
      `postgres://postgres:${databasePassword}@127.0.0.1:${port}/${databaseName}`
    );
    await runCatalogMigrations(sql);
  } catch (error) {
    await sql?.end({ timeout: 1 });
    sql = undefined;
    await removeContainer();
    throw error;
  }
});

beforeEach(async () => {
  await requireSql()`
    TRUNCATE TABLE
      materialization_attribution_records,
      materialization_capabilities,
      materialization_jobs
    CASCADE
  `;
  await requireSql()`
    INSERT INTO package_versions (
      id,
      package_id,
      version,
      source_format,
      release_root,
      assembly_object_id,
      common_root,
      protected_source_root,
      binding_root,
      manifest_sha256,
      active_content_digest,
      active_policy_version,
      protection_policy_id,
      protection_policy_digest,
      logical_bytes,
      logical_files,
      protected_files,
      state
    )
    VALUES (
      ${sourceVersionId},
      'com.yucp.materialization-test',
      '1.0.0',
      'zip',
      ${'11'.repeat(32)},
      'assemblies/materialization-test.logical-tree-manifest-v4.cbor',
      ${'33'.repeat(32)},
      ${'22'.repeat(32)},
      ${'23'.repeat(32)},
      ${'88'.repeat(32)},
      ${'44'.repeat(32)},
      'active-content-v1',
      ${ACTIVE_PROTECTION_POLICY_ID},
      ${'55'.repeat(32)},
      4096,
      2,
      ${requireSql().json([
        {
          materializerType: 'png',
          normalizedPath: 'Assets/Product/a.png',
          required: false,
          sourceSha256: '41'.repeat(32),
        },
      ])},
      'READY'
    )
    ON CONFLICT (id) DO NOTHING
  `;
});

afterAll(async () => {
  const activeSql = sql;
  sql = undefined;
  try {
    await activeSql?.end({ timeout: 1 });
  } finally {
    await removeContainer();
  }
});

describe.serial('PostgreSQL materialization capability broker', () => {
  it('consumes one fenced capability without returning materialization keys', async () => {
    let broker = createBroker();
    const installJob = {
      bindingRoot: new Uint8Array(32).fill(0x23),
      buyerId: 'buyer-1',
      creatorId: 'creator-1',
      grantJti: 'grant-1',
      id: 'job-1',
      keyEpoch: 7,
      materializationAlgorithm: 'png-dct-qim-v2',
      outputFormat: 'zip' as const,
      pluginVersion: 'png-plugin-2',
      productId: 'com.yucp.materialization-test',
      protectedSourceRoot: new Uint8Array(32).fill(0x22),
      releaseRoot: new Uint8Array(32).fill(0x11),
      sourceLogicalBytes: 4_096,
      sourceLogicalFiles: 2,
      sourceManifestSha256: new Uint8Array(32).fill(0x88),
      sourceVersionId,
      traceId: 'trace-1',
    };
    await broker.createInstallJob(installJob);
    await broker.createInstallJob(installJob);
    broker = createBroker();
    const activePinRows = await requireSql()<Array<{ pinId: string; releasedAt: Date | null }>>`
      SELECT
        pin.id::text AS "pinId",
        pin.released_at AS "releasedAt"
      FROM materialization_jobs job
      JOIN storage_gc_release_pins pin ON pin.id = job.storage_gc_pin_id
      WHERE job.id = 'job-1'
    `;
    const storagePinId = activePinRows[0]?.pinId;
    expect(storagePinId).toBeString();
    expect(activePinRows[0]?.releasedAt).toBeNull();
    const attributionRows = await requireSql()<
      {
        buyerSubjectPseudonym: string;
        encryptedSubjectMapping: Buffer;
        pseudonymMethod: string;
      }[]
    >`
      SELECT
        buyer_subject_pseudonym AS "buyerSubjectPseudonym",
        encrypted_subject_mapping AS "encryptedSubjectMapping",
        pseudonym_method AS "pseudonymMethod"
      FROM materialization_jobs
      WHERE id = 'job-1'
    `;
    expect(attributionRows[0]?.buyerSubjectPseudonym).not.toBe('buyer-1');
    expect(attributionRows[0]?.pseudonymMethod).toBe('hmac-sha256-hkdf-v2');
    expect(
      attributionRows[0]?.encryptedSubjectMapping.includes(Buffer.from('buyer-1'))
    ).toBeFalse();
    let immutableConflict: unknown;
    try {
      await broker.createInstallJob({
        ...installJob,
        creatorId: 'different-creator',
      });
    } catch (error) {
      immutableConflict = error;
    }
    expect(immutableConflict).toBeInstanceOf(Error);
    expect((immutableConflict as Error).message).toContain(
      'conflicts with different immutable input'
    );
    const claimed = await broker.claimNextJob({
      leaseDurationMs: 600_000,
      leaseOwner: 'data-node-1',
      now: new Date(nowSeconds * 1_000),
    });
    expect(claimed).toMatchObject({
      jobId: 'job-1',
      leaseGeneration: 1,
      status: 'claimed',
    });
    if (claimed.status !== 'claimed') {
      throw new Error('Expected the materialization job to be claimed');
    }
    const renewed = await broker.renewClaimLease({
      jobId: claimed.jobId,
      leaseDurationMs: 600_000,
      leaseGeneration: claimed.leaseGeneration,
      leaseOwner: 'data-node-1',
      now: new Date((nowSeconds + 120) * 1_000),
    });
    expect(renewed).toEqual({
      jobId: 'job-1',
      leaseExpiresAt: new Date((nowSeconds + 720) * 1_000),
      leaseGeneration: 1,
      status: 'renewed',
    });
    const signed = await broker.issueCapability({
      jobId: claimed.jobId,
      keyId: capabilityKeyId,
      leaseGeneration: claimed.leaseGeneration,
      leaseOwner: 'data-node-1',
      lifetimeSeconds: 300,
      now: new Date(nowSeconds * 1_000),
      privateKey: capabilityPrivateKey,
      proofKeyThumbprint: new Uint8Array(32).fill(0x33),
    });
    const capabilityPublicKey = await ed25519.getPublicKeyAsync(capabilityPrivateKey);
    const consumed = await broker.consumeCapability({
      coseSign1: signed.coseSign1,
      expectedKeyId: capabilityKeyId,
      materializerId: 'data-node-1',
      now: new Date((nowSeconds + 1) * 1_000),
      publicKey: capabilityPublicKey,
      proofJti: 'proof-1',
      traceId: 'trace-1',
      verifiedProofKeyThumbprint: new Uint8Array(32).fill(0x33),
    });

    expect(consumed).toMatchObject({
      algorithmVersion: 'png-dct-qim-v2',
      capabilityId: signed.capability.capabilityId,
      creatorDomain: 'creator-1',
      jobId: 'job-1',
      keyEpoch: 7,
      leaseGeneration: 1,
      outputFormat: 'zip',
      success: true,
    });
    expect(consumed.sourceTree).toMatchObject({
      logicalBytes: 4_096,
      logicalFiles: 2,
      manifestSha256: '88'.repeat(32),
      manifestUrl: `https://delivery.example.test/v2/internal/materialization-sources/${sourceVersionId}/manifest`,
      versionId: sourceVersionId,
    });
    const sourceGrantPublicKey = await ed25519.getPublicKeyAsync(sourceGrantPrivateKey);
    await expect(
      verifyDeliveryGrantV2({
        context: {
          audience: 'yucp-materialization-source',
          deviceKeyThumbprint: new Uint8Array(32).fill(0x33),
          issuer: 'https://api.example.test',
          now: nowSeconds + 1,
          requiredScope: `materialization-source:${sourceVersionId}`,
        },
        coseSign1: Buffer.from(consumed.sourceTree.grant, 'base64url'),
        expectedKeyId: sourceGrantKeyId,
        publicKey: sourceGrantPublicKey,
      })
    ).resolves.toMatchObject({
      buyerId: 'data-node-1',
      grantId: expect.any(String),
      installSessionId: 'job-1',
    });
    expect(consumed).not.toHaveProperty('keyEnvelope');

    const personalizedBytes = new TextEncoder().encode('personalized png bytes');
    renditionArchive = zipSync({
      'Assets/Product/a.png': personalizedBytes,
      'Assets/Product/common.txt': new TextEncoder().encode('common bytes'),
    });
    const renditionSha256 = createHash('sha256').update(renditionArchive).digest('hex');
    const outputSha256 = createHash('sha256').update(personalizedBytes).digest('hex');
    const upload = await broker.prepareRenditionUpload({
      bytes: renditionArchive.byteLength,
      capabilityId: signed.capability.capabilityId,
      coseSign1: signed.coseSign1,
      jobId: 'job-1',
      leaseGeneration: 1,
      materializerId: 'data-node-1',
      now: new Date((nowSeconds + 2) * 1_000),
      proofJti: 'proof-upload-1',
      sha256: renditionSha256,
      traceId: 'trace-1',
      verifiedProofKeyThumbprint: new Uint8Array(32).fill(0x33),
    });
    expect(upload).toMatchObject({
      upload: {
        bucketName: 'renditions-test',
        storageRole: 'renditions',
      },
    });
    expect(typeof upload.expiresAt).toBe('string');
    expect(typeof upload.writeIntentId).toBe('string');
    expect(upload.upload.objectKey).toMatch(/^v2\/renditions\/[0-9a-f]{2}\/[0-9a-f-]{36}\.zip$/);

    renditionVersion = 'rendition-version-1';
    const completionInput = {
      attributionRecords: [
        {
          attributionId: 'attribution-1',
          attributionTokenHash: '55'.repeat(32),
          normalizedPath: 'Assets/Product/a.png',
          sourceSha256: '41'.repeat(32),
        },
      ],
      builds: {
        codec: 'png-codec-build-2',
        helper: 'materializer-host-2',
        runtime: 'coupling-runtime-sha256:test',
      },
      capabilityId: signed.capability.capabilityId,
      coseSign1: signed.coseSign1,
      jobId: 'job-1',
      leaseGeneration: 1,
      materializerId: 'data-node-1',
      now: new Date((nowSeconds + 3) * 1_000),
      outputFiles: [
        {
          attributionId: 'attribution-1',
          normalizedPath: 'Assets/Product/a.png',
          outputBytes: personalizedBytes.byteLength,
          outputSha256,
        },
      ],
      outputTreeRoot: createHash('sha256').update('not-the-tree-root').digest('hex'),
      providerVersion: renditionVersion,
      proofJti: 'proof-complete-1',
      traceId: 'trace-1',
      verifiedProofKeyThumbprint: new Uint8Array(32).fill(0x33),
      writeIntentId: upload.writeIntentId,
    };
    let completionError: unknown;
    try {
      await broker.completeRendition(completionInput);
    } catch (error) {
      completionError = error;
    }
    expect(completionError).toBeInstanceOf(Error);
    expect((completionError as Error).message).toContain('output tree');
    const trustedOutputTreeRoot = Buffer.from(
      computeOutputTreeRootV2([
        {
          attributionId: 'attribution-1',
          normalizedPath: 'Assets/Product/a.png',
          outputBytes: personalizedBytes.byteLength,
          outputSha256: Buffer.from(outputSha256, 'hex'),
        },
      ])
    ).toString('hex');
    const completed = await broker.completeRendition({
      ...completionInput,
      outputTreeRoot: trustedOutputTreeRoot,
      proofJti: 'proof-complete-2',
    });
    expect(completed.success).toBeTrue();
    const releasedPinRows = await requireSql()<Array<{ releasedAt: Date | null }>>`
      SELECT released_at AS "releasedAt"
      FROM storage_gc_release_pins
      WHERE id = ${storagePinId}
    `;
    expect(releasedPinRows[0]?.releasedAt).toBeInstanceOf(Date);
    const receiptPublicKey = await ed25519.getPublicKeyAsync(receiptPrivateKey);
    const receipt = await verifyMaterializationReceiptV2({
      coseSign1: Buffer.from(completed.receipt, 'base64url'),
      expectedKeyId: receiptKeyId,
      publicKey: receiptPublicKey,
    });
    expect(receipt.capabilityId).toBe(signed.capability.capabilityId);
    expect(receipt.jobId).toBe('job-1');
    expect(receipt.materializerId).toBe('data-node-1');
    expect(receipt.rendition.bucketName).toBe('renditions-test');
    expect(receipt.rendition.objectBytes).toBe(renditionArchive.byteLength);
    expect(Buffer.from(receipt.rendition.objectSha256).toString('hex')).toBe(renditionSha256);
    expect(receipt.rendition.providerVersion).toBe(renditionVersion);
    expect(receipt.rendition.storageRole).toBe('renditions');
    expect(Buffer.from(receipt.outputTreeRoot).toString('hex')).toBe(trustedOutputTreeRoot);
    expect(
      await broker.completeRendition({
        ...completionInput,
        outputTreeRoot: trustedOutputTreeRoot,
        proofJti: 'proof-complete-3',
      })
    ).toEqual(completed);
    const attributionCandidates = await broker.listAttributionCandidates({
      creatorId: 'creator-1',
      productId: 'com.yucp.materialization-test',
    });
    expect(attributionCandidates).toEqual({
      candidateLimit: 512,
      candidates: [
        {
          algorithmVersion: 'png-dct-qim-v2',
          attributionId: 'attribution-1',
          attributionTokenHash: '55'.repeat(32),
          buyerSubjectPseudonym: consumed.buyerSubjectPseudonym,
          capabilityId: signed.capability.capabilityId,
          createdAt: expect.any(Number),
          creatorId: 'creator-1',
          jobId: 'job-1',
          keyEpoch: 7,
          leaseGeneration: 1,
          materializerType: 'png',
          normalizedPath: 'Assets/Product/a.png',
          outputFormat: 'zip',
          pluginVersion: 'png-plugin-2',
          protectedSourceRoot: '22'.repeat(32),
          releaseRoot: '11'.repeat(32),
          sourceSha256: '41'.repeat(32),
        },
      ],
      truncated: false,
    });

    await broker.createInstallJob({
      ...installJob,
      grantJti: 'grant-2',
      id: 'job-2',
      traceId: 'trace-2',
    });
    const secondClaim = await broker.claimNextJob({
      leaseDurationMs: 600_000,
      leaseOwner: 'data-node-1',
      now: new Date((nowSeconds + 4) * 1_000),
    });
    expect(secondClaim).toMatchObject({
      jobId: 'job-2',
      leaseGeneration: 1,
      status: 'claimed',
    });
    if (secondClaim.status !== 'claimed') {
      throw new Error('Expected the repeated materialization job to be claimed');
    }
    const secondSigned = await broker.issueCapability({
      jobId: secondClaim.jobId,
      keyId: capabilityKeyId,
      leaseGeneration: secondClaim.leaseGeneration,
      leaseOwner: 'data-node-1',
      lifetimeSeconds: 300,
      now: new Date((nowSeconds + 4) * 1_000),
      privateKey: capabilityPrivateKey,
      proofKeyThumbprint: new Uint8Array(32).fill(0x33),
    });
    await broker.consumeCapability({
      coseSign1: secondSigned.coseSign1,
      expectedKeyId: capabilityKeyId,
      materializerId: 'data-node-1',
      now: new Date((nowSeconds + 5) * 1_000),
      publicKey: capabilityPublicKey,
      proofJti: 'proof-second-consume',
      traceId: 'trace-2',
      verifiedProofKeyThumbprint: new Uint8Array(32).fill(0x33),
    });
    const secondUpload = await broker.prepareRenditionUpload({
      bytes: renditionArchive.byteLength,
      capabilityId: secondSigned.capability.capabilityId,
      coseSign1: secondSigned.coseSign1,
      jobId: 'job-2',
      leaseGeneration: 1,
      materializerId: 'data-node-1',
      now: new Date((nowSeconds + 6) * 1_000),
      proofJti: 'proof-second-upload',
      sha256: renditionSha256,
      traceId: 'trace-2',
      verifiedProofKeyThumbprint: new Uint8Array(32).fill(0x33),
    });
    renditionVersion = 'rendition-version-2';
    const secondCompleted = await broker.completeRendition({
      ...completionInput,
      capabilityId: secondSigned.capability.capabilityId,
      coseSign1: secondSigned.coseSign1,
      jobId: 'job-2',
      now: new Date((nowSeconds + 7) * 1_000),
      outputTreeRoot: trustedOutputTreeRoot,
      proofJti: 'proof-second-complete',
      providerVersion: renditionVersion,
      traceId: 'trace-2',
      writeIntentId: secondUpload.writeIntentId,
    });
    expect(secondCompleted).toMatchObject({ success: true });
    const repeatedAttributionRows = await requireSql()<Array<{ count: number }>>`
      SELECT count(*)::int AS count
      FROM materialization_attribution_records
      WHERE attribution_id = 'attribution-1'
    `;
    expect(repeatedAttributionRows[0]?.count).toBe(2);
    const repeatedAttributionCandidates = await broker.listAttributionCandidates({
      creatorId: 'creator-1',
      productId: 'com.yucp.materialization-test',
    });
    expect(repeatedAttributionCandidates.candidates).toHaveLength(1);
    expect(repeatedAttributionCandidates.candidates[0]).toMatchObject({
      attributionId: 'attribution-1',
      capabilityId: secondSigned.capability.capabilityId,
      jobId: 'job-2',
    });
    expect(repeatedAttributionCandidates.truncated).toBe(false);

    await broker.createInstallJob({
      ...installJob,
      grantJti: 'grant-failed',
      id: 'job-failed',
      traceId: 'trace-failed',
    });
    const failedClaim = await broker.claimNextJob({
      leaseDurationMs: 600_000,
      leaseOwner: 'data-node-1',
      now: new Date((nowSeconds + 8) * 1_000),
    });
    if (failedClaim.status !== 'claimed') {
      throw new Error('Expected the failed materialization job to be claimed');
    }
    const failedCapability = await broker.issueCapability({
      jobId: failedClaim.jobId,
      keyId: capabilityKeyId,
      leaseGeneration: failedClaim.leaseGeneration,
      leaseOwner: 'data-node-1',
      lifetimeSeconds: 300,
      now: new Date((nowSeconds + 8) * 1_000),
      privateKey: capabilityPrivateKey,
      proofKeyThumbprint: new Uint8Array(32).fill(0x44),
    });
    await broker.consumeCapability({
      coseSign1: failedCapability.coseSign1,
      expectedKeyId: capabilityKeyId,
      materializerId: 'data-node-1',
      now: new Date((nowSeconds + 9) * 1_000),
      publicKey: capabilityPublicKey,
      proofJti: 'proof-failed-consume',
      traceId: 'trace-failed',
      verifiedProofKeyThumbprint: new Uint8Array(32).fill(0x44),
    });
    await broker.failCapabilityJob({
      capabilityId: failedCapability.capability.capabilityId,
      coseSign1: failedCapability.coseSign1,
      errorCode: 'MATERIALIZATION_OUTPUT_INVALID',
      jobId: 'job-failed',
      leaseGeneration: failedClaim.leaseGeneration,
      materializerId: 'data-node-1',
      now: new Date((nowSeconds + 10) * 1_000),
      proofJti: 'proof-failed-terminal',
      verifiedProofKeyThumbprint: new Uint8Array(32).fill(0x44),
    });
    const failedPinRows = await requireSql()<Array<{ releasedAt: Date | null }>>`
      SELECT pin.released_at AS "releasedAt"
      FROM materialization_jobs job
      JOIN storage_gc_release_pins pin ON pin.id = job.storage_gc_pin_id
      WHERE job.id = 'job-failed'
    `;
    expect(failedPinRows[0]?.releasedAt).toBeInstanceOf(Date);
    let cancellationConstraintError: unknown;
    try {
      await requireSql()`
        UPDATE materialization_jobs
        SET state = 'CANCELLED'
        WHERE id = 'job-failed'
      `;
    } catch (error) {
      cancellationConstraintError = error;
    }
    expect(cancellationConstraintError).toBeInstanceOf(Error);

    await requireSql()`
      UPDATE materialization_attribution_records
      SET
        attribution_id = CASE
          WHEN job_id = 'job-1' THEN 'attribution-2'
          ELSE attribution_id
        END,
        created_at = to_timestamp(${nowSeconds + 10})
      WHERE job_id IN ('job-1', 'job-2')
    `;
    const firstAttributionPage = await broker.listAttributionCandidates({
      candidateLimit: 1,
      creatorId: 'creator-1',
      productId: 'com.yucp.materialization-test',
    });
    expect(firstAttributionPage).toMatchObject({
      candidateLimit: 1,
      candidates: [{ attributionId: 'attribution-1', jobId: 'job-2' }],
      truncated: true,
    });
    expect(firstAttributionPage.nextCursor).toBeString();
    const secondAttributionPage = await broker.listAttributionCandidates({
      candidateLimit: 1,
      creatorId: 'creator-1',
      cursor: firstAttributionPage.nextCursor,
      productId: 'com.yucp.materialization-test',
    });
    expect(secondAttributionPage).toMatchObject({
      candidateLimit: 1,
      candidates: [{ attributionId: 'attribution-2', jobId: 'job-1' }],
      truncated: false,
    });
    expect(secondAttributionPage.nextCursor).toBeUndefined();

    let replayError: unknown;
    try {
      await broker.consumeCapability({
        coseSign1: signed.coseSign1,
        expectedKeyId: capabilityKeyId,
        materializerId: 'data-node-1',
        now: new Date((nowSeconds + 2) * 1_000),
        publicKey: capabilityPublicKey,
        proofJti: 'proof-2',
        traceId: 'trace-replay',
        verifiedProofKeyThumbprint: new Uint8Array(32).fill(0x33),
      });
    } catch (error) {
      replayError = error;
    }
    expect(replayError).toBeInstanceOf(Error);
    expect((replayError as Error).message).toContain('already consumed');
  }, 30_000);

  it('keeps a second large job queued while the fixed node lane is occupied', async () => {
    const broker = new MaterializationBroker({
      keyBroker,
      receiptSigning: {
        keyId: receiptKeyId,
        lifetimeSeconds: 7 * 24 * 60 * 60,
        privateKey: receiptPrivateKey,
      },
      renditionStorage,
      sourceGrant: {
        audience: 'yucp-materialization-source',
        baseUrl: 'https://delivery.example.test',
        issuer: 'https://api.example.test',
        keyId: sourceGrantKeyId,
        lifetimeSeconds: 300,
        privateKey: sourceGrantPrivateKey,
      },
      sql: requireSql(),
    });
    const base = {
      bindingRoot: new Uint8Array(32).fill(0x23),
      buyerId: 'buyer-1',
      creatorId: 'creator-1',
      grantJti: 'grant-1',
      keyEpoch: 7,
      materializationAlgorithm: 'png-dct-qim-v2',
      outputFormat: 'zip' as const,
      pluginVersion: 'png-plugin-2',
      productId: 'com.yucp.materialization-test',
      protectedSourceRoot: new Uint8Array(32).fill(0x22),
      releaseRoot: new Uint8Array(32).fill(0x11),
      sourceLogicalBytes: 4_096,
      sourceLogicalFiles: 2,
      sourceManifestSha256: new Uint8Array(32).fill(0x88),
      sourceVersionId,
      traceId: 'trace-lane',
    };
    await broker.createInstallJob({ ...base, id: 'job-1' });
    await broker.createInstallJob({ ...base, id: 'job-2' });
    expect(
      await broker.claimNextJob({
        leaseDurationMs: 60_000,
        leaseOwner: 'data-node-1',
        now: new Date(nowSeconds * 1_000),
      })
    ).toMatchObject({ jobId: 'job-1', status: 'claimed' });
    expect(
      await broker.claimNextJob({
        leaseDurationMs: 60_000,
        leaseOwner: 'data-node-1',
        now: new Date(nowSeconds * 1_000),
      })
    ).toMatchObject({
      activeJobId: 'job-1',
      queuePosition: 1,
      status: 'saturated',
    });
  });

  it('reclaims an expired materializing lease before admitting queued work', async () => {
    const broker = new MaterializationBroker({
      keyBroker,
      receiptSigning: {
        keyId: receiptKeyId,
        lifetimeSeconds: 7 * 24 * 60 * 60,
        privateKey: receiptPrivateKey,
      },
      renditionStorage,
      sourceGrant: {
        audience: 'yucp-materialization-source',
        baseUrl: 'https://delivery.example.test',
        issuer: 'https://api.example.test',
        keyId: sourceGrantKeyId,
        lifetimeSeconds: 300,
        privateKey: sourceGrantPrivateKey,
      },
      sql: requireSql(),
    });
    const base = {
      bindingRoot: new Uint8Array(32).fill(0x23),
      buyerId: 'buyer-1',
      creatorId: 'creator-1',
      grantJti: 'grant-expired-lease',
      keyEpoch: 7,
      materializationAlgorithm: 'png-dct-qim-v2',
      outputFormat: 'zip' as const,
      pluginVersion: 'png-plugin-2',
      productId: 'com.yucp.materialization-test',
      protectedSourceRoot: new Uint8Array(32).fill(0x22),
      releaseRoot: new Uint8Array(32).fill(0x11),
      sourceLogicalBytes: 4_096,
      sourceLogicalFiles: 2,
      sourceManifestSha256: new Uint8Array(32).fill(0x88),
      sourceVersionId,
      traceId: 'trace-expired-lease',
    };
    await broker.createInstallJob({ ...base, id: 'job-expired' });
    await broker.createInstallJob({ ...base, id: 'job-next' });
    expect(
      await broker.claimNextJob({
        leaseDurationMs: 60_000,
        leaseOwner: 'data-node-1',
        now: new Date(nowSeconds * 1_000),
      })
    ).toMatchObject({
      jobId: 'job-expired',
      leaseGeneration: 1,
      status: 'claimed',
    });

    expect(
      await broker.claimNextJob({
        leaseDurationMs: 60_000,
        leaseOwner: 'data-node-1',
        now: new Date((nowSeconds + 61) * 1_000),
      })
    ).toMatchObject({
      jobId: 'job-expired',
      leaseGeneration: 2,
      status: 'claimed',
    });
  });
});
