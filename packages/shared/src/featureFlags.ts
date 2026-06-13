const TRUE_FLAG_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSE_FLAG_VALUES = new Set(['0', 'false', 'no', 'off']);

export const AUTOMATIC_SETUP_FEATURE_FLAG = 'YUCP_ENABLE_AUTOMATIC_SETUP';
export const PRIVATE_VPM_FEATURE_FLAG = 'YUCP_ENABLE_PRIVATE_VPM';

function readBooleanFeatureFlag(
  key: string,
  env: Record<string, string | undefined>,
  defaultValue: boolean
): boolean {
  const rawValue = env[key]?.trim().toLowerCase();
  if (!rawValue) {
    return defaultValue;
  }
  if (TRUE_FLAG_VALUES.has(rawValue)) {
    return true;
  }
  if (FALSE_FLAG_VALUES.has(rawValue)) {
    return false;
  }
  return defaultValue;
}

export function isAutomaticSetupEnabled(
  env: Record<string, string | undefined> = process.env
): boolean {
  return readBooleanFeatureFlag(AUTOMATIC_SETUP_FEATURE_FLAG, env, false);
}

export function isPrivateVpmEnabled(
  env: Record<string, string | undefined> = process.env
): boolean {
  return readBooleanFeatureFlag(PRIVATE_VPM_FEATURE_FLAG, env, false);
}
