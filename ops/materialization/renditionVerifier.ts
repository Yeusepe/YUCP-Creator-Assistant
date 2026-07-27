import { createHash } from 'node:crypto';
import { Unzip, type UnzipFile, UnzipInflate } from 'fflate';
import {
  computeOutputTreeRootV2,
  type MaterializedFileV2,
} from '../storage-core/packageContractsV2';

const MAX_ARCHIVE_ENTRIES = 100_000;
const MAX_DECOMPRESSED_BYTES = 64 * 1024 ** 3;
const HEX_SHA256 = /^[0-9a-f]{64}$/;

export type DeclaredMaterializedFile = {
  attributionId: string;
  normalizedPath: string;
  outputBytes: number;
  outputSha256: string;
};

export type VerifiedRenditionReadback = {
  objectBytes: number;
  objectSha256: string;
  outputTreeRoot: string;
};

function requireSafeArchivePath(rawName: string): string {
  if (
    !rawName ||
    rawName !== rawName.normalize('NFC') ||
    rawName.includes('\\') ||
    rawName.startsWith('/') ||
    /^[a-zA-Z]:/.test(rawName)
  ) {
    throw new Error('Rendition archive contains an unsafe path');
  }
  const withoutDirectorySuffix = rawName.endsWith('/') ? rawName.slice(0, -1) : rawName;
  if (
    !withoutDirectorySuffix ||
    withoutDirectorySuffix
      .split('/')
      .some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error('Rendition archive contains an unsafe path');
  }
  return rawName;
}

function expectedFileMap(
  files: readonly DeclaredMaterializedFile[]
): Map<string, DeclaredMaterializedFile> {
  const expected = new Map<string, DeclaredMaterializedFile>();
  for (const file of files) {
    requireSafeArchivePath(file.normalizedPath);
    if (
      !HEX_SHA256.test(file.outputSha256) ||
      !Number.isSafeInteger(file.outputBytes) ||
      file.outputBytes < 0 ||
      !file.attributionId.trim() ||
      file.attributionId.length > 512
    ) {
      throw new Error('Declared rendition output is invalid');
    }
    if (expected.has(file.normalizedPath)) {
      throw new Error('Declared rendition outputs contain a duplicate path');
    }
    expected.set(file.normalizedPath, file);
  }
  return expected;
}

export async function verifyRenditionReadback(input: {
  expectedBytes: number;
  expectedObjectSha256: string;
  expectedOutputFiles: readonly DeclaredMaterializedFile[];
  response: Response;
}): Promise<VerifiedRenditionReadback> {
  if (
    !input.response.ok ||
    !input.response.body ||
    !Number.isSafeInteger(input.expectedBytes) ||
    input.expectedBytes < 1 ||
    !HEX_SHA256.test(input.expectedObjectSha256)
  ) {
    throw new Error('Exact rendition readback response is invalid');
  }
  const expected = expectedFileMap(input.expectedOutputFiles);
  const verified = new Map<string, MaterializedFileV2>();
  const archiveNames = new Set<string>();
  const caseFoldedNames = new Set<string>();
  const objectDigest = createHash('sha256');
  let objectBytes = 0;
  let decompressedBytes = 0;
  let entryCount = 0;
  let extractionError: Error | undefined;

  const unzip = new Unzip((file: UnzipFile) => {
    if (extractionError) {
      file.terminate();
      return;
    }
    try {
      entryCount += 1;
      if (entryCount > MAX_ARCHIVE_ENTRIES) {
        throw new Error('Rendition archive entry count exceeds its limit');
      }
      const normalizedPath = requireSafeArchivePath(file.name);
      const caseFolded = normalizedPath.toLocaleLowerCase('en-US');
      if (archiveNames.has(normalizedPath) || caseFoldedNames.has(caseFolded)) {
        throw new Error('Rendition archive contains a duplicate path');
      }
      archiveNames.add(normalizedPath);
      caseFoldedNames.add(caseFolded);
      const declared = expected.get(normalizedPath);
      const entryDigest = declared ? createHash('sha256') : undefined;
      let entryBytes = 0;
      file.ondata = (error, data, final) => {
        if (extractionError) {
          return;
        }
        if (error) {
          extractionError = error;
          return;
        }
        decompressedBytes += data.byteLength;
        entryBytes += data.byteLength;
        if (decompressedBytes > MAX_DECOMPRESSED_BYTES) {
          extractionError = new Error('Rendition archive decompressed bytes exceed their limit');
          file.terminate();
          return;
        }
        entryDigest?.update(data);
        if (final && declared && entryDigest) {
          const digest = entryDigest.digest('hex');
          if (entryBytes !== declared.outputBytes || digest !== declared.outputSha256) {
            extractionError = new Error('Rendition output failed exact readback verification');
            return;
          }
          verified.set(normalizedPath, {
            attributionId: declared.attributionId,
            normalizedPath,
            outputBytes: entryBytes,
            outputSha256: Buffer.from(digest, 'hex'),
          });
        }
      };
      file.start();
    } catch (error) {
      extractionError = error instanceof Error ? error : new Error(String(error));
      file.terminate();
    }
  });
  unzip.register(UnzipInflate);

  const reader = input.response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }
      objectBytes += value.byteLength;
      if (objectBytes > input.expectedBytes) {
        throw new Error('Rendition object length exceeds its declared value');
      }
      objectDigest.update(value);
      unzip.push(value, false);
      if (extractionError) {
        throw extractionError;
      }
    }
    unzip.push(new Uint8Array(), true);
    if (extractionError) {
      throw extractionError;
    }
  } finally {
    reader.releaseLock();
  }

  const objectSha256 = objectDigest.digest('hex');
  if (objectBytes !== input.expectedBytes || objectSha256 !== input.expectedObjectSha256) {
    throw new Error('Rendition object failed exact readback verification');
  }
  if (verified.size !== expected.size) {
    throw new Error('Rendition archive does not contain every declared output');
  }
  const outputFiles = input.expectedOutputFiles.map((file) => {
    const verifiedFile = verified.get(file.normalizedPath);
    if (!verifiedFile) {
      throw new Error('Rendition archive does not contain every declared output');
    }
    return verifiedFile;
  });
  return {
    objectBytes,
    objectSha256,
    outputTreeRoot: Buffer.from(computeOutputTreeRootV2(outputFiles)).toString('hex'),
  };
}
