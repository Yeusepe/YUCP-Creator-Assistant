import { describe, expect, it, mock } from 'bun:test';

mock.module(
  '@yucp/shared/logging/redaction',
  async () => await import('../packages/shared/src/logging/redaction.ts')
);

const { sanitizeWebhookSubscriptionForPublicRead } = await import('./webhookSubscriptions');

describe('sanitizeWebhookSubscriptionForPublicRead', () => {
  it('removes the encrypted signing secret and keeps the public prefix', () => {
    const result = sanitizeWebhookSubscriptionForPublicRead({
      _id: 'sub_123',
      signingSecretEnc: 'encrypted-secret',
      signingSecretPrefix: 'whsec_ab',
      description: 'Webhook subscription',
    });

    expect(result).not.toHaveProperty('signingSecretEnc');
    expect(result.signingSecretPrefix).toBe('whsec_ab');
  });

  it('redacts token-like values through shared redaction helpers', () => {
    const result = sanitizeWebhookSubscriptionForPublicRead({
      notes: 'bearer secret-token-value',
      headers: {
        authorization: 'Bearer secret-token-value',
      },
    });

    expect(result.notes).toBe('bearer [TOKEN_REDACTED]');
    expect(result.headers).toEqual({
      authorization: '[REDACTED]',
    });
  });
});
