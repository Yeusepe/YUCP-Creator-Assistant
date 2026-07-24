import { describe, expect, test } from 'bun:test';
import {
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import * as ed25519 from '@noble/ed25519';
import { unzipSync, zipSync } from 'fflate';
import { startDisposableStorageHarness } from '../testing/disposableStorageHarness';
import {
  computeOutputTreeRootV2,
  decodeCanonicalPackageCbor,
  encodeCanonicalPackageCbor,
  encodeMaterializationReceiptV2,
  hashPackageContractFields,
  type MaterializationReceiptV2,
  type MaterializedFileV2,
  PACKAGE_CONTRACT_PURPOSES,
  packageContractKeyId,
  signPackageContract,
  verifyMaterializationReceiptV2,
} from './packageContractsV2';
import { getS3ObjectVersion, putS3ObjectVersioned } from './s3Control';

const PYTHON_IMAGE =
  'python@sha256:ac76900038d8606cc99b413d4ede77bc7152f1e42b94cf5d50d4b80a999652fe';
const PNG_SIZE = 256;
const KEY_EPOCH = 1;
const MATERIALIZATION_ALGORITHM = 'png-dct-qim-v2';
const PLUGIN_VERSION = 'png-plugin-2';
const PSEUDONYM_METHOD = 'hmac-sha256-v1';
const OUTPUT_PATHS = [
  'Assets/Product/Protected/albedo.png',
  'Assets/Product/Protected/detail.png',
] as const;

type CodecFileResult = {
  decodedTokenHex: string;
  normalizedPath: string;
  outputBytes: number;
  outputSha256: string;
};

type CodecResult = {
  credentialEnvironment: string[];
  files: CodecFileResult[];
  outputTreeRoot: string;
  schemaVersion: number;
};

type DerivedBuyerMaterial = {
  fileKeys: Map<string, Buffer>;
  pseudonym: string;
  tokenByPath: Map<string, string>;
};

type AttributionRecord = {
  attributionId: string;
  buyerSubjectPseudonym: string;
  normalizedPath: string;
};

function sha256(bytes: Uint8Array): Buffer {
  return createHash('sha256').update(bytes).digest();
}

function uint64Bytes(value: number): Buffer {
  const bytes = Buffer.allocUnsafe(8);
  bytes.writeBigUInt64BE(BigInt(value));
  return bytes;
}

function crc32(bytes: Buffer): number {
  let crc = ~0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return ~crc >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  const checksum = Buffer.alloc(4);
  length.writeUInt32BE(data.byteLength);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, checksum]);
}

function makeGrayPng(size: number, gray: number): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  const row = Buffer.alloc(1 + size * 4);
  for (let pixel = 0; pixel < size; pixel += 1) {
    row[1 + pixel * 4] = gray;
    row[2 + pixel * 4] = gray;
    row[3 + pixel * 4] = gray;
    row[4 + pixel * 4] = 255;
  }
  return Buffer.concat([
    signature,
    pngChunk('IHDR', header),
    pngChunk(
      'IDAT',
      deflateSync(Buffer.concat(Array.from({ length: size }, () => Buffer.from(row))))
    ),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function cborInfo(entries: Array<[number, string | number | Uint8Array]>): Uint8Array {
  return encodeCanonicalPackageCbor(new Map(entries));
}

function deriveBuyerMaterial(input: {
  buyerSubject: string;
  creatorDomain: string;
  masterEpochKey: Buffer;
  protectedSourceRoot: Uint8Array;
  releaseRoot: Uint8Array;
  sourceDigestByPath: Map<string, Buffer>;
}): DerivedBuyerMaterial {
  const pseudonym = createHmac('sha256', input.masterEpochKey)
    .update('yucp:buyer-pseudonym:v1', 'ascii')
    .update(Buffer.from(input.buyerSubject, 'utf8'))
    .digest('hex');
  const salt = hashPackageContractFields('yucp:materialization-salt:v2', [
    input.releaseRoot,
    input.protectedSourceRoot,
  ]);
  const subjectReleaseSeed = Buffer.from(
    hkdfSync(
      'sha256',
      input.masterEpochKey,
      salt,
      cborInfo([
        [0, 'yucp:protected-materialization:v2'],
        [1, input.creatorDomain],
        [2, KEY_EPOCH],
        [3, input.releaseRoot],
        [4, input.protectedSourceRoot],
        [5, pseudonym],
        [6, MATERIALIZATION_ALGORITHM],
        [7, PLUGIN_VERSION],
        [8, 'zip'],
      ]),
      32
    )
  );
  const fileKeys = new Map<string, Buffer>();
  const tokenByPath = new Map<string, string>();
  for (const normalizedPath of OUTPUT_PATHS) {
    const sourceDigest = input.sourceDigestByPath.get(normalizedPath);
    if (!sourceDigest) {
      throw new Error('Protected source digest is missing');
    }
    const fileKey = Buffer.from(
      hkdfSync(
        'sha256',
        subjectReleaseSeed,
        sourceDigest,
        cborInfo([
          [0, 'yucp:protected-file:v2'],
          [1, normalizedPath],
        ]),
        32
      )
    );
    fileKeys.set(normalizedPath, fileKey);
    tokenByPath.set(
      normalizedPath,
      createHmac('sha256', fileKey)
        .update('yucp:attribution-token:v2', 'ascii')
        .digest('hex')
        .slice(0, 16)
    );
  }
  subjectReleaseSeed.fill(0);
  return { fileKeys, pseudonym, tokenByPath };
}

async function requireLinuxRuntime(): Promise<{ path: string; sha256: string }> {
  const workspaceRoot = path.resolve(import.meta.dir, '..', '..');
  const candidates = [
    process.env.YUCP_COUPLING_LINUX_RUNTIME_PATH?.trim(),
    path.join(
      workspaceRoot,
      'Verify',
      'Native',
      'yucp_coupling',
      'out',
      'linux-x64',
      'Release',
      'yucp_coupling.so'
    ),
    path.resolve(
      workspaceRoot,
      '..',
      'ca-coupling',
      'yucp_coupling',
      'out',
      'linux-x64',
      'Release',
      'yucp_coupling.so'
    ),
  ].filter((candidate): candidate is string => Boolean(candidate));
  const runtimePath = candidates.find(existsSync);
  if (!runtimePath) {
    throw new Error(
      'Linux coupling runtime is missing. Build ca-coupling/yucp_coupling/build.sh first.'
    );
  }
  const digestPath = path.join(path.dirname(runtimePath), 'yucp_coupling.sha256');
  const [runtimeBytes, expectedSha256] = await Promise.all([
    readFile(runtimePath),
    readFile(digestPath, 'utf8'),
  ]);
  const actualSha256 = sha256(runtimeBytes).toString('hex');
  if (actualSha256 !== expectedSha256.trim().toLowerCase()) {
    throw new Error('Linux coupling runtime does not match its checked digest');
  }
  return { path: runtimePath, sha256: actualSha256 };
}

async function runCodec(input: {
  files: Array<{
    normalizedPath: string;
    seedHex: string;
    sourcePath: string;
    tokenHex: string;
  }>;
  inputDirectory: string;
  outputDirectory: string;
  runtimePath: string;
}): Promise<CodecResult> {
  const workerPath = path.join(import.meta.dir, 'linuxCodecWorker.py');
  const child = Bun.spawn(
    [
      'docker',
      'run',
      '--rm',
      '--interactive',
      '--network',
      'none',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--pids-limit',
      '32',
      '--memory',
      '256m',
      '--cpus',
      '1',
      '--ulimit',
      'core=0',
      '--tmpfs',
      '/tmp:rw,noexec,nosuid,nodev,size=16m',
      '--mount',
      `type=bind,source=${input.inputDirectory},target=/input,readonly`,
      '--mount',
      `type=bind,source=${input.outputDirectory},target=/output`,
      '--mount',
      `type=bind,source=${input.runtimePath},target=/opt/yucp/yucp_coupling.so,readonly`,
      '--mount',
      `type=bind,source=${workerPath},target=/opt/yucp/worker.py,readonly`,
      PYTHON_IMAGE,
      'python',
      '/opt/yucp/worker.py',
    ],
    {
      stderr: 'pipe',
      stdin: 'pipe',
      stdout: 'pipe',
    }
  );
  child.stdin.write(JSON.stringify({ files: input.files }));
  child.stdin.end();
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`Linux codec failed with exit ${exitCode}: ${stderr.trim() || 'no detail'}`);
  }
  const result = JSON.parse(stdout) as CodecResult;
  if (
    result.schemaVersion !== 1 ||
    result.credentialEnvironment.length !== 0 ||
    result.files.length !== input.files.length ||
    !/^[0-9a-f]{64}$/.test(result.outputTreeRoot)
  ) {
    throw new Error('Linux codec returned an invalid result contract');
  }
  return result;
}

function verifyRendition(input: {
  bytes: Uint8Array;
  expectedFiles: MaterializedFileV2[];
  expectedSha256: Uint8Array;
}): void {
  const actualSha256 = sha256(input.bytes);
  if (
    actualSha256.byteLength !== input.expectedSha256.byteLength ||
    !timingSafeEqual(actualSha256, input.expectedSha256)
  ) {
    throw new Error('Trusted rendition readback digest did not match');
  }
  const entries = unzipSync(input.bytes);
  const expectedPaths = input.expectedFiles.map((file) => file.normalizedPath);
  const actualPaths = Object.keys(entries).sort((left, right) =>
    Buffer.compare(Buffer.from(left), Buffer.from(right))
  );
  if (
    actualPaths.length !== expectedPaths.length ||
    actualPaths.some((entry, index) => entry !== expectedPaths[index])
  ) {
    throw new Error('Trusted rendition readback entries did not match');
  }
  for (const expected of input.expectedFiles) {
    const entry = entries[expected.normalizedPath];
    if (
      !entry ||
      entry.byteLength !== expected.outputBytes ||
      !timingSafeEqual(sha256(entry), expected.outputSha256)
    ) {
      throw new Error('Trusted rendition readback file did not match');
    }
  }
}

async function writeEvidence(value: object): Promise<void> {
  const evidenceDirectory = process.env.YUCP_PACKAGE_EVIDENCE_DIR?.trim();
  if (!evidenceDirectory) {
    return;
  }
  await mkdir(evidenceDirectory, { recursive: true });
  const destination = path.join(evidenceDirectory, 'linux-materialization.json');
  const temporary = `${destination}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, destination);
}

describe('Linux protected materialization P0 proof', () => {
  test('isolates the codec and signs only an exact verified rendition version', async () => {
    const harness = await startDisposableStorageHarness();
    const scratch = await mkdtemp(path.join(tmpdir(), 'yucp-linux-materialization-'));
    const masterEpochKey = randomBytes(32);
    let completionMessage: string | undefined;
    try {
      const runtime = await requireLinuxRuntime();
      const inputDirectory = path.join(scratch, 'input');
      const buyerOneOutput = path.join(scratch, 'buyer-one');
      const buyerTwoOutput = path.join(scratch, 'buyer-two');
      await Promise.all([mkdir(inputDirectory), mkdir(buyerOneOutput), mkdir(buyerTwoOutput)]);
      const sourceBytes = makeGrayPng(PNG_SIZE, 0x80);
      await Promise.all([
        writeFile(path.join(inputDirectory, 'albedo.png'), sourceBytes),
        writeFile(path.join(inputDirectory, 'detail.png'), sourceBytes),
      ]);
      const sourceDigestByPath = new Map(
        OUTPUT_PATHS.map((normalizedPath) => [normalizedPath, sha256(sourceBytes)])
      );
      const protectedSourceRoot = hashPackageContractFields(
        'yucp:protected-source-tree:v2',
        OUTPUT_PATHS.flatMap((normalizedPath) => [
          Buffer.from(normalizedPath),
          sourceDigestByPath.get(normalizedPath) as Buffer,
          uint64Bytes(sourceBytes.byteLength),
        ])
      );
      const releaseRoot = hashPackageContractFields('yucp:release-root:v2', [protectedSourceRoot]);
      const buyerOne = deriveBuyerMaterial({
        buyerSubject: 'buyer-test-subject-1',
        creatorDomain: 'creator-1',
        masterEpochKey,
        protectedSourceRoot,
        releaseRoot,
        sourceDigestByPath,
      });
      const buyerTwo = deriveBuyerMaterial({
        buyerSubject: 'buyer-test-subject-2',
        creatorDomain: 'creator-1',
        masterEpochKey,
        protectedSourceRoot,
        releaseRoot,
        sourceDigestByPath,
      });
      expect(buyerOne.pseudonym).not.toBe(buyerTwo.pseudonym);
      expect(
        buyerOne.fileKeys
          .get(OUTPUT_PATHS[0])
          ?.equals(buyerOne.fileKeys.get(OUTPUT_PATHS[1]) as Buffer)
      ).toBe(false);

      const codecFiles = (
        material: DerivedBuyerMaterial
      ): Array<{
        normalizedPath: string;
        seedHex: string;
        sourcePath: string;
        tokenHex: string;
      }> =>
        OUTPUT_PATHS.map((normalizedPath, index) => ({
          normalizedPath,
          seedHex: (material.fileKeys.get(normalizedPath) as Buffer).toString('hex'),
          sourcePath: index === 0 ? 'albedo.png' : 'detail.png',
          tokenHex: material.tokenByPath.get(normalizedPath) as string,
        }));
      const [buyerOneCodec, buyerTwoCodec] = await Promise.all([
        runCodec({
          files: codecFiles(buyerOne),
          inputDirectory,
          outputDirectory: buyerOneOutput,
          runtimePath: runtime.path,
        }),
        runCodec({
          files: codecFiles(buyerTwo),
          inputDirectory,
          outputDirectory: buyerTwoOutput,
          runtimePath: runtime.path,
        }),
      ]);
      expect(buyerOneCodec.outputTreeRoot).not.toBe(buyerTwoCodec.outputTreeRoot);
      for (const normalizedPath of OUTPUT_PATHS) {
        const buyerOneFile = await readFile(path.join(buyerOneOutput, normalizedPath));
        const buyerTwoFile = await readFile(path.join(buyerTwoOutput, normalizedPath));
        expect(buyerOneFile.equals(buyerTwoFile)).toBe(false);
      }

      const attributionRecords = new Map<string, AttributionRecord>();
      const outputFiles: MaterializedFileV2[] = buyerOneCodec.files.map((file) => {
        const attributionId = Buffer.from(
          hashPackageContractFields('yucp:attribution-id:v2', [
            Buffer.from(file.decodedTokenHex, 'hex'),
          ])
        ).toString('hex');
        attributionRecords.set(file.decodedTokenHex, {
          attributionId,
          buyerSubjectPseudonym: buyerOne.pseudonym,
          normalizedPath: file.normalizedPath,
        });
        return {
          attributionId,
          normalizedPath: file.normalizedPath,
          outputBytes: file.outputBytes,
          outputSha256: Buffer.from(file.outputSha256, 'hex'),
        };
      });
      const lookupAttribution = (
        extractedTokenHex: string,
        authorized: boolean
      ): AttributionRecord => {
        if (!authorized) {
          throw new Error('Attribution lookup is not authorized');
        }
        const record = attributionRecords.get(extractedTokenHex);
        if (!record) {
          throw new Error('Attribution record was not found');
        }
        return record;
      };
      expect(() => lookupAttribution(buyerOneCodec.files[0]?.decodedTokenHex ?? '', false)).toThrow(
        'not authorized'
      );
      for (const file of buyerOneCodec.files) {
        expect(lookupAttribution(file.decodedTokenHex, true)).toMatchObject({
          buyerSubjectPseudonym: buyerOne.pseudonym,
          normalizedPath: file.normalizedPath,
        });
      }

      expect(Buffer.from(computeOutputTreeRootV2(outputFiles)).toString('hex')).toBe(
        buyerOneCodec.outputTreeRoot
      );
      const renditionEntries = Object.fromEntries(
        await Promise.all(
          outputFiles.map(async (file) => [
            file.normalizedPath,
            [
              await readFile(path.join(buyerOneOutput, file.normalizedPath)),
              { level: 0, mtime: new Date('1980-01-01T00:00:00.000Z') },
            ],
          ])
        )
      );
      const renditionBytes = zipSync(renditionEntries);
      const renditionSha256 = sha256(renditionBytes);
      const renditionKey = `personalized/${Buffer.from(releaseRoot).toString('hex')}/${buyerOne.pseudonym}.zip`;
      const exactVersion = await putS3ObjectVersioned({
        body: renditionBytes,
        config: harness.buckets.renditions,
        contentType: 'application/zip',
        key: renditionKey,
      });
      const substitutedBytes = zipSync({
        'Assets/Product/Protected/substituted.txt': Buffer.from('substituted'),
      });
      const substitutedVersion = await putS3ObjectVersioned({
        body: substitutedBytes,
        config: harness.buckets.renditions,
        contentType: 'application/zip',
        key: renditionKey,
      });
      expect(substitutedVersion.versionId).not.toBe(exactVersion.versionId);
      expect(() =>
        verifyRendition({
          bytes: substitutedBytes,
          expectedFiles: outputFiles,
          expectedSha256: renditionSha256,
        })
      ).toThrow('digest did not match');

      const exactRead = await getS3ObjectVersion(
        harness.buckets.renditions,
        renditionKey,
        exactVersion.versionId
      );
      const verifiedRenditionBytes = new Uint8Array(await exactRead.arrayBuffer());
      verifyRendition({
        bytes: verifiedRenditionBytes,
        expectedFiles: outputFiles,
        expectedSha256: renditionSha256,
      });

      const receiptPrivateKey = randomBytes(32);
      const receiptPublicKey = await ed25519.getPublicKeyAsync(receiptPrivateKey);
      const receiptKeyId = packageContractKeyId('p0-materialization-receipt-root-1');
      const issuedAt = Math.floor(Date.now() / 1_000);
      const receipt: MaterializationReceiptV2 = {
        buyerSubjectPseudonym: buyerOne.pseudonym,
        capabilityId: 'capability-p0-1',
        codecBuild: `sha256:${sha256(await readFile(path.join(import.meta.dir, 'linuxCodecWorker.py'))).toString('hex')}`,
        createdPaths: outputFiles.map((file) => file.normalizedPath),
        creatorId: 'creator-1',
        expiresAt: issuedAt + 7 * 24 * 60 * 60,
        grantId: 'grant-p0-1',
        helperBuild: 'yucp-transfer-helper-p0-source-1',
        issuedAt,
        jobId: 'job-p0-1',
        keyEpoch: KEY_EPOCH,
        leaseGeneration: 1,
        materializationAlgorithm: MATERIALIZATION_ALGORITHM,
        materializerId: 'linux-materializer-p0-1',
        outputFiles,
        outputTreeRoot: Buffer.from(buyerOneCodec.outputTreeRoot, 'hex'),
        pluginVersion: PLUGIN_VERSION,
        productId: 'product-1',
        protectedSourceRoot,
        pseudonymMethod: PSEUDONYM_METHOD,
        receiptId: randomUUID(),
        releaseRoot,
        rendition: {
          bucketName: harness.buckets.renditions.bucket,
          fileIdentifier: exactVersion.fileIdentifier,
          objectBytes: renditionBytes.byteLength,
          objectKey: renditionKey,
          objectSha256: renditionSha256,
          providerVersion: `minio:${exactVersion.versionId}`,
          storageRole: 'renditions',
        },
        runtimeBuild: `sha256:${runtime.sha256}`,
        traceId: randomUUID(),
      };
      const signedReceipt = await signPackageContract({
        keyId: receiptKeyId,
        payload: encodeMaterializationReceiptV2(receipt),
        privateKey: receiptPrivateKey,
        purpose: PACKAGE_CONTRACT_PURPOSES.materializationReceipt,
      });
      const verifiedReceipt = await verifyMaterializationReceiptV2({
        coseSign1: signedReceipt.coseSign1,
        expectedKeyId: receiptKeyId,
        publicKey: receiptPublicKey,
      });
      expect(verifiedReceipt.rendition.providerVersion).toBe(`minio:${exactVersion.versionId}`);

      const envelope = decodeCanonicalPackageCbor(signedReceipt.coseSign1);
      if (!Array.isArray(envelope) || envelope.length !== 4) {
        throw new Error('Signed receipt envelope is invalid');
      }
      const tamperedPayload = encodeMaterializationReceiptV2({
        ...receipt,
        rendition: {
          ...receipt.rendition,
          providerVersion: `minio:${substitutedVersion.versionId}`,
        },
      });
      const tamperedEnvelope = encodeCanonicalPackageCbor([
        envelope[0],
        envelope[1],
        tamperedPayload,
        envelope[3],
      ]);
      await expect(
        verifyMaterializationReceiptV2({
          coseSign1: tamperedEnvelope,
          expectedKeyId: receiptKeyId,
          publicKey: receiptPublicKey,
        })
      ).rejects.toThrow('signature is invalid');

      await writeEvidence({
        attributionLookup: 'pass',
        buyerOutputsDiffer: true,
        codecCredentialEnvironment: buyerOneCodec.credentialEnvironment,
        exactReadback: 'pass',
        exactVersionBound: true,
        fileCount: outputFiles.length,
        linuxRuntimeSha256: runtime.sha256,
        masterOutsideCodec: true,
        perFileSubkeysDiffer: true,
        receiptSignature: 'pass',
        receiptTamperRejected: true,
        renditionBytes: renditionBytes.byteLength,
        renditionSha256: renditionSha256.toString('hex'),
        schemaVersion: 1,
      });
      completionMessage = `P0_08_LINUX_MATERIALIZATION_RESULT buyers=2 files=${outputFiles.length} master-outside-codec=true per-file-subkeys=true exact-readback=true receipt-signature=true attribution-lookup=true`;
    } finally {
      masterEpochKey.fill(0);
      try {
        await harness.stop();
      } finally {
        await rm(scratch, { force: true, recursive: true });
      }
    }
    console.log(`${completionMessage} cleanup=complete`);
  }, 300_000);
});
