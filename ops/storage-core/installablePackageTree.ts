import { readFile } from 'node:fs/promises';
import type { VpmBootstrapMetadata } from './vpmBootstrapMetadata';
import {
  extractVpmBootstrapMetadataFromFiles,
  type VpmBootstrapMetadataFile,
} from './vpmBootstrapMetadataNode';

export const PACKAGE_NORMALIZATION_POLICY_VERSION = 'package-normalization-policy-v2';

const LEGACY_BOOTSTRAP_ROOT = 'Packages/yucp.installed-packages/';
const LEGACY_BOOTSTRAP_MANIFEST = `${LEGACY_BOOTSTRAP_ROOT}package.json`;
const MAX_LEGACY_BOOTSTRAP_MANIFEST_BYTES = 256 * 1024;

export type InstallablePackageTreeFile = VpmBootstrapMetadataFile & {
  sha256: string;
};

export type InstallablePackageTree = {
  bootstrapMetadata: VpmBootstrapMetadata;
  excludedFiles: InstallablePackageTreeFile[];
  files: InstallablePackageTreeFile[];
  normalizationPolicyVersion: typeof PACKAGE_NORMALIZATION_POLICY_VERSION;
};

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function assertLegacyBootstrapContainerIdentity(
  files: readonly InstallablePackageTreeFile[]
): Promise<void> {
  const manifests = files.filter((file) => file.normalizedPath === LEGACY_BOOTSTRAP_MANIFEST);
  if (manifests.length !== 1) {
    throw new Error('Package has an invalid legacy bootstrap container identity');
  }
  const manifest = manifests[0] as InstallablePackageTreeFile;
  if (
    !Number.isSafeInteger(manifest.bytes) ||
    manifest.bytes < 1 ||
    manifest.bytes > MAX_LEGACY_BOOTSTRAP_MANIFEST_BYTES
  ) {
    throw new Error('Package has an invalid legacy bootstrap container identity');
  }
  const bytes = await readFile(manifest.path);
  if (bytes.byteLength !== manifest.bytes) {
    throw new Error('Legacy bootstrap container changed during ingest');
  }
  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder('utf-8', {
        fatal: true,
        ignoreBOM: false,
      }).decode(bytes)
    );
  } catch {
    throw new Error('Package has an invalid legacy bootstrap container identity');
  }
  if (!isRecord(value) || value.name !== 'yucp.installed-packages') {
    throw new Error('Package has an invalid legacy bootstrap container identity');
  }
}

export async function prepareInstallablePackageTree(
  files: readonly InstallablePackageTreeFile[]
): Promise<InstallablePackageTree> {
  const sorted = [...files].sort((left, right) =>
    compareText(left.normalizedPath, right.normalizedPath)
  );
  const excludedFiles = sorted.filter((file) =>
    file.normalizedPath.startsWith(LEGACY_BOOTSTRAP_ROOT)
  );
  if (excludedFiles.length > 0) {
    await assertLegacyBootstrapContainerIdentity(excludedFiles);
  }
  const bootstrapMetadata = await extractVpmBootstrapMetadataFromFiles(sorted);
  return {
    bootstrapMetadata,
    excludedFiles,
    files: sorted.filter((file) => !file.normalizedPath.startsWith(LEGACY_BOOTSTRAP_ROOT)),
    normalizationPolicyVersion: PACKAGE_NORMALIZATION_POLICY_VERSION,
  };
}
