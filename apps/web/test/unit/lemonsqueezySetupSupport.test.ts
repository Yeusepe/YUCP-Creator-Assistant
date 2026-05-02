import { describe, expect, it } from 'vitest';
import { resolveSetupApiBase } from '../../src/routes/setup/-lemonsqueezySetupSupport';

describe('resolveSetupApiBase', () => {
  it('rejects same-host URLs with a different origin', () => {
    expect(resolveSetupApiBase('http://example.com/api', 'https://example.com')).toBe(
      'https://example.com'
    );
  });

  it('preserves path prefixes for validated same-origin URLs', () => {
    expect(resolveSetupApiBase('https://example.com/proxy/api', 'https://example.com')).toBe(
      'https://example.com/proxy/api'
    );
  });

  it('accepts same-origin relative api_base paths', () => {
    expect(resolveSetupApiBase('/proxy/api/', 'https://example.com')).toBe(
      'https://example.com/proxy/api'
    );
  });
});
