import { describe, expect, it, mock } from 'bun:test';
import {
  CredentialExpiredError,
  type ProviderContext,
  type ProviderRuntimeClient,
} from '../../src/contracts';
import { createVrchatProviderModule } from '../../src/vrchat/module';

const logger = {
  warn: mock(() => {}),
};

function makeCtx(): ProviderContext<ProviderRuntimeClient> {
  return {
    convex: {
      query: async <_QueryRef, _Args, Result>() => null as Result,
      mutation: async <_MutationRef, _Args, Result>() => null as Result,
    },
    apiSecret: 'test-api-secret',
    authUserId: 'auth_user_123',
    encryptionSecret: 'test-encryption-secret',
  };
}

describe('createVrchatProviderModule.getCredential', () => {
  it('returns null when there is no encrypted creator session', async () => {
    const module = createVrchatProviderModule({
      logger,
      async getEncryptedCredential() {
        return null;
      },
      async decryptCredential() {
        throw new Error('not used');
      },
    });

    expect(await module.getCredential(makeCtx())).toBeNull();
  });

  it('decrypts and returns the creator session payload', async () => {
    const sessionPayload = JSON.stringify({ authToken: 'auth-tok', twoFactorAuthToken: 'two-tok' });
    const module = createVrchatProviderModule({
      logger,
      async getEncryptedCredential() {
        return 'encrypted-session';
      },
      async decryptCredential() {
        return sessionPayload;
      },
    });

    expect(await module.getCredential(makeCtx())).toBe(sessionPayload);
  });
});

describe('createVrchatProviderModule.fetchProducts', () => {
  it('returns an empty list when no credential is available', async () => {
    const module = createVrchatProviderModule({
      logger,
      async getEncryptedCredential() {
        return null;
      },
      async decryptCredential() {
        throw new Error('not used');
      },
    });

    expect(await module.fetchProducts(null, makeCtx())).toEqual([]);
  });

  it('maps VRChat listings into provider product records', async () => {
    const module = createVrchatProviderModule({
      logger,
      async getEncryptedCredential() {
        return null;
      },
      async decryptCredential() {
        throw new Error('not used');
      },
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      if (url.includes('/config')) {
        return new Response(JSON.stringify({ clientApiKey: 'test-key' }), { status: 200 });
      }
      if (url.includes('/auth/user')) {
        expect(headers.get('cookie')).toContain('auth=auth-tok');
        return new Response(JSON.stringify({ id: 'usr_creator', displayName: 'Creator' }), {
          status: 200,
        });
      }
      if (url.includes('/user/usr_creator/listings')) {
        return new Response(
          JSON.stringify([
            { id: 'prod_aaa', displayName: 'Avatar Pack' },
            { id: 'prod_bbb', displayName: 'Subscription' },
          ]),
          { status: 200 }
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as unknown as typeof fetch;

    try {
      const products = await module.fetchProducts(
        JSON.stringify({ authToken: 'auth-tok' }),
        makeCtx()
      );
      expect(products).toEqual([
        { id: 'prod_aaa', name: 'Avatar Pack' },
        { id: 'prod_bbb', name: 'Subscription' },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('throws CredentialExpiredError when the creator session is expired', async () => {
    const module = createVrchatProviderModule({
      logger,
      async getEncryptedCredential() {
        return null;
      },
      async decryptCredential() {
        throw new Error('not used');
      },
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (url: string) => {
      if (url.includes('/config')) {
        return new Response(JSON.stringify({ clientApiKey: 'test-key' }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
    }) as unknown as typeof fetch;

    try {
      await expect(
        module.fetchProducts(JSON.stringify({ authToken: 'expired-tok' }), makeCtx())
      ).rejects.toBeInstanceOf(CredentialExpiredError);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
