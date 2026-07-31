import { createHash } from 'node:crypto';
import type { NormalizedPackageFile } from './packageNormalizer';
import { isProtectionPolicyId, type ProtectionPolicyId } from './protectionPolicyId';

export type { ProtectionPolicyId } from './protectionPolicyId';
export {
  ACTIVE_PROTECTION_POLICY_ID,
  isProtectionPolicyId,
  PROTECTION_POLICY_IDS,
} from './protectionPolicyId';

export type ClassifiablePackageFile = NormalizedPackageFile & {
  pixelHeight?: number;
  pixelWidth?: number;
};

export type ClassifiedPackageFile = NormalizedPackageFile & {
  classification: 'common' | 'protected';
  materializerType?: 'fbx' | 'png' | 'zip';
};

export const COUPLING_MIN_PNG_BLOCKS = 3456;

function pngCouplingBlocks(file: ClassifiablePackageFile): number | null {
  if (file.pixelWidth === undefined || file.pixelHeight === undefined) {
    return null;
  }
  return Math.floor(file.pixelWidth / 8) * Math.floor(file.pixelHeight / 8);
}

export type ProtectionPolicySnapshot = {
  digest: string;
  files: ClassifiedPackageFile[];
  id: ProtectionPolicyId;
};

export type ProtectionMaterializationPolicy = {
  minimumCoupledFiles: number;
  protectedFileRequirement: 'best-effort';
};

const classificationRules: ReadonlyArray<{
  extension: string;
  materializerType: 'fbx' | 'png' | 'zip';
}> = [
  { extension: '.fbx', materializerType: 'fbx' },
  { extension: '.png', materializerType: 'png' },
  { extension: '.zip', materializerType: 'zip' },
];

/**
 * Assets that ship deactivated carry this marker until the installer renames them
 * onto their real extension. The bytes are still the asset the buyer receives, so
 * classification reads through the marker; matching the stored name instead would
 * quietly deliver every deactivated asset unprotected.
 */
const DEACTIVATED_ASSET_SUFFIX = '.yucp_disabled';

export function classifiablePath(normalizedPath: string): string {
  const lowered = normalizedPath.toLocaleLowerCase('en-US');
  return lowered.endsWith(DEACTIVATED_ASSET_SUFFIX)
    ? lowered.slice(0, -DEACTIVATED_ASSET_SUFFIX.length)
    : lowered;
}

const materializationPolicy: ProtectionMaterializationPolicy = {
  minimumCoupledFiles: 1,
  protectedFileRequirement: 'best-effort',
};

export function protectionMaterializationPolicy(policyId: string): ProtectionMaterializationPolicy {
  if (!isProtectionPolicyId(policyId)) {
    throw new Error(`Unknown protection policy: ${policyId}`);
  }
  return { ...materializationPolicy };
}

export function classifyPackageFiles(input: {
  files: readonly ClassifiablePackageFile[];
  policyId: ProtectionPolicyId;
}): ProtectionPolicySnapshot {
  const files = input.files.map((file): ClassifiedPackageFile => {
    const { pixelHeight, pixelWidth, ...carried } = file;
    const normalizedPath = classifiablePath(file.normalizedPath);
    const rule = classificationRules.find(({ extension }) => normalizedPath.endsWith(extension));
    if (!rule) {
      return { ...carried, classification: 'common' };
    }
    if (rule.materializerType === 'png') {
      const blocks = pngCouplingBlocks(file);
      if (blocks === null || blocks < COUPLING_MIN_PNG_BLOCKS) {
        return { ...carried, classification: 'common' };
      }
    }
    return {
      ...carried,
      classification: 'protected',
      materializerType: rule.materializerType,
    };
  });
  const policyBody = JSON.stringify({
    id: input.policyId,
    materialization: materializationPolicy,
    minimumPngCouplingBlocks: COUPLING_MIN_PNG_BLOCKS,
    rules: classificationRules,
    schemaVersion: 3,
  });
  return {
    digest: createHash('sha256')
      .update('yucp:protection-policy:v2\0', 'utf8')
      .update(policyBody, 'utf8')
      .digest('hex'),
    files,
    id: input.policyId,
  };
}
