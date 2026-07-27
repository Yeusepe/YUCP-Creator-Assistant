export const ACTIVE_PROTECTION_POLICY_ID = 'supported-visual-assets-v2' as const;
export const PROTECTION_POLICY_IDS = [ACTIVE_PROTECTION_POLICY_ID] as const;

export type ProtectionPolicyId = (typeof PROTECTION_POLICY_IDS)[number];

export function isProtectionPolicyId(value: string): value is ProtectionPolicyId {
  return value === ACTIVE_PROTECTION_POLICY_ID;
}
