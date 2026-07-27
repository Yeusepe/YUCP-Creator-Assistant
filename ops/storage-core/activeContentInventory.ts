import { createHash } from 'node:crypto';
import { encodeCanonicalPackageCbor, type PackageContractCborValue } from './packageContractsV2';

export const ACTIVE_CONTENT_POLICY_VERSION = 'active-content-policy-v1';

export type ActiveContentKind =
  | 'managed-build-config'
  | 'native-or-managed-plugin'
  | 'tooling-script'
  | 'unity-editor-script'
  | 'unity-runtime-script'
  | 'unity-shader-code';

export type ActiveContentEntry = {
  kind: ActiveContentKind;
  normalizedPath: string;
  sha256: string;
};

export type ActiveContentInventory = {
  digest: string;
  entries: ActiveContentEntry[];
  policyVersion: typeof ACTIVE_CONTENT_POLICY_VERSION;
};

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function classify(path: string): ActiveContentKind | undefined {
  const lower = path.toLowerCase();
  if (lower.endsWith('.cs')) {
    return lower.includes('/editor/') ? 'unity-editor-script' : 'unity-runtime-script';
  }
  if (
    lower.endsWith('.dll') ||
    lower.endsWith('.exe') ||
    lower.endsWith('.so') ||
    lower.endsWith('.dylib')
  ) {
    return 'native-or-managed-plugin';
  }
  if (lower.endsWith('.asmdef') || lower.endsWith('.asmref') || lower.endsWith('.rsp')) {
    return 'managed-build-config';
  }
  if (lower.endsWith('.shader') || lower.endsWith('.compute')) {
    return 'unity-shader-code';
  }
  if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.py')) {
    return 'tooling-script';
  }
  return undefined;
}

export function createActiveContentInventory(
  files: ReadonlyArray<{ normalizedPath: string; sha256: string }>
): ActiveContentInventory {
  const entries = files
    .map((file): ActiveContentEntry | undefined => {
      const kind = classify(file.normalizedPath);
      if (!kind) {
        return undefined;
      }
      if (!SHA256_PATTERN.test(file.sha256)) {
        throw new Error(`Active content has an invalid SHA-256: ${file.normalizedPath}`);
      }
      return {
        kind,
        normalizedPath: file.normalizedPath,
        sha256: file.sha256,
      };
    })
    .filter((entry): entry is ActiveContentEntry => Boolean(entry))
    .sort((left, right) => compareText(left.normalizedPath, right.normalizedPath));

  const encoded = encodeCanonicalPackageCbor(
    new Map<number, PackageContractCborValue>([
      [0, 1],
      [1, ACTIVE_CONTENT_POLICY_VERSION],
      [
        2,
        entries.map(
          (entry) =>
            new Map<number, PackageContractCborValue>([
              [0, entry.normalizedPath],
              [1, Uint8Array.from(Buffer.from(entry.sha256, 'hex'))],
              [2, entry.kind],
            ])
        ),
      ],
    ])
  );
  return {
    digest: createHash('sha256')
      .update('yucp:active-content-inventory:v1\0')
      .update(encoded)
      .digest('hex'),
    entries,
    policyVersion: ACTIVE_CONTENT_POLICY_VERSION,
  };
}
