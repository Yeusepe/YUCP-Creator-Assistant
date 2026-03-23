import { describe, expect, it } from 'vitest';
import { ApiError } from '../../src/api/client';
import { getApiErrorMessage } from '../../src/lib/apiErrors';

describe('getApiErrorMessage', () => {
  it('prefers the API body error field when present', () => {
    const error = new ApiError(503, {
      error:
        'Certificate billing is temporarily unavailable because the configured Polar organization access token is invalid, expired, or for the wrong Polar environment.',
      code: 'polar_access_token_invalid',
    });

    expect(getApiErrorMessage(error, 'fallback')).toContain('Polar organization access token');
  });

  it('falls back to the provided default when no structured API body is available', () => {
    expect(getApiErrorMessage(new ApiError(500, null), 'fallback message')).toBe('API error 500');
    expect(getApiErrorMessage(null, 'fallback message')).toBe('fallback message');
  });
});
