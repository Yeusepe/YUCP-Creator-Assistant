import { createHash } from 'node:crypto';
import type { NormalizedPackageFile } from './packageNormalizer';

export const PROTECTION_POLICY_IDS = ['common-only-v1', 'supported-visual-assets-v1'] as const;

export type ProtectionPolicyId = (typeof PROTECTION_POLICY_IDS)[number];

export type ClassifiedPackageFile = NormalizedPackageFile & {
  classification: 'common' | 'protected';
  materializerType?: 'fbx' | 'png';
};

export type ProtectionPolicySnapshot = {
  digest: string;
  files: ClassifiedPackageFile[];
  id: ProtectionPolicyId;
};

const policyDefinitions: Record<
  ProtectionPolicyId,
  ReadonlyArray<{ extension: string; materializerType: 'fbx' | 'png' }>
> = {
  'common-only-v1': [],
  'supported-visual-assets-v1': [
    { extension: '.fbx', materializerType: 'fbx' },
    { extension: '.png', materializerType: 'png' },
  ],
};

export function isProtectionPolicyId(value: string): value is ProtectionPolicyId {
  return (PROTECTION_POLICY_IDS as readonly string[]).includes(value);
}

export function classifyPackageFiles(input: {
  files: readonly NormalizedPackageFile[];
  policyId: ProtectionPolicyId;
}): ProtectionPolicySnapshot {
  const rules = policyDefinitions[input.policyId];
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
  const policyBody = JSON.stringify({
    id: input.policyId,
    rules,
    schemaVersion: 1,
  });
  return {
    digest: createHash('sha256')
      .update('yucp:protection-policy:v1\0', 'utf8')
      .update(policyBody, 'utf8')
      .digest('hex'),
    files,
    id: input.policyId,
  };
}
