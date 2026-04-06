import { describe, expect, it } from 'bun:test';
import {
  parseCertificatePlanSelectionBody,
  parseCertificateRevokeBody,
} from './connectCertificateRouteSupport';

describe('connectCertificateRouteSupport', () => {
  it('parses a valid certificate plan selection body', () => {
    expect(parseCertificatePlanSelectionBody({ planKey: '  pro  ' })).toEqual({
      planKey: 'pro',
    });
  });

  it('rejects malformed certificate plan selection bodies', () => {
    expect(() => parseCertificatePlanSelectionBody(null)).toThrow('Invalid request body');
    expect(() => parseCertificatePlanSelectionBody(['plan'])).toThrow('Invalid request body');
    expect(() => parseCertificatePlanSelectionBody({ productId: 1 })).toThrow(
      'Invalid request body'
    );
  });

  it('requires either productId or planKey for certificate plan selection', () => {
    expect(() => parseCertificatePlanSelectionBody({})).toThrow('productId or planKey is required');
  });

  it('parses a valid certificate revoke body', () => {
    expect(parseCertificateRevokeBody({ certNonce: '  nonce-123  ' })).toEqual({
      certNonce: 'nonce-123',
    });
  });

  it('rejects malformed certificate revoke bodies', () => {
    expect(() => parseCertificateRevokeBody(null)).toThrow('Invalid request body');
    expect(() => parseCertificateRevokeBody({ certNonce: 42 })).toThrow('Invalid request body');
    expect(() => parseCertificateRevokeBody({ certNonce: '   ' })).toThrow('certNonce is required');
  });
});
