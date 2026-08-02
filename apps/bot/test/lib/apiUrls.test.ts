import { afterEach, describe, expect, it } from 'bun:test';
import { resolveApiRequestBaseUrl } from '../../src/lib/apiUrls';

const originalApiBaseUrl = process.env.API_BASE_URL;
const originalApiInternalUrl = process.env.API_INTERNAL_URL;

afterEach(() => {
  if (originalApiBaseUrl === undefined) delete process.env.API_BASE_URL;
  else process.env.API_BASE_URL = originalApiBaseUrl;
  if (originalApiInternalUrl === undefined) delete process.env.API_INTERNAL_URL;
  else process.env.API_INTERNAL_URL = originalApiInternalUrl;
});

describe('resolveApiRequestBaseUrl', () => {
  it('selects the public HTTPS origin for credential-bearing requests', () => {
    process.env.API_BASE_URL = 'https://api.example.com/';
    process.env.API_INTERNAL_URL = 'http://api.zeabur.internal:8080';

    expect(
      resolveApiRequestBaseUrl({
        preferPublic: true,
        requireTls: true,
      })
    ).toBe('https://api.example.com');
  });

  it('does not downgrade a credential-bearing request to HTTP', () => {
    delete process.env.API_BASE_URL;
    process.env.API_INTERNAL_URL = 'http://api.zeabur.internal:8080';

    expect(resolveApiRequestBaseUrl({ requireTls: true })).toBeUndefined();
  });

  it('keeps the private endpoint preference for non-sensitive server requests', () => {
    process.env.API_BASE_URL = 'https://api.example.com';
    process.env.API_INTERNAL_URL = 'http://api.zeabur.internal:8080/';

    expect(resolveApiRequestBaseUrl()).toBe('http://api.zeabur.internal:8080');
  });
});
