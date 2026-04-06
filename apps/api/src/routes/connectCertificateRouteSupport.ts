function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid request body');
  }

  return value as Record<string, unknown>;
}

function getOptionalTrimmedString(
  record: Record<string, unknown>,
  key: string
): string | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error('Invalid request body');
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function parseCertificatePlanSelectionBody(value: unknown): {
  productId?: string;
  planKey?: string;
} {
  const record = asObject(value);
  const productId = getOptionalTrimmedString(record, 'productId');
  const planKey = getOptionalTrimmedString(record, 'planKey');

  if (!productId && !planKey) {
    throw new Error('productId or planKey is required');
  }

  return {
    ...(productId ? { productId } : {}),
    ...(planKey ? { planKey } : {}),
  };
}

export function parseCertificateRevokeBody(value: unknown): { certNonce: string } {
  const record = asObject(value);
  const certNonce = getOptionalTrimmedString(record, 'certNonce');

  if (!certNonce) {
    throw new Error('certNonce is required');
  }

  return { certNonce };
}
