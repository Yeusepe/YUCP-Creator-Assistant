import { describe, expect, it } from 'bun:test';
import {
  buildVerificationCallbackUri,
  createVerificationState,
  getPkceVerifierStoreKey,
  parseVerificationState,
} from './verificationSessionPrimitives';

describe('verification session primitives', () => {
  describe('createVerificationState', () => {
    it('uses the dedicated gumroad verification prefix', () => {
      const state = createVerificationState('user_test123', 'gumroad');

      expect(state).toMatch(/^verify_gumroad:user_test123:[0-9a-f]{96}$/);
      expect(parseVerificationState(state)).toEqual({ authUserId: 'user_test123' });
    });

    it('uses auth user id as the leading segment for non-gumroad modes', () => {
      const state = createVerificationState('user_test123', 'discord_role');

      expect(state).toMatch(/^user_test123:[0-9a-f]{96}$/);
      expect(parseVerificationState(state)).toEqual({ authUserId: 'user_test123' });
    });
  });

  describe('parseVerificationState', () => {
    it('rejects malformed state values', () => {
      expect(parseVerificationState('missing-delimiter')).toBeNull();
    });
  });

  describe('getPkceVerifierStoreKey', () => {
    it('uses the dedicated verifier store namespace', () => {
      expect(getPkceVerifierStoreKey('test-state')).toBe('pkce_verifier:test-state');
    });
  });

  describe('buildVerificationCallbackUri', () => {
    it('uses the unified gumroad callback uri', () => {
      expect(
        buildVerificationCallbackUri(
          'https://api.example.com',
          'gumroad',
          '/api/verification/callback/gumroad'
        )
      ).toBe('https://api.example.com/api/connect/gumroad/callback');
    });

    it('uses the provider callback path for non-gumroad modes', () => {
      expect(
        buildVerificationCallbackUri(
          'https://api.example.com',
          'discord_role',
          '/api/verification/callback/discord'
        )
      ).toBe('https://api.example.com/api/verification/callback/discord');
    });
  });
});
