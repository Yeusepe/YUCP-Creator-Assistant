import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiClientGetMock = vi.hoisted(() => vi.fn());

vi.mock('@/api/client', () => ({
  apiClient: {
    get: apiClientGetMock,
  },
}));

import { listCreatorPackageProducts } from '@/lib/packages';

describe('creator package client pagination', () => {
  beforeEach(() => {
    apiClientGetMock.mockReset();
  });

  it('fetches one bounded page instead of draining every catalog page', async () => {
    const firstPage = {
      data: [{ _id: 'catalog_product_1', displayName: 'First configured product' }],
      hasMore: true,
      nextCursor: 'next-page',
    };
    apiClientGetMock.mockResolvedValueOnce(firstPage).mockResolvedValueOnce({
      data: [{ _id: 'catalog_product_2', displayName: 'Second configured product' }],
      hasMore: false,
      nextCursor: null,
    });

    await expect(listCreatorPackageProducts({ limit: 25 })).resolves.toEqual(firstPage);
    expect(apiClientGetMock).toHaveBeenCalledTimes(1);
    expect(apiClientGetMock).toHaveBeenCalledWith('/api/creator/packages', {
      params: { limit: '25' },
    });
  });
});
