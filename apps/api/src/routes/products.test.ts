import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { ProductRecord } from '../providers/types';

const fetchProductsMock = mock(
  async (_credential: string | null, _ctx: unknown): Promise<ProductRecord[]> => []
);
const getCredentialMock = mock(
  async (_ctx: unknown): Promise<string | null> => 'provider-credential'
);
const getProviderRuntimeMock = mock(
  (): {
    needsCredential: boolean;
    supportsCollab?: boolean;
    getCredential: typeof getCredentialMock;
    fetchProducts: typeof fetchProductsMock;
  } => ({
    needsCredential: true,
    getCredential: getCredentialMock,
    fetchProducts: fetchProductsMock,
  })
);
const errorMock = mock((_message: string, _meta?: Record<string, unknown>) => {});
const warnMock = mock((_message: string, _meta?: Record<string, unknown>) => {});

mock.module('../../../../convex/_generated/api', () => ({
  api: {
    providerConnections: {
      markConnectionDegraded: 'providerConnections.markConnectionDegraded',
    },
  },
}));

mock.module('../lib/convex', () => ({
  getConvexClientFromUrl: () => ({
    mutation: mock(async () => undefined),
  }),
}));

mock.module('../lib/env', () => ({
  loadEnv: () => ({
    ENCRYPTION_SECRET: 'encryption-secret',
  }),
}));

mock.module('../lib/logger', () => ({
  logger: {
    debug: mock(() => undefined),
    info: mock(() => undefined),
    warn: warnMock,
    error: errorMock,
    child: () => {
      throw new Error('child logger should not be called in this test');
    },
  },
}));

mock.module('../providers/index', () => ({
  getProviderRuntime: getProviderRuntimeMock,
}));

const { handleProviderProducts } = await import('./products');

describe('handleProviderProducts', () => {
  const previousConvexApiSecret = process.env.CONVEX_API_SECRET;
  const previousConvexUrl = process.env.CONVEX_URL;

  beforeEach(() => {
    process.env.CONVEX_API_SECRET = 'convex-secret';
    process.env.CONVEX_URL = 'https://convex.example';

    fetchProductsMock.mockReset();
    getCredentialMock.mockReset();
    getProviderRuntimeMock.mockReset();
    errorMock.mockReset();
    warnMock.mockReset();

    getCredentialMock.mockResolvedValue('provider-credential');
    fetchProductsMock.mockResolvedValue([]);
    getProviderRuntimeMock.mockReturnValue({
      needsCredential: true,
      getCredential: getCredentialMock,
      fetchProducts: fetchProductsMock,
    });
  });

  afterAll(() => {
    mock.restore();

    if (previousConvexApiSecret === undefined) {
      delete process.env.CONVEX_API_SECRET;
    } else {
      process.env.CONVEX_API_SECRET = previousConvexApiSecret;
    }

    if (previousConvexUrl === undefined) {
      delete process.env.CONVEX_URL;
    } else {
      process.env.CONVEX_URL = previousConvexUrl;
    }
  });

  it('sanitizes gumroad provider parsing failures without leaking credentials', async () => {
    const leakedToken = 'secret-live-1234567890';
    fetchProductsMock.mockRejectedValueOnce(
      new Error(`Unexpected token < in JSON while parsing access_token=${leakedToken}`)
    );

    const response = await handleProviderProducts(
      new Request('https://api.example.com/api/gumroad/products', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          apiSecret: 'convex-secret',
          authUserId: 'creator-user',
        }),
      }),
      'gumroad'
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      products: [],
      error: 'Could not load gumroad products right now.',
    });

    expect(errorMock).toHaveBeenCalledTimes(1);
    const [_message, meta] = errorMock.mock.calls[0] ?? [];
    expect(JSON.stringify(meta)).not.toContain(leakedToken);
  });

  it('loads collaborator products when the creator has no owner credential', async () => {
    getCredentialMock.mockResolvedValueOnce(null);
    fetchProductsMock.mockResolvedValueOnce([
      {
        id: 'collaborator-product',
        name: 'Collaborator Product',
        collaboratorName: 'Shared Store',
      },
    ]);
    getProviderRuntimeMock.mockReturnValueOnce({
      needsCredential: true,
      supportsCollab: true,
      getCredential: getCredentialMock,
      fetchProducts: fetchProductsMock,
    });

    const response = await handleProviderProducts(
      new Request('https://api.example.com/api/jinxxy/products', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          apiSecret: 'convex-secret',
          authUserId: 'creator-without-store',
        }),
      }),
      'jinxxy'
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      products: [
        {
          id: 'collaborator-product',
          name: 'Collaborator Product',
          collaboratorName: 'Shared Store',
        },
      ],
    });
    expect(fetchProductsMock).toHaveBeenCalledWith(
      null,
      expect.objectContaining({ authUserId: 'creator-without-store' })
    );
  });
});
