import { describe, expect, it } from 'vitest';
import { buildSetupAuthQuery, withSetupAuthUserId } from '@/lib/setupAuth';

describe('setup auth helpers', () => {
  it('adds authUserId to setup API query strings', () => {
    expect(buildSetupAuthQuery('/api/connect/jinxxy/webhook-config', 'tenant-123')).toBe(
      '/api/connect/jinxxy/webhook-config?authUserId=tenant-123'
    );
  });

  it('adds authUserId to setup API request bodies', () => {
    expect(withSetupAuthUserId({ apiKey: 'secret' }, 'tenant-123')).toEqual({
      apiKey: 'secret',
      authUserId: 'tenant-123',
    });
  });
});
