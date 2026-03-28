import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  type ProtectedMaterializationGrantPayload,
  sealProtectedMaterializationGrant,
  unsealProtectedMaterializationGrant,
} from './protectedMaterializationGrant';

const MINIMAL_PAYLOAD: ProtectedMaterializationGrantPayload = {
  schemaVersion: 1,
  grantId: 'grant-abc123',
  creatorAuthUserId: 'user_creator',
  packageId: 'com.test.package',
  protectedAssetId: 'a'.repeat(32),
  licenseSubject: 'SHA256:abc',
  machineFingerprint: 'fp:test:01',
  projectId: 'b'.repeat(32),
  issuedAt: 1_700_000_000_000,
  expiresAt: 1_700_003_600_000,
  unlockToken: 'tok123',
  unlockExpiresAt: 1_700_003_600_000,
  coupling: { jobs: [] },
};

describe('protectedMaterializationGrant', () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.YUCP_GRANT_SEAL_KEY;
  });

  describe('getGrantSecret', () => {
    it('throws when YUCP_GRANT_SEAL_KEY is missing', async () => {
      delete process.env.YUCP_GRANT_SEAL_KEY;
      delete process.env.ENCRYPTION_SECRET;
      await expect(sealProtectedMaterializationGrant(MINIMAL_PAYLOAD)).rejects.toThrow(
        'YUCP_GRANT_SEAL_KEY'
      );
    });

    it('does not fall back to ENCRYPTION_SECRET', async () => {
      delete process.env.YUCP_GRANT_SEAL_KEY;
      process.env.ENCRYPTION_SECRET = 'some-secret';
      await expect(sealProtectedMaterializationGrant(MINIMAL_PAYLOAD)).rejects.toThrow(
        'YUCP_GRANT_SEAL_KEY'
      );
      delete process.env.ENCRYPTION_SECRET;
    });
  });

  describe('seal / unseal round-trip', () => {
    beforeEach(() => {
      process.env.YUCP_GRANT_SEAL_KEY = 'test-grant-seal-key-32-bytes-xxx';
    });

    it('round-trips a grant payload', async () => {
      const sealed = await sealProtectedMaterializationGrant(MINIMAL_PAYLOAD);
      const unsealed = await unsealProtectedMaterializationGrant(sealed);
      expect(unsealed.grantId).toBe(MINIMAL_PAYLOAD.grantId);
      expect(unsealed.packageId).toBe(MINIMAL_PAYLOAD.packageId);
      expect(unsealed.coupling.jobs).toEqual([]);
    });

    it('round-trips a grant with coupling jobs', async () => {
      const payload: ProtectedMaterializationGrantPayload = {
        ...MINIMAL_PAYLOAD,
        coupling: {
          subject: 'buyer-sub',
          jobs: [
            { assetPath: 'Assets/Foo.png', tokenHex: 'a'.repeat(64) },
            { assetPath: 'Assets/Bar.fbx', tokenHex: 'b'.repeat(32) },
          ],
        },
      };
      const sealed = await sealProtectedMaterializationGrant(payload);
      const unsealed = await unsealProtectedMaterializationGrant(sealed);
      expect(unsealed.coupling.jobs).toHaveLength(2);
      expect(unsealed.coupling.jobs[0]?.tokenHex).toBe('a'.repeat(64));
    });

    it('rejects tampered grant ciphertext', async () => {
      const sealed = await sealProtectedMaterializationGrant(MINIMAL_PAYLOAD);
      const tampered = sealed.slice(0, -4) + 'XXXX';
      await expect(unsealProtectedMaterializationGrant(tampered)).rejects.toThrow();
    });

    it('two seals of same payload produce different ciphertexts (random IV)', async () => {
      const s1 = await sealProtectedMaterializationGrant(MINIMAL_PAYLOAD);
      const s2 = await sealProtectedMaterializationGrant(MINIMAL_PAYLOAD);
      expect(s1).not.toBe(s2);
    });

    it('cannot unseal with a different key', async () => {
      const sealed = await sealProtectedMaterializationGrant(MINIMAL_PAYLOAD);
      process.env.YUCP_GRANT_SEAL_KEY = 'different-grant-seal-key-32-xxx';
      await expect(unsealProtectedMaterializationGrant(sealed)).rejects.toThrow();
    });
  });

  // Restore env after each test
  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.YUCP_GRANT_SEAL_KEY = originalEnv;
    } else {
      delete process.env.YUCP_GRANT_SEAL_KEY;
    }
  });
});
