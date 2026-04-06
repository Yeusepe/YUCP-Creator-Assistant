export interface ProviderRuntimeConnectSurface {
  readonly providerKey: string;
  readonly label: string;
  readonly icon: string;
  readonly color: string;
  readonly description: string;
  readonly dashboardConnectPath?: string;
  readonly dashboardConnectParamStyle?: 'camelCase' | 'snakeCase';
  readonly dashboardIconBg?: string;
  readonly dashboardQuickStartBg?: string;
  readonly dashboardQuickStartBorder?: string;
  readonly dashboardServerTileHint?: string;
}

export interface ProviderLinkFallbackDisplay {
  readonly icon: string | null;
  readonly color: string | null;
  readonly description?: string | null;
}

export interface ProviderPlatformPort {
  listRuntimeConnectSurfaces(): readonly ProviderRuntimeConnectSurface[];
  getRuntimeConnectSurface(providerKey: string): ProviderRuntimeConnectSurface | undefined;
  isVerificationAvailable(providerKey: string): boolean;
  getVerificationOnlyDisplay(providerKey: string): ProviderLinkFallbackDisplay | undefined;
}
