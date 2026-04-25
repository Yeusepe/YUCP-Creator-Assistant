export function normalizeProviderTiers(
  tiers:
    | Array<{
        active?: boolean;
        amountCents?: bigint | number;
        currency?: string;
        description?: string;
        id?: string;
        name?: string;
        productId?: string;
      }>
    | undefined
): Array<{
  active: boolean;
  amountCents?: number;
  currency?: string;
  description?: string;
  id: string;
  name: string;
  productId: string;
}> {
  return (tiers ?? []).map((tier) => ({
    id: tier.id ?? '',
    productId: tier.productId ?? '',
    name: tier.name ?? tier.id ?? 'Unknown tier',
    description: tier.description,
    amountCents:
      typeof tier.amountCents === 'bigint'
        ? Number(tier.amountCents)
        : typeof tier.amountCents === 'number'
          ? tier.amountCents
          : undefined,
    currency: tier.currency,
    active: tier.active ?? false,
  }));
}
