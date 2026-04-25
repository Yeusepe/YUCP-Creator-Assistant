import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';

const getProviderRuntimeMock = mock(() => ({
  needsCredential: false,
  getCredential: mock(async () => null),
  tiers: {
    listProductTiers: mock(async () => []),
  },
}));

mock.module('../providers/index', () => ({
  getProviderRuntime: getProviderRuntimeMock,
}));

const { handleProviderTiers } = await import('./tiers');

describe('handleProviderTiers', () => {
  beforeEach(() => {
    getProviderRuntimeMock.mockClear();
  });

  afterAll(() => {
    mock.restore();
  });

  it('returns 400 when the request body is invalid JSON', async () => {
    const response = await handleProviderTiers(
      new Request('https://api.example.com/api/patreon/tiers', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: '{invalid-json',
      }),
      'patreon'
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'Invalid JSON body',
    });
  });
});
