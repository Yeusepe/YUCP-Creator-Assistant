interface BuyerProductAccessDiagnosticInput {
  catalogProductId: string;
  creatorRef?: string;
}

export interface BuyerProductAccessDiagnosticContext extends Record<string, unknown> {
  lookupMode: 'catalog-id' | 'creator-scoped';
}

export function buildBuyerProductAccessDiagnosticContext(
  input: BuyerProductAccessDiagnosticInput
): BuyerProductAccessDiagnosticContext {
  return { lookupMode: input.creatorRef ? 'creator-scoped' : 'catalog-id' };
}

export function createBuyerProductAccessDiagnosticError(): Error {
  return new Error('Buyer product access request failed');
}
