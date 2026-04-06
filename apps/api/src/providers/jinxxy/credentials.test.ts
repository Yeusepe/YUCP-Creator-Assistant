import { describe, expect, it, mock } from 'bun:test';

const apiMock = {
  providerConnections: {
    getConnectionForBackfill: 'providerConnections.getConnectionForBackfill',
  },
} as const;

mock.module('../../../../../convex/_generated/api', () => ({
  api: apiMock,
  internal: apiMock,
  components: {},
}));

const { encrypt } = await import('../../lib/encrypt');
const { JINXXY_API_KEY_PURPOSE, decryptJinxxyApiKey, resolveJinxxyCreatorApiKey } = await import(
  './credentials'
);

describe('resolveJinxxyCreatorApiKey', () => {
  it('returns null when the creator has not connected Jinxxy', async () => {
    const apiKey = await resolveJinxxyCreatorApiKey(
      {
        convex: {
          query: mock(async () => null),
        } as never,
        apiSecret: 'test-api-secret',
        encryptionSecret: 'test-encryption-secret-32-chars!!',
      },
      'auth_user_123'
    );

    expect(apiKey).toBeNull();
  });

  it('decrypts the stored creator API key', async () => {
    const encryptionSecret = 'test-encryption-secret-32-chars!!';
    const encryptedApiKey = await encrypt(
      'jinxxy-live-key',
      encryptionSecret,
      JINXXY_API_KEY_PURPOSE
    );

    const apiKey = await resolveJinxxyCreatorApiKey(
      {
        convex: {
          query: mock(async () => ({
            credentials: { api_key: encryptedApiKey },
          })),
        } as never,
        apiSecret: 'test-api-secret',
        encryptionSecret,
      },
      'auth_user_123'
    );

    expect(apiKey).toBe('jinxxy-live-key');
  });
});

describe('decryptJinxxyApiKey', () => {
  it('uses the provider-owned HKDF purpose', async () => {
    const encryptionSecret = 'test-encryption-secret-32-chars!!';
    const encryptedApiKey = await encrypt(
      'jinxxy-collab-key',
      encryptionSecret,
      JINXXY_API_KEY_PURPOSE
    );

    await expect(decryptJinxxyApiKey(encryptedApiKey, encryptionSecret)).resolves.toBe(
      'jinxxy-collab-key'
    );
  });
});
