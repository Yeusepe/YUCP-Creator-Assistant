import { describe, expect, it } from 'vitest';

describe('Convex workspace resolution', () => {
  it('resolves shared and provider subpath exports in realtests', async () => {
    const [sharedCrypto, bindingService, providerMetadata, publicAuthority] = await Promise.all([
      import('@yucp/shared/crypto'),
      import('@yucp/shared/binding/service'),
      import('@yucp/providers/providerMetadata'),
      import('@yucp/shared/publicAuthority'),
    ]);

    expect(sharedCrypto.sha256Hex).toBeTypeOf('function');
    expect(bindingService.calculateRemainingCooldown).toBeTypeOf('function');
    expect(providerMetadata.PROVIDER_KEYS).toContain('gumroad');
    expect(publicAuthority.resolveConfiguredApiBaseUrl).toBeTypeOf('function');
  });
});
