function normalizeOrigin(value: string): string {
  return new URL(value).origin;
}

export function validateCouplingServiceBaseUrl(config: {
  apiBaseUrl: string;
  convexSiteUrl?: string;
  couplingServiceBaseUrl?: string;
}): void {
  const couplingServiceBaseUrl = config.couplingServiceBaseUrl?.trim();
  if (!couplingServiceBaseUrl) {
    return;
  }

  const couplingOrigin = normalizeOrigin(couplingServiceBaseUrl);
  const apiOrigin = normalizeOrigin(config.apiBaseUrl);
  if (couplingOrigin === apiOrigin) {
    throw new Error(
      'YUCP_COUPLING_SERVICE_BASE_URL must point at the private coupling service, not the public API origin'
    );
  }

  const convexSiteUrl = config.convexSiteUrl?.trim();
  if (convexSiteUrl && couplingOrigin === normalizeOrigin(convexSiteUrl)) {
    throw new Error(
      'YUCP_COUPLING_SERVICE_BASE_URL must point at the private coupling service, not the Convex site origin'
    );
  }
}
