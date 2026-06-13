import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'bun:test';
import { redactForLogging } from '../packages/shared/src/logging/redaction';

const repoRoot = resolve(__dirname, '..');
const schemaSource = readFileSync(resolve(repoRoot, 'convex/schema.ts'), 'utf8');
const webhookIngestionSource = readFileSync(resolve(repoRoot, 'convex/webhookIngestion.ts'), 'utf8');

function tableBlock(tableName: string): string {
  const start = schemaSource.indexOf(`const ${tableName} = defineTable({`);
  if (start === -1) {
    throw new Error(`Missing schema table ${tableName}`);
  }
  const afterStart = schemaSource.slice(start);
  const nextTableOrConstant = afterStart.slice(1).search(/\nconst\s+\w+\s*=/u);
  const end = nextTableOrConstant === -1 ? afterStart.length : nextTableOrConstant + 1;
  return afterStart.slice(0, end);
}

describe('security audit invariants', () => {
  it('does not permit plaintext license keys or purchaser emails in forensics subject links', () => {
    const block = tableBlock('license_subject_links');

    expect(block).not.toContain('licenseKey: v.optional(v.string())');
    expect(block).not.toContain('purchaserEmail: v.optional(v.string())');
    expect(block).toContain('licenseKeyEncrypted: v.optional(v.string())');
  });

  it('does not persist raw webhook payloads that can contain buyer PII or license secrets', () => {
    const block = tableBlock('webhook_events');

    expect(block).not.toContain('rawPayload: v.any()');
    expect(webhookIngestionSource).not.toContain('rawPayload: args.rawPayload');
  });

  it('does not persist raw device identifiers for protected asset flows', () => {
    const unlocksBlock = tableBlock('protected_asset_unlocks');

    expect(unlocksBlock).not.toContain('machineFingerprint: v.string()');
    expect(unlocksBlock).not.toContain('projectId: v.string()');
    expect(unlocksBlock).toContain('machineFingerprintHash: v.string()');
    expect(unlocksBlock).toContain('projectIdHash: v.string()');

    const verificationIntentsBlock = tableBlock('verification_intents');
    expect(verificationIntentsBlock).not.toContain('machineFingerprint: v.string()');
    expect(verificationIntentsBlock).toContain('machineFingerprintHash: v.string()');
  });

  it('redacts derived PII field names and email strings before logging', () => {
    const redacted = redactForLogging({
      purchaserEmail: 'buyer@example.com',
      machineFingerprint: 'buyer-access-web:0123456789abcdef0123456789abcdef',
      message: 'manual review for buyer@example.com',
    });

    expect(redacted.purchaserEmail).not.toContain('buyer@example.com');
    expect(redacted.machineFingerprint).toBe('[FINGERPRINT_REDACTED]');
    expect(redacted.message).not.toContain('buyer@example.com');
  });
});
