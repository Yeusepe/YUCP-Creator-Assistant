import { createServerFn } from '@tanstack/react-start';
import {
  buildBuyerProductAccessDiagnosticContext,
  createBuyerProductAccessDiagnosticError,
} from '../productAccessDiagnostics';
import type { BuyerProductAccessResponse } from '../productAccessTypes';
import { logWebError } from '../webDiagnostics';
import { serverApiFetch } from './api-client';
import { withWebServerRequestSpan } from './observability';

interface BuyerProductAccessRequest {
  catalogProductId: string;
  creatorRef?: string;
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
  const creatorRef = (data as Partial<BuyerProductAccessRequest>).creatorRef;
  if (creatorRef === undefined) {
    return { catalogProductId: normalized };
  }
  if (typeof creatorRef !== 'string') {
    throw new Error('creatorRef is invalid');
  }
  const normalizedCreatorRef = creatorRef.trim();
  if (
    normalizedCreatorRef.length === 0 ||
    normalizedCreatorRef.length > 256 ||
    normalizedCreatorRef.includes('/')
  ) {
    throw new Error('creatorRef is invalid');
  }
  return { catalogProductId: normalized, creatorRef: normalizedCreatorRef };
}

export const fetchBuyerProductAccess = createServerFn({ method: 'GET' })
  .inputValidator(validateBuyerProductAccessRequest)
  .handler(
    async ({ data }: { data: BuyerProductAccessRequest }): Promise<BuyerProductAccessResponse> => {
      const diagnosticContext = buildBuyerProductAccessDiagnosticContext(data);
      return withWebServerRequestSpan(
        'serverFn.product-access.buyer',
        {
          'tanstack.serverfn': 'fetchBuyerProductAccess',
          'buyer.lookup_mode': diagnosticContext.lookupMode,
        },
        async () => {
          try {
            const creatorQuery = data.creatorRef
              ? `?${new URLSearchParams({ creator_ref: data.creatorRef })}`
              : '';
            return await serverApiFetch<BuyerProductAccessResponse>(
              `/api/connect/user/product-access/${encodeURIComponent(data.catalogProductId)}${creatorQuery}`
            );
          } catch (error) {
            logWebError(
              'Buyer product access load failed',
              createBuyerProductAccessDiagnosticError(),
              diagnosticContext
            );
            throw error;
          }
        }
      );
    }
  );
