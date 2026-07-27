import { readFile } from 'node:fs/promises';
import {
  extractVpmBootstrapMetadataFromDocuments,
  isVpmBootstrapMetadataPath,
  MAX_VPM_BOOTSTRAP_DOCUMENTS,
  MAX_VPM_BOOTSTRAP_MANIFEST_BYTES,
  type VpmBootstrapMetadata,
} from './vpmBootstrapMetadata';

export type VpmBootstrapMetadataFile = {
  bytes: number;
  normalizedPath: string;
  path: string;
};

export async function extractVpmBootstrapMetadataFromFiles(
  files: readonly VpmBootstrapMetadataFile[]
): Promise<VpmBootstrapMetadata> {
  const candidates = files.filter((file) => isVpmBootstrapMetadataPath(file.normalizedPath));
  if (candidates.length > MAX_VPM_BOOTSTRAP_DOCUMENTS) {
    throw new Error(`Package bootstrap metadata exceeds ${MAX_VPM_BOOTSTRAP_DOCUMENTS} documents`);
  }
  const documents = await Promise.all(
    candidates.map(async (file) => {
      if (
        !Number.isSafeInteger(file.bytes) ||
        file.bytes < 0 ||
        file.bytes > MAX_VPM_BOOTSTRAP_MANIFEST_BYTES
      ) {
        throw new Error(`VPM metadata document is too large: ${file.normalizedPath}`);
      }
      const bytes = await readFile(file.path);
      if (bytes.byteLength !== file.bytes) {
        throw new Error(`VPM metadata document changed during ingest: ${file.normalizedPath}`);
      }
      return {
        body: new TextDecoder('utf-8', {
          fatal: true,
          ignoreBOM: false,
        }).decode(bytes),
        normalizedPath: file.normalizedPath,
      };
    })
  );
  return extractVpmBootstrapMetadataFromDocuments(documents);
}
