import { describe, expect, it } from 'bun:test';
import { isAllowedVerifyPanelOrigin, jsonNoStore, withNoStore } from './verificationRouteSupport';

describe('verificationRouteSupport', () => {
  it('sets application/json when jsonNoStore is used without an explicit content type', async () => {
    const response = jsonNoStore({ ok: true });

    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Content-Type')).toContain('application/json');
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it('preserves an explicit content type when jsonNoStore is used', () => {
    const response = jsonNoStore(
      { ok: true },
      { headers: { 'Content-Type': 'application/problem+json' } }
    );

    expect(response.headers.get('Content-Type')).toBe('application/problem+json');
  });

  it('rejects verify-panel requests when neither Origin nor Referer is present', () => {
    const request = new Request('https://api.example.com/api/verification/panel', {
      method: 'POST',
    });

    expect(
      isAllowedVerifyPanelOrigin(request, {
        baseUrl: 'https://api.example.com',
        frontendUrl: 'https://app.example.com',
      } as never)
    ).toBe(false);
  });

  it('accepts a matching referer origin when Origin is absent', () => {
    const request = new Request('https://api.example.com/api/verification/panel', {
      method: 'POST',
      headers: {
        referer: 'https://app.example.com/account/verify',
      },
    });

    expect(
      isAllowedVerifyPanelOrigin(request, {
        baseUrl: 'https://api.example.com',
        frontendUrl: 'https://app.example.com',
      } as never)
    ).toBe(true);
  });

  it('withNoStore preserves existing headers', () => {
    const headers = withNoStore({ Vary: 'Origin' });
    expect(headers.get('Cache-Control')).toBe('no-store');
    expect(headers.get('Vary')).toBe('Origin');
  });
});
