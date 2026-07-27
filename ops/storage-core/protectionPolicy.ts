import { createHash } from 'node:crypto';
import type { NormalizedPackageFile } from './packageNormalizer';
import { isProtectionPolicyId, type ProtectionPolicyId } from './protectionPolicyId';

export type { ProtectionPolicyId } from './protectionPolicyId';
export {
  ACTIVE_PROTECTION_POLICY_ID,
  isProtectionPolicyId,
  PROTECTION_POLICY_IDS,
} from './protectionPolicyId';

export type ClassifiedPackageFile = NormalizedPackageFile & {
  classification: 'common' | 'protected';
  materializerType?: 'fbx' | 'png' | 'zip';
};

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
  files: readonly NormalizedPackageFile[];
  policyId: ProtectionPolicyId;
}): ProtectionPolicySnapshot {
  const files = input.files.map((file): ClassifiedPackageFile => {
    const normalizedPath = file.normalizedPath.toLocaleLowerCase('en-US');
    const rule = classificationRules.find(({ extension }) => normalizedPath.endsWith(extension));
    return rule
      ? {
          ...file,
          classification: 'protected',
          materializerType: rule.materializerType,
        }
      : { ...file, classification: 'common' };
  });
  const policyBody = JSON.stringify({
    id: input.policyId,
    materialization: materializationPolicy,
    rules: classificationRules,
    schemaVersion: 2,
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
