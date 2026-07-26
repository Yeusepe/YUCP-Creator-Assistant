import { createHash } from 'node:crypto';
import type { NormalizedPackageFile } from './packageNormalizer';

export const PROTECTION_POLICY_IDS = [
  'common-only-v1',
  'supported-visual-assets-v1',
  'supported-visual-assets-v2',
] as const;

export type ProtectionPolicyId = (typeof PROTECTION_POLICY_IDS)[number];

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
  protectedFileRequirement: 'best-effort' | 'required';
};

const classificationRules: Record<
  ProtectionPolicyId,
  ReadonlyArray<{
    extension: string;
    materializerType: 'fbx' | 'png' | 'zip';
  }>
> = {
  'common-only-v1': [],
  'supported-visual-assets-v1': [
    { extension: '.fbx', materializerType: 'fbx' },
    { extension: '.png', materializerType: 'png' },
  ],
  'supported-visual-assets-v2': [
    { extension: '.fbx', materializerType: 'fbx' },
    { extension: '.png', materializerType: 'png' },
    { extension: '.zip', materializerType: 'zip' },
  ],
};

const materializationPolicies: Record<ProtectionPolicyId, ProtectionMaterializationPolicy> = {
  'common-only-v1': {
    minimumCoupledFiles: 0,
    protectedFileRequirement: 'required',
  },
  'supported-visual-assets-v1': {
    minimumCoupledFiles: 1,
    protectedFileRequirement: 'required',
  },
  'supported-visual-assets-v2': {
    minimumCoupledFiles: 1,
    protectedFileRequirement: 'required',
  },
};

export function isProtectionPolicyId(value: string): value is ProtectionPolicyId {
  return (PROTECTION_POLICY_IDS as readonly string[]).includes(value);
}

export function protectionMaterializationPolicy(policyId: string): ProtectionMaterializationPolicy {
  if (!isProtectionPolicyId(policyId)) {
    throw new Error(`Unknown protection policy: ${policyId}`);
  }
  return { ...materializationPolicies[policyId] };
}

export function classifyPackageFiles(input: {
  files: readonly NormalizedPackageFile[];
  policyId: ProtectionPolicyId;
}): ProtectionPolicySnapshot {
  const rules = classificationRules[input.policyId];
  const files = input.files.map((file): ClassifiedPackageFile => {
    const normalizedPath = file.normalizedPath.toLocaleLowerCase('en-US');
    const rule = rules.find(({ extension }) => normalizedPath.endsWith(extension));
    return rule
      ? {
          ...file,
          classification: 'protected',
          materializerType: rule.materializerType,
        }
      : { ...file, classification: 'common' };
  });
  const isZipAwarePolicy = input.policyId === 'supported-visual-assets-v2';
  const policyBody = JSON.stringify(
    isZipAwarePolicy
      ? {
          id: input.policyId,
          materialization: materializationPolicies[input.policyId],
          rules,
          schemaVersion: 2,
        }
      : {
          id: input.policyId,
          rules,
          schemaVersion: 1,
        }
  );
  return {
    digest: createHash('sha256')
      .update(
        isZipAwarePolicy ? 'yucp:protection-policy:v2\0' : 'yucp:protection-policy:v1\0',
        'utf8'
      )
      .update(policyBody, 'utf8')
      .digest('hex'),
    files,
    id: input.policyId,
  };
}
