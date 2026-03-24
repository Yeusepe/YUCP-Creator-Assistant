type CapabilityState = {
  capabilityKey: string;
  status: string;
};

function normalizeEntitlementStatus(status: string | null | undefined): string {
  switch ((status ?? '').trim().toLowerCase()) {
    case 'active':
      return 'active';
    case 'grace':
      return 'grace';
    case 'suspended':
      return 'suspended';
    default:
      return 'inactive';
  }
}

export function projectWorkspaceCapabilities(args: {
  includedCapabilityKeys: string[];
  entitlementStatus?: string | null;
  storedCapabilities: CapabilityState[];
}): CapabilityState[] {
  const includedKeys = new Set(
    args.includedCapabilityKeys
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
  );
  const projectedStatus = normalizeEntitlementStatus(args.entitlementStatus);
  const allKeys = new Set<string>(includedKeys);

  for (const capability of args.storedCapabilities) {
    const capabilityKey = capability?.capabilityKey?.trim();
    if (capabilityKey) {
      allKeys.add(capabilityKey);
    }
  }

  return [...allKeys]
    .sort((left, right) => left.localeCompare(right))
    .map((capabilityKey) => ({
      capabilityKey,
      status: includedKeys.has(capabilityKey) ? projectedStatus : 'inactive',
    }));
}
