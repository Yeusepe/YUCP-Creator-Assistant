import { describe, expect, it } from 'bun:test';
import {
  AUTOMATIC_SETUP_FEATURE_FLAG,
  isAutomaticSetupEnabled,
  isPrivateVpmEnabled,
  PRIVATE_VPM_FEATURE_FLAG,
} from './featureFlags';

describe('automatic setup feature flag', () => {
  it('defaults to disabled when the env var is missing', () => {
    expect(isAutomaticSetupEnabled({})).toBe(false);
  });

  it('accepts common truthy flag values', () => {
    expect(isAutomaticSetupEnabled({ [AUTOMATIC_SETUP_FEATURE_FLAG]: 'true' })).toBe(true);
    expect(isAutomaticSetupEnabled({ [AUTOMATIC_SETUP_FEATURE_FLAG]: '1' })).toBe(true);
    expect(isAutomaticSetupEnabled({ [AUTOMATIC_SETUP_FEATURE_FLAG]: 'on' })).toBe(true);
  });

  it('treats falsey and unknown values as disabled', () => {
    expect(isAutomaticSetupEnabled({ [AUTOMATIC_SETUP_FEATURE_FLAG]: 'false' })).toBe(false);
    expect(isAutomaticSetupEnabled({ [AUTOMATIC_SETUP_FEATURE_FLAG]: 'off' })).toBe(false);
    expect(isAutomaticSetupEnabled({ [AUTOMATIC_SETUP_FEATURE_FLAG]: 'unexpected' })).toBe(false);
  });
});

describe('private VPM feature flag', () => {
  it('defaults to disabled when the env var is missing', () => {
    expect(isPrivateVpmEnabled({})).toBe(false);
  });

  it('accepts common truthy flag values', () => {
    expect(isPrivateVpmEnabled({ [PRIVATE_VPM_FEATURE_FLAG]: 'true' })).toBe(true);
    expect(isPrivateVpmEnabled({ [PRIVATE_VPM_FEATURE_FLAG]: '1' })).toBe(true);
    expect(isPrivateVpmEnabled({ [PRIVATE_VPM_FEATURE_FLAG]: 'on' })).toBe(true);
  });

  it('treats falsey and unknown values as disabled', () => {
    expect(isPrivateVpmEnabled({ [PRIVATE_VPM_FEATURE_FLAG]: 'false' })).toBe(false);
    expect(isPrivateVpmEnabled({ [PRIVATE_VPM_FEATURE_FLAG]: 'off' })).toBe(false);
    expect(isPrivateVpmEnabled({ [PRIVATE_VPM_FEATURE_FLAG]: 'unexpected' })).toBe(false);
  });
});
