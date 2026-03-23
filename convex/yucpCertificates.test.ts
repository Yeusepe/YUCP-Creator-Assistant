import { describe, expect, it } from 'bun:test';
import {
  countDistinctActiveDeviceKeys,
  isWithinRenewalOverlapWindow,
  selectLatestActiveCertificate,
  summarizeActiveCertificatesByDevice,
} from './yucpCertificates';

const NOW = 1_760_000_000_000;

function buildCertificate(
  overrides: Partial<Parameters<typeof summarizeActiveCertificatesByDevice>[0][number]>
) {
  return {
    certNonce: 'cert-1',
    createdAt: NOW - 1_000,
    devPublicKey: 'device-1',
    expiresAt: NOW + 10 * 24 * 60 * 60 * 1000,
    issuedAt: NOW - 2 * 24 * 60 * 60 * 1000,
    publisherId: 'publisher-1',
    publisherName: 'Publisher One',
    status: 'active' as const,
    updatedAt: NOW - 1_000,
    yucpUserId: 'user-1',
    ...overrides,
  };
}

describe('yucpCertificates helpers', () => {
  it('selects the newest active certificate for a device', () => {
    const certificates = [
      buildCertificate({
        certNonce: 'older',
        issuedAt: NOW - 3 * 24 * 60 * 60 * 1000,
      }),
      buildCertificate({
        certNonce: 'newer',
        issuedAt: NOW - 24 * 60 * 60 * 1000,
      }),
      buildCertificate({
        certNonce: 'revoked',
        issuedAt: NOW,
        status: 'revoked',
      }),
    ];

    expect(selectLatestActiveCertificate(certificates, NOW)?.certNonce).toBe('newer');
  });

  it('summarizes overlapping renewals to one active device entry per key', () => {
    const certificates = [
      buildCertificate({
        certNonce: 'old-device-1',
        devPublicKey: 'device-1',
        issuedAt: NOW - 5 * 24 * 60 * 60 * 1000,
      }),
      buildCertificate({
        certNonce: 'new-device-1',
        devPublicKey: 'device-1',
        issuedAt: NOW - 24 * 60 * 60 * 1000,
      }),
      buildCertificate({
        certNonce: 'device-2',
        devPublicKey: 'device-2',
        publisherId: 'publisher-2',
      }),
    ];

    expect(
      summarizeActiveCertificatesByDevice(certificates, NOW).map(
        (certificate) => certificate.certNonce
      )
    ).toEqual(['new-device-1', 'device-2']);
  });

  it('counts distinct active device keys instead of raw overlapping certificates', () => {
    const certificates = [
      buildCertificate({ certNonce: 'old-device-1', devPublicKey: 'device-1' }),
      buildCertificate({
        certNonce: 'new-device-1',
        devPublicKey: 'device-1',
        issuedAt: NOW - 10_000,
      }),
      buildCertificate({
        certNonce: 'expired-device-2',
        devPublicKey: 'device-2',
        expiresAt: NOW - 1,
      }),
      buildCertificate({
        certNonce: 'active-device-3',
        devPublicKey: 'device-3',
      }),
    ];

    expect(countDistinctActiveDeviceKeys(certificates, NOW)).toBe(2);
  });

  it('only opens the renewal overlap window near expiry', () => {
    expect(isWithinRenewalOverlapWindow(NOW + 7 * 24 * 60 * 60 * 1000, NOW)).toBe(true);
    expect(isWithinRenewalOverlapWindow(NOW + 30 * 24 * 60 * 60 * 1000, NOW)).toBe(false);
  });
});
