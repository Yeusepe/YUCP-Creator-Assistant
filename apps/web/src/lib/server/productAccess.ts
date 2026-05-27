import { createServerFn } from '@tanstack/react-start';
import type { BuyerProductAccessResponse } from '../productAccessTypes';
import { logWebError } from '../webDiagnostics';
import { serverApiFetch } from './api-client';
import { withWebServerRequestSpan } from './observability';

interface BuyerProductAccessRequest {
  catalogProductId: string;
}

function validateBuyerProductAccessRequest(data: unknown): BuyerProductAccessRequest {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error('catalogProductId is required');
  }
  const catalogProductId = (data as Partial<BuyerProductAccessRequest>).catalogProductId;
  if (typeof catalogProductId !== 'string') {
    throw new Error('catalogProductId is required');
  }
  const normalized = catalogProductId.trim();
  if (normalized.length === 0 || normalized.length > 256 || normalized.includes('/')) {
    throw new Error('catalogProductId is invalid');
  }
  return { catalogProductId: normalized };
}

export const fetchBuyerProductAccess = createServerFn({ method: 'GET' })
  .inputValidator(validateBuyerProductAccessRequest)
  .handler(
    async ({ data }: { data: BuyerProductAccessRequest }): Promise<BuyerProductAccessResponse> => {
      return withWebServerRequestSpan(
        'serverFn.product-access.buyer',
        {
          'tanstack.serverfn': 'fetchBuyerProductAccess',
          'buyer.catalog_product_id': data.catalogProductId,
        },
        async () => {
          try {
            return await serverApiFetch<BuyerProductAccessResponse>(
              `/api/connect/user/product-access/${encodeURIComponent(data.catalogProductId)}`
            );
          } catch (error) {
            logWebError('Buyer product access load failed', error, {
              catalogProductId: data.catalogProductId,
            });
            throw error;
          }
        }
      );
    }
  );
