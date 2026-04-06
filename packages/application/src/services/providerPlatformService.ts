import { getProviderDescriptor, PROVIDER_KEYS } from '@yucp/providers/providerMetadata';
import type {
  ProviderLinkFallbackDisplay,
  ProviderPlatformPort,
  ProviderRuntimeConnectSurface,
} from '../ports/providerPlatform';

export interface ConnectedAccountProviderDisplay {
  readonly id: string;
  readonly label: string;
  readonly icon: string | null;
  readonly color: string | null;
  readonly description: string | null;
}

export interface DashboardProviderDisplay {
  readonly key: string;
  readonly label: string;
  readonly icon: string;
  readonly iconBg: string;
  readonly quickStartBg: string;
  readonly quickStartBorder: string;
  readonly serverTileHint: string;
  readonly connectPath: string;
  readonly connectParamStyle: 'camelCase' | 'snakeCase';
}

function buildConnectedAccountProviderDisplay(
  providerKey: string,
  runtimeSurface?: ProviderRuntimeConnectSurface,
  fallbackDisplay?: ProviderLinkFallbackDisplay
): ConnectedAccountProviderDisplay {
  const descriptor = getProviderDescriptor(providerKey);

  return {
    id: providerKey,
    label: runtimeSurface?.label ?? descriptor?.label ?? providerKey,
    icon: runtimeSurface?.icon ?? fallbackDisplay?.icon ?? null,
    color: runtimeSurface?.color ?? fallbackDisplay?.color ?? null,
    description: runtimeSurface?.description ?? fallbackDisplay?.description ?? null,
  };
}

function buildDashboardProviderDisplay(
  runtimeSurface: ProviderRuntimeConnectSurface
): DashboardProviderDisplay | null {
  if (
    !runtimeSurface.dashboardConnectPath ||
    !runtimeSurface.dashboardConnectParamStyle ||
    !runtimeSurface.dashboardIconBg ||
    !runtimeSurface.dashboardQuickStartBg ||
    !runtimeSurface.dashboardQuickStartBorder ||
    !runtimeSurface.dashboardServerTileHint
  ) {
    return null;
  }

  return {
    key: runtimeSurface.providerKey,
    label: runtimeSurface.label,
    icon: runtimeSurface.icon,
    iconBg: runtimeSurface.dashboardIconBg,
    quickStartBg: runtimeSurface.dashboardQuickStartBg,
    quickStartBorder: runtimeSurface.dashboardQuickStartBorder,
    serverTileHint: runtimeSurface.dashboardServerTileHint,
    connectPath: runtimeSurface.dashboardConnectPath,
    connectParamStyle: runtimeSurface.dashboardConnectParamStyle,
  };
}

export class ProviderPlatformService {
  constructor(private readonly providerPlatformPort: ProviderPlatformPort) {}

  getConnectedAccountProviderDisplay(providerKey: string): ConnectedAccountProviderDisplay {
    return buildConnectedAccountProviderDisplay(
      providerKey,
      this.providerPlatformPort.getRuntimeConnectSurface(providerKey)
    );
  }

  listUserLinkProviderDisplays(): ConnectedAccountProviderDisplay[] {
    const seenProviderKeys = new Set<string>();
    const providers: ConnectedAccountProviderDisplay[] = [];

    for (const runtimeSurface of this.providerPlatformPort.listRuntimeConnectSurfaces()) {
      const descriptor = getProviderDescriptor(runtimeSurface.providerKey);
      if (!descriptor?.supportsOAuth) continue;
      if (!this.providerPlatformPort.isVerificationAvailable(runtimeSurface.providerKey)) continue;

      seenProviderKeys.add(runtimeSurface.providerKey);
      providers.push(
        buildConnectedAccountProviderDisplay(runtimeSurface.providerKey, runtimeSurface, undefined)
      );
    }

    for (const providerKey of PROVIDER_KEYS) {
      if (seenProviderKeys.has(providerKey)) continue;
      const descriptor = getProviderDescriptor(providerKey);
      if (!descriptor?.supportsOAuth) continue;
      if (!this.providerPlatformPort.isVerificationAvailable(providerKey)) continue;

      seenProviderKeys.add(providerKey);
      providers.push(
        buildConnectedAccountProviderDisplay(
          providerKey,
          undefined,
          this.providerPlatformPort.getVerificationOnlyDisplay(providerKey)
        )
      );
    }

    return providers;
  }

  listDashboardProviderDisplays(): DashboardProviderDisplay[] {
    return this.providerPlatformPort.listRuntimeConnectSurfaces().flatMap((runtimeSurface) => {
      const providerDisplay = buildDashboardProviderDisplay(runtimeSurface);
      return providerDisplay ? [providerDisplay] : [];
    });
  }
}
