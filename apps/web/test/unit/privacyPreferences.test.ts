import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildPrivacyPreferences,
  getDiagnosticsRequestHeaders,
  PRIVACY_PREFERENCES_COOKIE,
  PRIVACY_PREFERENCES_STORAGE_KEY,
  parsePrivacyPreferences,
  readStoredPrivacyPreferences,
  savePrivacyPreferences,
  serializePrivacyPreferences,
} from '../../src/lib/privacyPreferences';

describe('privacyPreferences', () => {
  const originalCrypto = globalThis.crypto;

  beforeEach(() => {
    localStorage.clear();
    // biome-ignore lint/suspicious/noDocumentCookie: The test needs to clear the consent cookie to verify cookie fallback behavior.
    document.cookie = `${PRIVACY_PREFERENCES_COOKIE}=; Max-Age=0; Path=/`;
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: originalCrypto,
    });
  });

  it('parses stored helpful diagnostics preferences', () => {
    const serialized = serializePrivacyPreferences({
      version: 1,
      choice: 'helpful-diagnostics',
      diagnosticsEnabled: true,
      diagnosticsSessionId: 'diag-123',
      source: 'banner',
      updatedAt: 123,
    });

    expect(parsePrivacyPreferences(serialized)).toEqual({
      version: 1,
      choice: 'helpful-diagnostics',
      diagnosticsEnabled: true,
      diagnosticsSessionId: 'diag-123',
      source: 'banner',
      updatedAt: 123,
    });
  });

  it('returns null for malformed preference data', () => {
    expect(parsePrivacyPreferences('{"choice":"invalid"}')).toBeNull();
  });

  it('saves preferences to localStorage and first-party cookies', () => {
    const saved = savePrivacyPreferences('necessary-only', 'account');

    expect(saved.choice).toBe('necessary-only');
    expect(saved.diagnosticsEnabled).toBe(false);
    expect(localStorage.getItem(PRIVACY_PREFERENCES_STORAGE_KEY)).toContain('necessary-only');
    expect(document.cookie).toContain(`${PRIVACY_PREFERENCES_COOKIE}=`);
  });

  it('only propagates a diagnostics session after helpful diagnostics is accepted', () => {
    expect(getDiagnosticsRequestHeaders()).toEqual({});

    savePrivacyPreferences('helpful-diagnostics', 'banner');
    const headers = getDiagnosticsRequestHeaders();

    expect(headers).toHaveProperty('X-YUCP-Diagnostics-Session');
    expect(headers['X-YUCP-Diagnostics-Session']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );

    savePrivacyPreferences('necessary-only', 'account');
    expect(getDiagnosticsRequestHeaders()).toEqual({});
  });

  it('restores preferences from cookies when localStorage is empty', () => {
    const preferences = buildPrivacyPreferences('helpful-diagnostics', 'banner');
    // biome-ignore lint/suspicious/noDocumentCookie: The test seeds the first-party consent cookie before exercising cookie restore logic.
    document.cookie = `${PRIVACY_PREFERENCES_COOKIE}=${encodeURIComponent(
      serializePrivacyPreferences(preferences)
    )}; Path=/`;

    expect(readStoredPrivacyPreferences()).toMatchObject({
      choice: 'helpful-diagnostics',
      diagnosticsEnabled: true,
      source: 'banner',
    });
    expect(localStorage.getItem(PRIVACY_PREFERENCES_STORAGE_KEY)).toContain('helpful-diagnostics');
  });

  it('ignores malformed cookie payloads', () => {
    // biome-ignore lint/suspicious/noDocumentCookie: The test seeds an invalid cookie to verify safe fallback behavior.
    document.cookie = `${PRIVACY_PREFERENCES_COOKIE}=%E0%A4%A; Path=/`;

    expect(readStoredPrivacyPreferences()).toBeNull();
  });

  it('uses crypto.getRandomValues when randomUUID is unavailable', () => {
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: {
        getRandomValues(values: Uint8Array) {
          values.set([
            0x10, 0x32, 0x54, 0x76, 0x98, 0xba, 0xdc, 0xfe, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66,
            0x77, 0x88,
          ]);
          return values;
        },
      } satisfies Pick<Crypto, 'getRandomValues'>,
    });

    expect(buildPrivacyPreferences('helpful-diagnostics', 'banner').diagnosticsSessionId).toBe(
      '10325476-98ba-4cfe-9122-334455667788'
    );
  });
});
