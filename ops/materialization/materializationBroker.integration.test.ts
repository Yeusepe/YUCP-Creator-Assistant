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
import { MaterializationBroker, type MaterializationClaimResult } from './materializationBroker';
import { PostgresMaterializationDispatchOutboxRepository } from './materializationDispatch';
import { verifyMaterializationReceiptV3 } from './materializationReceiptV3';

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
  it('consumes one fenced capability and rotates source authorization on lease renewal', async () => {
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
    // A retried workflow step re-claims the job it already holds; without an
    // idempotent re-claim the owner reads its own lease as saturation forever.
    const reclaimed = await broker.claimNextJob({
      jobId: 'job-1',
      leaseDurationMs: 600_000,
      leaseOwner: 'data-node-1',
      now: new Date((nowSeconds + 1) * 1_000),
    });
    expect(reclaimed).toMatchObject({
      jobId: 'job-1',
      leaseGeneration: claimed.leaseGeneration,
      status: 'claimed',
    });
    const otherOwner = await broker.claimNextJob({
      jobId: 'job-1',
      leaseDurationMs: 600_000,
      leaseOwner: 'data-node-2',
      now: new Date((nowSeconds + 1) * 1_000),
    });
    expect(otherOwner.status).not.toBe('claimed');
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

    const renewedWithSourceAuthorization = await broker.renewClaimLease({
      jobId: claimed.jobId,
      leaseDurationMs: 600_000,
      leaseGeneration: claimed.leaseGeneration,
      leaseOwner: 'data-node-1',
      now: new Date((nowSeconds + 240) * 1_000),
    });
    expect(renewedWithSourceAuthorization).toMatchObject({
      jobId: 'job-1',
      leaseExpiresAt: new Date((nowSeconds + 840) * 1_000),
      leaseGeneration: 1,
      sourceAuthorization: {
        expiresAt: new Date((nowSeconds + 540) * 1_000),
        grant: expect.any(String),
      },
      status: 'renewed',
    });

    const personalizedBytes = new TextEncoder().encode('personalized png bytes');
    const renditionArchive = zipSync({
      'Assets/Product/a.png': personalizedBytes,
      'Assets/Product/common.txt': new TextEncoder().encode('common bytes'),
    });
    const renditionSha256 = createHash('sha256').update(renditionArchive).digest('hex');
    const outputSha256 = createHash('sha256').update(personalizedBytes).digest('hex');
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
      proofJti: 'proof-complete-1',
      renditionBytes: renditionArchive.byteLength,
      renditionSha256,
      traceId: 'trace-1',
      verifiedProofKeyThumbprint: new Uint8Array(32).fill(0x33),
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
    expect(receipt.rendition.fileIdentifier).toBe('job-1.zip');
    expect(receipt.rendition.objectBytes).toBe(renditionArchive.byteLength);
    expect(Buffer.from(receipt.rendition.objectSha256).toString('hex')).toBe(renditionSha256);
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
          keyDerivation: 'v2',
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
    const secondCompleted = await broker.completeRendition({
      ...completionInput,
      capabilityId: secondSigned.capability.capabilityId,
      coseSign1: secondSigned.coseSign1,
      jobId: 'job-2',
      now: new Date((nowSeconds + 7) * 1_000),
      outputTreeRoot: trustedOutputTreeRoot,
      proofJti: 'proof-second-complete',
      traceId: 'trace-2',
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

    // Rename attribution-2's file (record + the job's protected_files entry it
    // must join against) so the basename filter has two distinct names, with
    // deliberately different casing: matching is per lowercased basename.
    await requireSql()`
      UPDATE materialization_attribution_records
      SET normalized_path = 'Assets/Product/B.PNG'
      WHERE attribution_id = 'attribution-2'
    `;
    await requireSql()`
      UPDATE materialization_jobs
      SET protected_files = replace(
        protected_files::text, 'Assets/Product/a.png', 'Assets/Product/B.PNG'
      )::jsonb
      WHERE id = 'job-1'
    `;
    const matchedPage = await broker.listAttributionCandidates({
      creatorId: 'creator-1',
      pathBasenames: ['b.png'],
      pathFilterMode: 'match',
      productId: 'com.yucp.materialization-test',
    });
    expect(matchedPage.candidates.map((candidate) => candidate.attributionId)).toEqual([
      'attribution-2',
    ]);
    expect(matchedPage.truncated).toBeFalse();
    const excludedPage = await broker.listAttributionCandidates({
      creatorId: 'creator-1',
      pathBasenames: ['b.png'],
      pathFilterMode: 'exclude',
      productId: 'com.yucp.materialization-test',
    });
    expect(excludedPage.candidates.map((candidate) => candidate.attributionId)).toEqual([
      'attribution-1',
    ]);
    const filteredFirstPage = await broker.listAttributionCandidates({
      candidateLimit: 1,
      creatorId: 'creator-1',
      pathBasenames: ['a.png', 'b.png'],
      pathFilterMode: 'match',
      productId: 'com.yucp.materialization-test',
    });
    expect(filteredFirstPage.truncated).toBeTrue();
    expect(filteredFirstPage.nextCursor).toBeString();
    // A cursor is bound to the filter that minted it; continuing a different
    // feed with it would skip or repeat candidates.
    let crossFeedCursorError: unknown;
    try {
      await broker.listAttributionCandidates({
        creatorId: 'creator-1',
        cursor: filteredFirstPage.nextCursor,
        productId: 'com.yucp.materialization-test',
      });
    } catch (error) {
      crossFeedCursorError = error;
    }
    expect(crossFeedCursorError).toBeInstanceOf(Error);
    expect((crossFeedCursorError as Error).message).toContain('cursor is invalid');

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

  it('authorizes rendition completion through the active lease after one-time capability expiry', async () => {
    const broker = createBroker();
    await broker.createInstallJob({
      bindingRoot: new Uint8Array(32).fill(0x23),
      buyerId: 'buyer-lease-session',
      creatorId: 'creator-1',
      grantJti: 'grant-lease-session',
      id: 'job-lease-session',
      keyEpoch: 7,
      materializationAlgorithm: 'png-dct-qim-v2',
      outputFormat: 'zip',
      pluginVersion: 'png-plugin-2',
      productId: 'com.yucp.materialization-test',
      protectedSourceRoot: new Uint8Array(32).fill(0x22),
      releaseRoot: new Uint8Array(32).fill(0x11),
      sourceLogicalBytes: 4_096,
      sourceLogicalFiles: 2,
      sourceManifestSha256: new Uint8Array(32).fill(0x88),
      sourceVersionId,
      traceId: 'trace-lease-session',
    });
    const claim = await broker.claimNextJob({
      leaseDurationMs: 600_000,
      leaseOwner: 'data-node-lease-session',
      now: new Date(nowSeconds * 1_000),
    });
    if (claim.status !== 'claimed') {
      throw new Error('Expected the lease-session job to be claimed');
    }
    const signed = await broker.issueCapability({
      jobId: claim.jobId,
      keyId: capabilityKeyId,
      leaseGeneration: claim.leaseGeneration,
      leaseOwner: 'data-node-lease-session',
      lifetimeSeconds: 300,
      now: new Date(nowSeconds * 1_000),
      privateKey: capabilityPrivateKey,
      proofKeyThumbprint: new Uint8Array(32).fill(0x55),
    });
    const capabilityPublicKey = await ed25519.getPublicKeyAsync(capabilityPrivateKey);
    await broker.consumeCapability({
      coseSign1: signed.coseSign1,
      expectedKeyId: capabilityKeyId,
      materializerId: 'data-node-lease-session',
      now: new Date((nowSeconds + 1) * 1_000),
      publicKey: capabilityPublicKey,
      proofJti: 'proof-lease-session-consume',
      traceId: 'trace-lease-session',
      verifiedProofKeyThumbprint: new Uint8Array(32).fill(0x55),
    });
    await broker.renewClaimLease({
      jobId: claim.jobId,
      leaseDurationMs: 600_000,
      leaseGeneration: claim.leaseGeneration,
      leaseOwner: 'data-node-lease-session',
      now: new Date((nowSeconds + 240) * 1_000),
    });
    const personalizedBytes = new Uint8Array([1, 2, 3, 4]);
    const archive = zipSync({
      'Assets/Product/a.png': personalizedBytes,
    });
    const outputSha256 = createHash('sha256').update(personalizedBytes).digest();

    const completed = await broker.completeRendition({
      attributionRecords: [
        {
          attributionId: 'attribution-lease-session',
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
      jobId: claim.jobId,
      leaseGeneration: claim.leaseGeneration,
      materializerId: 'data-node-lease-session',
      now: new Date((nowSeconds + 360) * 1_000),
      outputFiles: [
        {
          attributionId: 'attribution-lease-session',
          normalizedPath: 'Assets/Product/a.png',
          outputBytes: personalizedBytes.byteLength,
          outputSha256: outputSha256.toString('hex'),
        },
      ],
      outputTreeRoot: Buffer.from(
        computeOutputTreeRootV2([
          {
            attributionId: 'attribution-lease-session',
            normalizedPath: 'Assets/Product/a.png',
            outputBytes: personalizedBytes.byteLength,
            outputSha256,
          },
        ])
      ).toString('hex'),
      proofJti: 'proof-lease-session-complete',
      renditionBytes: archive.byteLength,
      renditionSha256: createHash('sha256').update(archive).digest('hex'),
      traceId: 'trace-lease-session',
      verifiedProofKeyThumbprint: new Uint8Array(32).fill(0x55),
    });

    expect(completed).toMatchObject({
      receiptId: expect.any(String),
      success: true,
    });
  }, 20_000);

  it('signs a v3 coupled receipt for a per-file completion and keeps retries idempotent', async () => {
    const broker = createBroker();
    await broker.createInstallJob({
      bindingRoot: new Uint8Array(32).fill(0x23),
      buyerId: 'buyer-coupled',
      creatorId: 'creator-1',
      grantJti: 'grant-coupled',
      id: 'job-coupled',
      keyEpoch: 7,
      materializationAlgorithm: 'png-dct-qim-v2',
      outputFormat: 'zip',
      pluginVersion: 'png-plugin-2',
      productId: 'com.yucp.materialization-test',
      protectedSourceRoot: new Uint8Array(32).fill(0x22),
      releaseRoot: new Uint8Array(32).fill(0x11),
      sourceLogicalBytes: 4_096,
      sourceLogicalFiles: 2,
      sourceManifestSha256: new Uint8Array(32).fill(0x88),
      sourceVersionId,
      traceId: 'trace-coupled',
    });
    const claim = await broker.claimNextJob({
      leaseDurationMs: 600_000,
      leaseOwner: 'data-node-coupled',
      now: new Date(nowSeconds * 1_000),
    });
    if (claim.status !== 'claimed') {
      throw new Error('Expected the coupled job to be claimed');
    }
    const signed = await broker.issueCapability({
      jobId: claim.jobId,
      keyId: capabilityKeyId,
      leaseGeneration: claim.leaseGeneration,
      leaseOwner: 'data-node-coupled',
      lifetimeSeconds: 300,
      now: new Date(nowSeconds * 1_000),
      privateKey: capabilityPrivateKey,
      proofKeyThumbprint: new Uint8Array(32).fill(0x66),
    });
    const capabilityPublicKey = await ed25519.getPublicKeyAsync(capabilityPrivateKey);
    await broker.consumeCapability({
      coseSign1: signed.coseSign1,
      expectedKeyId: capabilityKeyId,
      materializerId: 'data-node-coupled',
      now: new Date((nowSeconds + 1) * 1_000),
      publicKey: capabilityPublicKey,
      proofJti: 'proof-coupled-consume',
      traceId: 'trace-coupled',
      verifiedProofKeyThumbprint: new Uint8Array(32).fill(0x66),
    });
    const personalizedBytes = new TextEncoder().encode('coupled personalized bytes');
    const outputSha256 = createHash('sha256').update(personalizedBytes).digest();
    const outputTreeRoot = Buffer.from(
      computeOutputTreeRootV2([
        {
          attributionId: 'attribution-coupled',
          normalizedPath: 'Assets/Product/a.png',
          outputBytes: personalizedBytes.byteLength,
          outputSha256,
        },
      ])
    ).toString('hex');
    const coupledCompletion = {
      attributionRecords: [
        {
          attributionId: 'attribution-coupled',
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
      completionSchema: 'v3' as const,
      coseSign1: signed.coseSign1,
      coupledJobManifestKey: 'coupled-jobs/job-coupled.v1.json',
      jobId: 'job-coupled',
      leaseGeneration: claim.leaseGeneration,
      materializerId: 'data-node-coupled',
      now: new Date((nowSeconds + 3) * 1_000),
      outputFiles: [
        {
          attributionId: 'attribution-coupled',
          normalizedPath: 'Assets/Product/a.png',
          outputBytes: personalizedBytes.byteLength,
          outputSha256: outputSha256.toString('hex'),
        },
      ],
      outputTreeRoot,
      proofJti: 'proof-coupled-complete',
      traceId: 'trace-coupled',
      verifiedProofKeyThumbprint: new Uint8Array(32).fill(0x66),
    };

    let manifestKeyError: unknown;
    try {
      await broker.completeRendition({
        ...coupledCompletion,
        coupledJobManifestKey: 'coupled-jobs/another-job.v1.json',
      });
    } catch (error) {
      manifestKeyError = error;
    }
    expect(manifestKeyError).toBeInstanceOf(Error);
    expect((manifestKeyError as Error).message).toContain('Coupled completion request is invalid');

    const completed = await broker.completeRendition(coupledCompletion);
    expect(completed.success).toBeTrue();
    const receiptPublicKey = await ed25519.getPublicKeyAsync(receiptPrivateKey);
    const receipt = await verifyMaterializationReceiptV3({
      coseSign1: Buffer.from(completed.receipt, 'base64url'),
      expectedKeyId: receiptKeyId,
      publicKey: receiptPublicKey,
    });
    expect(receipt).not.toHaveProperty('rendition');
    expect(receipt.jobId).toBe('job-coupled');
    expect(receipt.grantId).toBe('grant-coupled');
    expect(receipt.capabilityId).toBe(signed.capability.capabilityId);
    expect(receipt.createdPaths).toEqual(['Assets/Product/a.png']);
    expect(Buffer.from(receipt.outputTreeRoot).toString('hex')).toBe(outputTreeRoot);

    const rows = await requireSql()<
      Array<{
        fileIdentifier: string | null;
        objectBytes: number | null;
        objectSha256: Buffer | null;
        outputTreeRoot: Buffer;
      }>
    >`
      SELECT
        file_identifier AS "fileIdentifier",
        object_bytes::float8 AS "objectBytes",
        object_sha256 AS "objectSha256",
        output_tree_root AS "outputTreeRoot"
      FROM materialization_receipts
      WHERE job_id = 'job-coupled'
    `;
    expect(rows[0]?.fileIdentifier).toBeNull();
    expect(rows[0]?.objectBytes).toBeNull();
    expect(rows[0]?.objectSha256).toBeNull();
    expect(Buffer.from(rows[0]?.outputTreeRoot ?? Buffer.alloc(0)).toString('hex')).toBe(
      outputTreeRoot
    );

    // A coupled (worker-lane) job derived its file keys with the v3
    // derivation; the candidate must say so or the attribution decoder
    // re-derives v2 keys and the buyer's mark never decodes again.
    const coupledCandidates = await broker.listAttributionCandidates({
      creatorId: 'creator-1',
      productId: 'com.yucp.materialization-test',
    });
    const coupledCandidate = coupledCandidates.candidates.find(
      (candidate) => candidate.jobId === 'job-coupled'
    );
    expect(coupledCandidate).toMatchObject({
      attributionId: 'attribution-coupled',
      keyDerivation: 'v3',
    });

    expect(
      await broker.completeRendition({
        ...coupledCompletion,
        now: new Date((nowSeconds + 5) * 1_000),
        proofJti: 'proof-coupled-retry',
      })
    ).toEqual(completed);

    let downgradeError: unknown;
    try {
      await broker.completeRendition({
        ...coupledCompletion,
        completionSchema: undefined,
        coupledJobManifestKey: undefined,
        now: new Date((nowSeconds + 6) * 1_000),
        proofJti: 'proof-coupled-downgrade',
        renditionBytes: 100,
        renditionSha256: '61'.repeat(32),
      });
    } catch (error) {
      downgradeError = error;
    }
    expect(downgradeError).toBeInstanceOf(Error);
    expect((downgradeError as Error).message).toContain('does not match this request');
  }, 20_000);

  it('hands each outbox entry to exactly one concurrent claimer', async () => {
    const broker = createBroker();
    const jobIds = Array.from({ length: 6 }, (_, index) => `job-claim-race-${index}`);
    for (const [index, id] of jobIds.entries()) {
      await broker.createInstallJob({
        bindingRoot: new Uint8Array(32).fill(0x23),
        buyerId: `buyer-claim-${index}`,
        creatorId: 'creator-1',
        grantJti: `grant-claim-${index}`,
        id,
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
        traceId: `trace-claim-${index}`,
      });
    }
    const repository = new PostgresMaterializationDispatchOutboxRepository(requireSql());
    const [first, second] = await Promise.all([repository.claim(10), repository.claim(10)]);
    const combined = [...first, ...second].map((entry) => entry.jobId);
    // No entry is double-claimed, and together the claimers drain the outbox.
    expect(new Set(combined).size).toBe(combined.length);
    expect([...combined].sort()).toEqual([...jobIds].sort());
    // A third claim finds nothing left.
    expect(await repository.claim(10)).toEqual([]);
  }, 20_000);

  it('emits only the strict worker-only dispatch contract', async () => {
    const broker = createBroker();
    const workerVersionId = randomUUID();
    await requireSql()`
      INSERT INTO package_versions (
        id, package_id, version, source_format, release_root, assembly_object_id,
        common_root, protected_source_root, binding_root, manifest_sha256,
        active_content_digest, active_policy_version, protection_policy_id,
        protection_policy_digest, logical_bytes, logical_files, protected_files, state
      )
      VALUES (
        ${workerVersionId}, 'com.yucp.materialization-test', '9.9.9-lane-test', 'zip',
        ${'71'.repeat(32)}, 'assemblies/worker-lane.logical-tree-manifest-v4.cbor',
        ${'73'.repeat(32)}, ${'72'.repeat(32)}, ${'74'.repeat(32)}, ${'78'.repeat(32)},
        ${'75'.repeat(32)}, 'active-content-v1', ${ACTIVE_PROTECTION_POLICY_ID},
        ${'55'.repeat(32)}, 4096, 2,
        ${requireSql().json([
          {
            couplingPlan: { peakDynamicBytes: 4_196_608, strategy: 'fbx-v1' },
            materializerType: 'fbx',
            normalizedPath: 'Assets/Product/w.fbx',
            required: true,
            sourceSha256: '42'.repeat(32),
          },
        ])},
        'READY'
      )
      ON CONFLICT (id) DO NOTHING
    `;
    const baseJob = {
      buyerId: 'buyer-lane',
      creatorId: 'creator-1',
      keyEpoch: 7,
      materializationAlgorithm: 'png-dct-qim-v2',
      outputFormat: 'zip' as const,
      pluginVersion: 'png-plugin-2',
      productId: 'com.yucp.materialization-test',
      sourceLogicalBytes: 4_096,
      sourceLogicalFiles: 2,
    };
    await broker.createInstallJob({
      ...baseJob,
      bindingRoot: new Uint8Array(32).fill(0x23),
      grantJti: 'grant-lane-default',
      id: 'job-lane-default',
      protectedSourceRoot: new Uint8Array(32).fill(0x22),
      releaseRoot: new Uint8Array(32).fill(0x11),
      sourceManifestSha256: new Uint8Array(32).fill(0x88),
      sourceVersionId,
      traceId: 'trace-lane-default',
    });
    await broker.createInstallJob({
      ...baseJob,
      bindingRoot: new Uint8Array(32).fill(0x74),
      grantJti: 'grant-lane-worker',
      id: 'job-lane-worker',
      protectedSourceRoot: new Uint8Array(32).fill(0x72),
      releaseRoot: new Uint8Array(32).fill(0x71),
      sourceManifestSha256: new Uint8Array(32).fill(0x78),
      sourceVersionId: workerVersionId,
      traceId: 'trace-lane-worker',
    });

    const repository = new PostgresMaterializationDispatchOutboxRepository(requireSql());
    try {
      const entries = await repository.claim(10);
      const byJob = new Map(entries.map((entry) => [entry.jobId, entry]));
      expect(byJob.get('job-lane-default')).toBeDefined();
      expect('couplingMode' in (byJob.get('job-lane-default') ?? {})).toBeFalse();
      expect('couplingMode' in (byJob.get('job-lane-worker') ?? {})).toBeFalse();
    } finally {
      await requireSql()`
        TRUNCATE TABLE
          materialization_attribution_records,
          materialization_capabilities,
          materialization_jobs
        CASCADE
      `;
      await requireSql()`
        DELETE FROM storage_gc_release_pins WHERE package_version_id = ${workerVersionId}
      `;
      await requireSql()`DELETE FROM package_versions WHERE id = ${workerVersionId}`;
    }
  }, 20_000);

  it('keeps a second large job queued while the fixed node lane is occupied', async () => {
    const broker = new MaterializationBroker({
      keyBroker,
      receiptSigning: {
        keyId: receiptKeyId,
        lifetimeSeconds: 7 * 24 * 60 * 60,
        privateKey: receiptPrivateKey,
      },
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

  it('isolates an unavailable expired source without blocking the next healthy job', async () => {
    const activeSql = requireSql();
    const broker = createBroker();
    const healthySourceVersionId = randomUUID();
    await activeSql`
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
      SELECT
        ${healthySourceVersionId},
        package_id,
        '1.0.1',
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
      FROM package_versions
      WHERE id = ${sourceVersionId}
    `;
    const base = {
      bindingRoot: new Uint8Array(32).fill(0x23),
      buyerId: 'buyer-queue-fence',
      creatorId: 'creator-queue-fence',
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
    };
    await broker.createInstallJob({
      ...base,
      grantJti: 'grant-unavailable-queue-fence',
      id: 'job-unavailable-queue-fence',
      sourceVersionId,
      traceId: 'trace-unavailable-queue-fence',
    });
    const firstClaim = await broker.claimNextJob({
      leaseDurationMs: 600_000,
      leaseOwner: 'data-node-unavailable-queue-fence',
      now: new Date(nowSeconds * 1_000),
    });
    if (firstClaim.status !== 'claimed') {
      throw new Error('Expected the unavailable queue-fence job to be claimed first');
    }
    await broker.createInstallJob({
      ...base,
      grantJti: 'grant-healthy-queue-fence',
      id: 'job-healthy-queue-fence',
      sourceVersionId: healthySourceVersionId,
      traceId: 'trace-healthy-queue-fence',
    });

    const objectId = randomUUID();
    const objectDigest = '73'.repeat(32);
    await activeSql`
      INSERT INTO storage_object_versions (
        id,
        storage_role,
        bucket_name,
        object_key,
        provider_version,
        file_identifier,
        sha256,
        bytes,
        content_type,
        verification_state,
        verified_at
      )
      VALUES (
        ${objectId},
        'protected',
        'protected-test',
        ${`v2/protected/chunks/${objectDigest}`},
        ${`provider-${objectId}`},
        ${`file-${objectId}`},
        decode(${objectDigest}, 'hex'),
        32,
        'application/octet-stream',
        'VERIFIED',
        clock_timestamp()
      )
    `;
    await activeSql`
      INSERT INTO package_release_storage_objects (
        package_version_id,
        logical_kind,
        logical_digest,
        object_version_id
      )
      VALUES (
        ${sourceVersionId},
        'chunk',
        decode(${objectDigest}, 'hex'),
        ${objectId}
      )
    `;
    const generations = await activeSql<{ id: number | string }[]>`
      INSERT INTO storage_gc_generations (
        state,
        started_at,
        completed_at
      )
      VALUES (
        'COMPLETED',
        to_timestamp(${nowSeconds + 598}),
        to_timestamp(${nowSeconds + 599})
      )
      RETURNING id
    `;
    const generationId = generations[0]?.id;
    if (generationId === undefined) {
      throw new Error('Expected one unavailable queue-fence GC generation');
    }
    await activeSql`
      INSERT INTO storage_gc_candidates (
        object_version_id,
        first_generation_id,
        last_generation_id,
        consecutive_generations,
        state,
        first_observed_at,
        last_observed_at
      )
      VALUES (
        ${objectId},
        ${generationId},
        ${generationId},
        2,
        'DELETING',
        to_timestamp(${nowSeconds + 598}),
        to_timestamp(${nowSeconds + 599})
      )
    `;
    await activeSql`
      UPDATE storage_gc_release_pins pin
      SET expires_at = to_timestamp(${nowSeconds + 599})
      FROM materialization_jobs job
      WHERE job.id = 'job-unavailable-queue-fence'
        AND job.storage_gc_pin_id = pin.id
    `;

    let claimError: unknown;
    let secondClaim: MaterializationClaimResult | undefined;
    try {
      secondClaim = await broker.claimNextJob({
        leaseDurationMs: 600_000,
        leaseOwner: 'data-node-healthy-queue-fence',
        now: new Date((nowSeconds + 601) * 1_000),
      });
    } catch (error) {
      claimError = error;
    }
    const jobStates = await activeSql<
      {
        id: string;
        lastErrorCode: string | null;
        leaseGeneration: number;
        leaseOwner: string | null;
        pinReleased: boolean;
        state: string;
        traceId: string;
      }[]
    >`
      SELECT
        job.id,
        job.last_error_code AS "lastErrorCode",
        job.lease_generation AS "leaseGeneration",
        job.lease_owner AS "leaseOwner",
        pin.released_at IS NOT NULL AS "pinReleased",
        job.state,
        job.trace_id AS "traceId"
      FROM materialization_jobs job
      JOIN storage_gc_release_pins pin ON pin.id = job.storage_gc_pin_id
      WHERE job.id IN ('job-unavailable-queue-fence', 'job-healthy-queue-fence')
      ORDER BY job.id
    `;
    const unavailableStatus = await broker.getJobStatus({
      grantJti: 'grant-unavailable-queue-fence',
      jobId: 'job-unavailable-queue-fence',
    });

    await activeSql`DELETE FROM storage_gc_candidates WHERE object_version_id = ${objectId}`;
    await activeSql`
      DELETE FROM package_release_storage_objects
      WHERE object_version_id = ${objectId}
    `;
    await activeSql`DELETE FROM storage_object_versions WHERE id = ${objectId}`;

    expect(claimError).toBeUndefined();
    expect(secondClaim).toMatchObject({
      jobId: 'job-healthy-queue-fence',
      leaseGeneration: 1,
      status: 'claimed',
    });
    expect(unavailableStatus).toEqual({
      errorCode: 'MATERIALIZATION_SOURCE_UNAVAILABLE',
      status: 'failed',
    });
    expect([...jobStates]).toEqual([
      {
        id: 'job-healthy-queue-fence',
        lastErrorCode: null,
        leaseGeneration: 1,
        leaseOwner: 'data-node-healthy-queue-fence',
        pinReleased: false,
        state: 'MATERIALIZING',
        traceId: 'trace-healthy-queue-fence',
      },
      {
        id: 'job-unavailable-queue-fence',
        lastErrorCode: 'MATERIALIZATION_SOURCE_UNAVAILABLE',
        leaseGeneration: 1,
        leaseOwner: null,
        pinReleased: true,
        state: 'FAILED',
        traceId: 'trace-unavailable-queue-fence',
      },
    ]);
  });

  it('does not revive an expired storage pin after its exact object starts deletion', async () => {
    const activeSql = requireSql();
    const broker = createBroker();
    const objectId = randomUUID();
    const objectDigest = '71'.repeat(32);
    await activeSql`
      INSERT INTO storage_object_versions (
        id,
        storage_role,
        bucket_name,
        object_key,
        provider_version,
        file_identifier,
        sha256,
        bytes,
        content_type,
        verification_state,
        verified_at
      )
      VALUES (
        ${objectId},
        'protected',
        'protected-test',
        ${`v2/protected/chunks/${objectDigest}`},
        ${`provider-${objectId}`},
        ${`file-${objectId}`},
        decode(${objectDigest}, 'hex'),
        32,
        'application/octet-stream',
        'VERIFIED',
        clock_timestamp()
      )
    `;
    await activeSql`
      INSERT INTO package_release_storage_objects (
        package_version_id,
        logical_kind,
        logical_digest,
        object_version_id
      )
      VALUES (
        ${sourceVersionId},
        'chunk',
        decode(${objectDigest}, 'hex'),
        ${objectId}
      )
    `;
    await broker.createInstallJob({
      bindingRoot: new Uint8Array(32).fill(0x23),
      buyerId: 'buyer-pin-fence',
      creatorId: 'creator-pin-fence',
      grantJti: 'grant-pin-fence',
      id: 'job-pin-fence',
      keyEpoch: 7,
      materializationAlgorithm: 'png-dct-qim-v2',
      outputFormat: 'zip',
      pluginVersion: 'png-plugin-2',
      productId: 'com.yucp.materialization-test',
      protectedSourceRoot: new Uint8Array(32).fill(0x22),
      releaseRoot: new Uint8Array(32).fill(0x11),
      sourceLogicalBytes: 4_096,
      sourceLogicalFiles: 2,
      sourceManifestSha256: new Uint8Array(32).fill(0x88),
      sourceVersionId,
      traceId: 'trace-pin-fence',
    });
    const claimed = await broker.claimNextJob({
      leaseDurationMs: 600_000,
      leaseOwner: 'data-node-pin-fence',
      now: new Date(nowSeconds * 1_000),
    });
    if (claimed.status !== 'claimed') {
      throw new Error('Expected the pin-fence materialization job to be claimed');
    }
    const generations = await activeSql<{ id: number | string }[]>`
      INSERT INTO storage_gc_generations (
        state,
        started_at,
        completed_at
      )
      VALUES (
        'COMPLETED',
        to_timestamp(${nowSeconds - 2}),
        to_timestamp(${nowSeconds - 1})
      )
      RETURNING id
    `;
    const generationId = generations[0]?.id;
    if (generationId === undefined) {
      throw new Error('Expected one pin-fence GC generation');
    }
    await activeSql`
      INSERT INTO storage_gc_candidates (
        object_version_id,
        first_generation_id,
        last_generation_id,
        consecutive_generations,
        state,
        first_observed_at,
        last_observed_at
      )
      VALUES (
        ${objectId},
        ${generationId},
        ${generationId},
        2,
        'DELETING',
        to_timestamp(${nowSeconds - 2}),
        to_timestamp(${nowSeconds - 1})
      )
    `;
    await activeSql`
      UPDATE storage_gc_release_pins pin
      SET expires_at = to_timestamp(${nowSeconds - 1})
      FROM materialization_jobs job
      WHERE job.id = 'job-pin-fence'
        AND job.storage_gc_pin_id = pin.id
    `;

    let renewalError: unknown;
    try {
      await broker.renewClaimLease({
        jobId: claimed.jobId,
        leaseDurationMs: 600_000,
        leaseGeneration: claimed.leaseGeneration,
        leaseOwner: 'data-node-pin-fence',
        now: new Date((nowSeconds + 1) * 1_000),
      });
    } catch (error) {
      renewalError = error;
    }
    const renewalFence = await activeSql<
      {
        leaseUnchanged: boolean;
        pinUnchanged: boolean;
      }[]
    >`
      SELECT
        job.lease_expires_at = to_timestamp(${nowSeconds + 600}) AS "leaseUnchanged",
        pin.expires_at = to_timestamp(${nowSeconds - 1}) AS "pinUnchanged"
      FROM materialization_jobs job
      JOIN storage_gc_release_pins pin ON pin.id = job.storage_gc_pin_id
      WHERE job.id = 'job-pin-fence'
    `;

    await activeSql`DELETE FROM storage_gc_candidates WHERE object_version_id = ${objectId}`;
    await activeSql`
      DELETE FROM package_release_storage_objects
      WHERE object_version_id = ${objectId}
    `;
    await activeSql`DELETE FROM storage_object_versions WHERE id = ${objectId}`;

    expect(renewalError).toBeInstanceOf(Error);
    expect((renewalError as Error).message).toContain(
      'cannot reference an object that is deleting or deleted'
    );
    expect([...renewalFence]).toEqual([{ leaseUnchanged: true, pinUnchanged: true }]);
  });

  it('isolates an expired job without reviving its unavailable source pin', async () => {
    const activeSql = requireSql();
    const broker = createBroker();
    const objectId = randomUUID();
    const objectDigest = '72'.repeat(32);
    await activeSql`
      INSERT INTO storage_object_versions (
        id,
        storage_role,
        bucket_name,
        object_key,
        provider_version,
        file_identifier,
        sha256,
        bytes,
        content_type,
        verification_state,
        verified_at
      )
      VALUES (
        ${objectId},
        'protected',
        'protected-test',
        ${`v2/protected/chunks/${objectDigest}`},
        ${`provider-${objectId}`},
        ${`file-${objectId}`},
        decode(${objectDigest}, 'hex'),
        32,
        'application/octet-stream',
        'VERIFIED',
        clock_timestamp()
      )
    `;
    await activeSql`
      INSERT INTO package_release_storage_objects (
        package_version_id,
        logical_kind,
        logical_digest,
        object_version_id
      )
      VALUES (
        ${sourceVersionId},
        'chunk',
        decode(${objectDigest}, 'hex'),
        ${objectId}
      )
    `;
    await broker.createInstallJob({
      bindingRoot: new Uint8Array(32).fill(0x23),
      buyerId: 'buyer-claim-pin-fence',
      creatorId: 'creator-claim-pin-fence',
      grantJti: 'grant-claim-pin-fence',
      id: 'job-claim-pin-fence',
      keyEpoch: 7,
      materializationAlgorithm: 'png-dct-qim-v2',
      outputFormat: 'zip',
      pluginVersion: 'png-plugin-2',
      productId: 'com.yucp.materialization-test',
      protectedSourceRoot: new Uint8Array(32).fill(0x22),
      releaseRoot: new Uint8Array(32).fill(0x11),
      sourceLogicalBytes: 4_096,
      sourceLogicalFiles: 2,
      sourceManifestSha256: new Uint8Array(32).fill(0x88),
      sourceVersionId,
      traceId: 'trace-claim-pin-fence',
    });
    const firstClaim = await broker.claimNextJob({
      leaseDurationMs: 600_000,
      leaseOwner: 'data-node-claim-pin-fence',
      now: new Date(nowSeconds * 1_000),
    });
    if (firstClaim.status !== 'claimed') {
      throw new Error('Expected the claim pin-fence job to be claimed');
    }
    const generations = await activeSql<{ id: number | string }[]>`
      INSERT INTO storage_gc_generations (
        state,
        started_at,
        completed_at
      )
      VALUES (
        'COMPLETED',
        to_timestamp(${nowSeconds + 598}),
        to_timestamp(${nowSeconds + 599})
      )
      RETURNING id
    `;
    const generationId = generations[0]?.id;
    if (generationId === undefined) {
      throw new Error('Expected one claim pin-fence GC generation');
    }
    await activeSql`
      INSERT INTO storage_gc_candidates (
        object_version_id,
        first_generation_id,
        last_generation_id,
        consecutive_generations,
        state,
        first_observed_at,
        last_observed_at
      )
      VALUES (
        ${objectId},
        ${generationId},
        ${generationId},
        2,
        'DELETING',
        to_timestamp(${nowSeconds + 598}),
        to_timestamp(${nowSeconds + 599})
      )
    `;
    await activeSql`
      UPDATE storage_gc_release_pins pin
      SET expires_at = to_timestamp(${nowSeconds + 599})
      FROM materialization_jobs job
      WHERE job.id = 'job-claim-pin-fence'
        AND job.storage_gc_pin_id = pin.id
    `;

    const reclaimResult = await broker.claimNextJob({
      leaseDurationMs: 600_000,
      leaseOwner: 'data-node-reclaim-pin-fence',
      now: new Date((nowSeconds + 601) * 1_000),
    });
    const claimFence = await activeSql<
      {
        lastErrorCode: string | null;
        leaseGeneration: number;
        leaseOwner: string | null;
        leaseReleased: boolean;
        pinReleased: boolean;
        state: string;
      }[]
    >`
      SELECT
        job.last_error_code AS "lastErrorCode",
        job.lease_generation AS "leaseGeneration",
        job.lease_owner AS "leaseOwner",
        job.lease_expires_at IS NULL AS "leaseReleased",
        pin.released_at IS NOT NULL AS "pinReleased",
        job.state
      FROM materialization_jobs job
      JOIN storage_gc_release_pins pin ON pin.id = job.storage_gc_pin_id
      WHERE job.id = 'job-claim-pin-fence'
    `;

    await activeSql`DELETE FROM storage_gc_candidates WHERE object_version_id = ${objectId}`;
    await activeSql`
      DELETE FROM package_release_storage_objects
      WHERE object_version_id = ${objectId}
    `;
    await activeSql`DELETE FROM storage_object_versions WHERE id = ${objectId}`;

    expect(reclaimResult).toEqual({ status: 'idle' });
    expect([...claimFence]).toEqual([
      {
        lastErrorCode: 'MATERIALIZATION_SOURCE_UNAVAILABLE',
        leaseGeneration: 1,
        leaseOwner: null,
        leaseReleased: true,
        pinReleased: true,
        state: 'FAILED',
      },
    ]);
  });
});
