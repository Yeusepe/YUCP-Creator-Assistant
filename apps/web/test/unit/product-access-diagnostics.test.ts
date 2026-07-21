import { describe, expect, it } from 'vitest';
import {
  buildBuyerProductAccessDiagnosticContext,
  createBuyerProductAccessDiagnosticError,
} from '@/lib/productAccessDiagnostics';

describe('buyer product access diagnostics', () => {
  it('records lookup shape without public tenant or product references', () => {
    const catalogProductId = 'private-catalog-reference-never-log';
    const creatorRef = 'private-creator-reference-never-log';
    const context = buildBuyerProductAccessDiagnosticContext({ catalogProductId, creatorRef });
    const serialized = JSON.stringify(context);

    expect(context).toEqual({ lookupMode: 'creator-scoped' });
    expect(serialized).not.toContain(catalogProductId);
    expect(serialized).not.toContain(creatorRef);
    const safeError = createBuyerProductAccessDiagnosticError();
    expect(safeError.message).toBe('Buyer product access request failed');
  });
});
