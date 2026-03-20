import { describe, expect, it } from 'bun:test';
import { getInternalRpcSharedSecret } from './internalRpcSecret';

describe('getInternalRpcSharedSecret', () => {
  it('returns the configured secret when present', () => {
    expect(
      getInternalRpcSharedSecret({
        INTERNAL_RPC_SHARED_SECRET: 'configured-secret',
        NODE_ENV: 'development',
      })
    ).toBe('configured-secret');
  });

  it('falls back to the local development secret outside production', () => {
    expect(
      getInternalRpcSharedSecret({
        NODE_ENV: 'development',
      })
    ).toBeDefined();
  });

  it('throws in production when the secret is missing', () => {
    expect(() =>
      getInternalRpcSharedSecret({
        NODE_ENV: 'production',
      })
    ).toThrow('INTERNAL_RPC_SHARED_SECRET');
  });
});
