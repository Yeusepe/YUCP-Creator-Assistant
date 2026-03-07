/**
 * Tests for shared package exports.
 * Uses real capture transport (sink) for logger tests-no mocks.
 */

import { describe, expect, it } from 'bun:test';
import type { LogEntry } from '../src/logging';
import {
  type VerificationStatus,
  createStructuredLogger,
  encrypt,
  decrypt,
  createAAD,
  validateActivateInput,
  canTransferBinding,
} from '../src/index';

describe('shared', () => {
  describe('createLogger', () => {
    it('emits message and metadata to capture sink', () => {
      const captured: LogEntry[] = [];
      const logger = createStructuredLogger({
        level: 'info',
        redactSensitive: false,
        sink: (e) => captured.push(e),
      });
      logger.info('msg', { key: 'val' });
      expect(captured).toHaveLength(1);
      expect(captured[0].message).toBe('msg');
      expect(captured[0].metadata).toEqual({ key: 'val' });
      expect(captured[0].level).toBe('info');
    });

    it('filters debug when level is error', () => {
      const captured: LogEntry[] = [];
      const logger = createStructuredLogger({
        level: 'error',
        sink: (e) => captured.push(e),
      });
      logger.debug('x');
      logger.info('y');
      logger.error('z');
      expect(captured).toHaveLength(1);
      expect(captured[0].message).toBe('z');
      expect(captured[0].level).toBe('error');
    });
  });

  describe('VerificationStatus', () => {
    it('matches expected values used in schema and API', () => {
      const statuses: VerificationStatus[] = ['pending', 'verified', 'rejected', 'expired'];
      expect(statuses).toHaveLength(4);
      expect(statuses).toContain('pending');
      expect(statuses).toContain('verified');
      expect(statuses).toContain('rejected');
      expect(statuses).toContain('expired');
    });
  });

  describe('encrypt/decrypt', () => {
    it('round-trips plaintext with envelope encryption', async () => {
      const kekBytes = new Uint8Array(32);
      crypto.getRandomValues(kekBytes);
      const aad = createAAD('tenant-1', 'gumroad', 'access');
      const plaintext = 'secret-token-123';
      const payload = await encrypt(plaintext, {
        keyId: 'test-kek',
        keyVersion: 1,
        kekBytes,
        aad,
      });
      expect(payload).toBeDefined();
      expect(payload.ciphertext).toBeDefined();
      const decrypted = await decrypt({ kekBytes, payload, aad });
      expect(decrypted).toBe(plaintext);
    });
  });

  describe('validateActivateInput', () => {
    it('returns errors for invalid bindingType', () => {
      const errors = validateActivateInput({
        tenantId: 't1',
        subjectId: 's1',
        externalAccountId: 'e1',
        bindingType: 'invalid' as any,
      });
      expect(errors).toContain('Invalid bindingType: invalid');
    });
  });

  describe('canTransferBinding', () => {
    it('allows transfer when allowTransfer is undefined (defaults to true)', () => {
      const result = canTransferBinding('active', {});
      expect(result).toBe(true);
    });
  });
});
