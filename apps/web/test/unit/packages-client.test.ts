import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiClientGetMock = vi.hoisted(() => vi.fn());

vi.mock('@/api/client', () => ({
  apiClient: {
    get: apiClientGetMock,
  },
}));

import { listCreatorPackagePickerProducts, listCreatorPackageProducts } from '@/lib/packages';

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
      params: { configured: 'true', limit: '25' },
    });
  });

  it('collapses provider records that share one linked package identity', async () => {
    const firstUploadProduct = {
      _id: 'catalog_product_gumroad',
      aliases: ['Avatar Bundle'],
      canonicalSlug: 'gumroad-avatar-bundle',
      catalogTiers: [],
      displayName: 'Avatar Bundle',
      packageId: 'com.creator.avatar-bundle',
      productId: 'gumroad-avatar-bundle',
      provider: 'gumroad',
      providerProductRef: 'gumroad-ref',
      status: 'active' as const,
      supportsAutoDiscovery: true,
      createdAt: 1,
      updatedAt: 2,
      canArchive: true,
      canRestore: false,
      canDelete: true,
    };
    const sameProductFromAnotherStore = {
      ...firstUploadProduct,
      _id: 'catalog_product_jinxxy',
      canonicalSlug: 'jinxxy-avatar-bundle',
      displayName: 'Avatar Bundle on Jinxxy',
      productId: 'jinxxy-avatar-bundle',
      provider: 'jinxxy',
      providerProductRef: 'jinxxy-ref',
    };
    apiClientGetMock
      .mockResolvedValueOnce({
        data: [firstUploadProduct],
        hasMore: true,
        nextCursor: 'picker-page-2',
      })
      .mockResolvedValueOnce({
        data: [sameProductFromAnotherStore],
        hasMore: false,
        nextCursor: null,
      });

    const pickerProducts = await listCreatorPackagePickerProducts();

    expect(apiClientGetMock).toHaveBeenNthCalledWith(1, '/api/creator/packages', {
      params: { configured: 'false', limit: '100' },
    });
    expect(apiClientGetMock).toHaveBeenNthCalledWith(2, '/api/creator/packages', {
      params: { configured: 'false', cursor: 'picker-page-2', limit: '100' },
    });
    expect(pickerProducts).toHaveLength(1);
    expect(pickerProducts[0]?.products.map((product) => product.provider)).toEqual([
      'gumroad',
      'jinxxy',
    ]);
    expect(pickerProducts[0]?.products.map((product) => product._id)).toEqual([
      'catalog_product_gumroad',
      'catalog_product_jinxxy',
    ]);
  });

  it('keeps matching cross-store products separate until explicit association', async () => {
    const sharedFields = {
      aliases: ['Shared display label'],
      catalogTiers: [],
      displayName: 'Shared display label',
      status: 'active' as const,
      supportsAutoDiscovery: true,
      createdAt: 1,
      updatedAt: 2,
      canArchive: true,
      canRestore: false,
      canDelete: true,
    };
    apiClientGetMock.mockResolvedValueOnce({
      data: [
        {
          ...sharedFields,
          _id: 'catalog_product_distinct_a',
          canonicalSlug: 'first-product',
          productId: 'first-product',
          provider: 'gumroad',
          providerProductRef: 'gumroad-first-ref',
        },
        {
          ...sharedFields,
          _id: 'catalog_product_distinct_b',
          canonicalSlug: 'second-product',
          productId: 'second-product',
          provider: 'jinxxy',
          providerProductRef: 'jinxxy-second-ref',
        },
      ],
      hasMore: false,
      nextCursor: null,
    });

    const pickerProducts = await listCreatorPackagePickerProducts();

    expect(pickerProducts).toHaveLength(2);
    expect(pickerProducts.map((entry) => entry.identityKey)).toEqual([
      'catalog:catalog_product_distinct_a',
      'catalog:catalog_product_distinct_b',
    ]);
  });

  it('does not merge two products from the same provider by display name', async () => {
    const sharedFields = {
      aliases: ['Shared display label'],
      catalogTiers: [],
      displayName: 'Shared display label',
      provider: 'gumroad',
      status: 'active' as const,
      supportsAutoDiscovery: true,
      createdAt: 1,
      updatedAt: 2,
      canArchive: true,
      canRestore: false,
      canDelete: true,
    };
    apiClientGetMock.mockResolvedValueOnce({
      data: [
        {
          ...sharedFields,
          _id: 'catalog_product_same_provider_a',
          canonicalSlug: 'first-product',
          productId: 'first-product',
          providerProductRef: 'gumroad-first-ref',
        },
        {
          ...sharedFields,
          _id: 'catalog_product_same_provider_b',
          canonicalSlug: 'second-product',
          productId: 'second-product',
          providerProductRef: 'gumroad-second-ref',
        },
      ],
      hasMore: false,
      nextCursor: null,
    });

    const pickerProducts = await listCreatorPackagePickerProducts();

    expect(pickerProducts).toHaveLength(2);
    expect(pickerProducts.map((entry) => entry.identityKey)).toEqual([
      'catalog:catalog_product_same_provider_a',
      'catalog:catalog_product_same_provider_b',
    ]);
  });

  it('keeps a never-uploaded product available under its catalog identity', async () => {
    apiClientGetMock.mockResolvedValueOnce({
      data: [
        {
          _id: 'catalog_product_first_upload',
          aliases: ['First Upload Product'],
          canonicalSlug: 'first-upload-product',
          catalogTiers: [],
          displayName: 'First Upload Product',
          productId: 'first-upload-product',
          provider: 'gumroad',
          providerProductRef: 'first-upload-ref',
          status: 'active' as const,
          supportsAutoDiscovery: true,
          createdAt: 1,
          updatedAt: 2,
          canArchive: true,
          canRestore: false,
          canDelete: true,
        },
      ],
      hasMore: false,
      nextCursor: null,
    });

    await expect(listCreatorPackagePickerProducts()).resolves.toEqual([
      {
        identityKey: 'catalog:catalog_product_first_upload',
        products: [expect.objectContaining({ _id: 'catalog_product_first_upload' })],
      },
    ]);
  });
});
