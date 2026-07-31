import { describe, expect, it } from 'bun:test';
import { CONVEX_ENV_VARS } from './sync-convex-env';

describe('sync-convex-env', () => {
  it('syncs API_BASE_URL to Convex so live provider product fetches do not fall back to SITE_URL', () => {
    expect(CONVEX_ENV_VARS).toContain('API_BASE_URL');
  });

  it('syncs the complete YUCP signing root configuration to Convex', () => {
    expect(CONVEX_ENV_VARS).toContain('YUCP_ROOT_PRIVATE_KEY');
    expect(CONVEX_ENV_VARS).toContain('YUCP_ROOT_KEY_ID');
    expect(CONVEX_ENV_VARS).toContain('YUCP_KEY_ID');
    expect(CONVEX_ENV_VARS).toContain('YUCP_TRUST_BUNDLE_JSON');
  });

  it('syncs the authenticated Convex log-stream webhook secret', () => {
    expect(CONVEX_ENV_VARS).toContain('CONVEX_LOG_STREAM_SECRET');
  });
});
