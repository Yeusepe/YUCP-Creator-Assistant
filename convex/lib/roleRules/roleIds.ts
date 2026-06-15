export const MAX_VERIFIED_ROLE_IDS_PER_RULE = 10;
export const MAX_ROLE_SYNC_DISCORD_OPERATIONS_PER_JOB = 100;

export const WRITABLE_ROLE_RULE_ROLE_LIMIT_ERROR = `A role rule can grant at most ${MAX_VERIFIED_ROLE_IDS_PER_RULE} verified roles`;
export const STORED_ROLE_RULE_ROLE_LIMIT_ERROR = `Role rule exceeds the maximum of ${MAX_VERIFIED_ROLE_IDS_PER_RULE} verified roles`;
export const ROLE_SYNC_OPERATION_LIMIT_ERROR = `Role sync exceeds the maximum of ${MAX_ROLE_SYNC_DISCORD_OPERATIONS_PER_JOB} Discord role operations`;

interface VerifiedRoleIdInput {
  verifiedRoleId?: string;
  verifiedRoleIds?: string[];
}

export function getConfiguredVerifiedRoleIds(input: VerifiedRoleIdInput): string[] {
  return input.verifiedRoleIds ?? (input.verifiedRoleId ? [input.verifiedRoleId] : []);
}

export function assertWritableVerifiedRoleIds(roleIds: string[]): void {
  if (roleIds.length > MAX_VERIFIED_ROLE_IDS_PER_RULE) {
    throw new Error(WRITABLE_ROLE_RULE_ROLE_LIMIT_ERROR);
  }
}

export function normalizeWritableVerifiedRoleIds(input: VerifiedRoleIdInput): string[] {
  const roleIds = getConfiguredVerifiedRoleIds(input);
  if (roleIds.length === 0) {
    throw new Error('At least one verified role is required');
  }
  assertWritableVerifiedRoleIds(roleIds);
  return roleIds;
}
