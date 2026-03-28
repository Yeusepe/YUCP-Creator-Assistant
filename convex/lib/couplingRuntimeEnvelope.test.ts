import { describe, expect, it } from 'bun:test';
import {
  buildCouplingRuntimeEnvelopePurpose,
  type CouplingRuntimeEnvelopeInput,
  deriveCouplingRuntimeEnvelopeKeyBytes,
} from './couplingRuntimeEnvelope';

const SAMPLE_INPUT: CouplingRuntimeEnvelopeInput = {
  artifactKey: 'coupling-runtime',
  channel: 'stable',
  platform: 'win-x64',
  version: '1.0.0',
  plaintextSha256: 'a'.repeat(64),
};

describe('couplingRuntimeEnvelope', () => {
  describe('buildCouplingRuntimeEnvelopePurpose', () => {
    it('includes all fields joined with pipe', () => {
      const purpose = buildCouplingRuntimeEnvelopePurpose(SAMPLE_INPUT);
      expect(purpose).toBe(
        'signed-release-artifact|coupling-runtime|stable|win-x64|1.0.0|' + 'a'.repeat(64)
      );
    });
  });

  describe('deriveCouplingRuntimeEnvelopeKeyBytes', () => {
    it('throws when YUCP_RELEASE_ENVELOPE_KEY is missing', async () => {
      const saved = process.env.YUCP_RELEASE_ENVELOPE_KEY;
      const savedOld = process.env.YUCP_RELEASE_ENVELOPE_SECRET;
      const savedOld2 = process.env.YUCP_COUPLING_ENVELOPE_SECRET;
      const savedRoot = process.env.YUCP_ROOT_PRIVATE_KEY;
      delete process.env.YUCP_RELEASE_ENVELOPE_KEY;
      delete process.env.YUCP_RELEASE_ENVELOPE_SECRET;
      delete process.env.YUCP_COUPLING_ENVELOPE_SECRET;
      delete process.env.YUCP_ROOT_PRIVATE_KEY;

      await expect(deriveCouplingRuntimeEnvelopeKeyBytes(SAMPLE_INPUT)).rejects.toThrow(
        'YUCP_RELEASE_ENVELOPE_KEY'
      );

      process.env.YUCP_RELEASE_ENVELOPE_KEY = saved;
      process.env.YUCP_RELEASE_ENVELOPE_SECRET = savedOld;
      process.env.YUCP_COUPLING_ENVELOPE_SECRET = savedOld2;
      process.env.YUCP_ROOT_PRIVATE_KEY = savedRoot;
    });

    it('does not fall back to root private key', async () => {
      const saved = process.env.YUCP_RELEASE_ENVELOPE_KEY;
      const savedOld = process.env.YUCP_RELEASE_ENVELOPE_SECRET;
      const savedOld2 = process.env.YUCP_COUPLING_ENVELOPE_SECRET;
      delete process.env.YUCP_RELEASE_ENVELOPE_KEY;
      delete process.env.YUCP_RELEASE_ENVELOPE_SECRET;
      delete process.env.YUCP_COUPLING_ENVELOPE_SECRET;
      process.env.YUCP_ROOT_PRIVATE_KEY = 'root-key';

      await expect(deriveCouplingRuntimeEnvelopeKeyBytes(SAMPLE_INPUT)).rejects.toThrow(
        'YUCP_RELEASE_ENVELOPE_KEY'
      );

      process.env.YUCP_RELEASE_ENVELOPE_KEY = saved;
      process.env.YUCP_RELEASE_ENVELOPE_SECRET = savedOld;
      process.env.YUCP_COUPLING_ENVELOPE_SECRET = savedOld2;
    });

    it('derives a 32-byte key when YUCP_RELEASE_ENVELOPE_KEY is set', async () => {
      const saved = process.env.YUCP_RELEASE_ENVELOPE_KEY;
      process.env.YUCP_RELEASE_ENVELOPE_KEY = 'test-envelope-key-for-unit-tests';

      const keyBytes = await deriveCouplingRuntimeEnvelopeKeyBytes(SAMPLE_INPUT);
      expect(keyBytes.byteLength).toBe(32);

      process.env.YUCP_RELEASE_ENVELOPE_KEY = saved;
    });

    it('same inputs produce same key bytes (deterministic)', async () => {
      const saved = process.env.YUCP_RELEASE_ENVELOPE_KEY;
      process.env.YUCP_RELEASE_ENVELOPE_KEY = 'test-envelope-key-for-unit-tests';

      const k1 = await deriveCouplingRuntimeEnvelopeKeyBytes(SAMPLE_INPUT);
      const k2 = await deriveCouplingRuntimeEnvelopeKeyBytes(SAMPLE_INPUT);
      expect(Array.from(k1)).toEqual(Array.from(k2));

      process.env.YUCP_RELEASE_ENVELOPE_KEY = saved;
    });

    it('different version produces different key bytes (domain separation)', async () => {
      const saved = process.env.YUCP_RELEASE_ENVELOPE_KEY;
      process.env.YUCP_RELEASE_ENVELOPE_KEY = 'test-envelope-key-for-unit-tests';

      const k1 = await deriveCouplingRuntimeEnvelopeKeyBytes(SAMPLE_INPUT);
      const k2 = await deriveCouplingRuntimeEnvelopeKeyBytes({ ...SAMPLE_INPUT, version: '2.0.0' });
      expect(Array.from(k1)).not.toEqual(Array.from(k2));

      process.env.YUCP_RELEASE_ENVELOPE_KEY = saved;
    });
  });
});
