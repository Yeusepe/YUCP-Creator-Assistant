import { createApplicationServices } from '@yucp/application';
import type { ProviderLinkFallbackDisplay } from '@yucp/application/ports';
import { getVerificationConfig } from '../verification/verificationConfig';
import { ALL_PROVIDER_RUNTIMES } from './index';
import type { ConnectDisplayMeta } from './types';

export interface ProviderDisplaySummary {
  readonly id: string;
  readonly label: string;
  readonly icon: string | null;
  readonly color: string | null;
  readonly description: string | null;
}

export interface DashboardProviderSummary {
  readonly key: string;
  readonly label: string;
  readonly icon: string;
  readonly iconBg: string;
  readonly quickStartBg: string;
  readonly quickStartBorder: string;
  readonly serverTileHint: string;
  readonly connectPath: string;
  readonly connectParamStyle: ConnectDisplayMeta['dashboardConnectParamStyle'];
}

const VERIFICATION_ONLY_PROVIDER_DISPLAY: Readonly<Record<string, ProviderLinkFallbackDisplay>> = {
  discord: { icon: 'Discord.png', color: '#5865F2' },
};

function buildRuntimeConnectSurface(provider: { id: string; displayMeta?: ConnectDisplayMeta }) {
  const displayMeta = provider.displayMeta;
  if (!displayMeta) return undefined;

  return {
    providerKey: provider.id,
    label: displayMeta.label,
    icon: displayMeta.icon,
    color: displayMeta.color,
    description: displayMeta.description,
    dashboardConnectPath: displayMeta.dashboardConnectPath,
    dashboardConnectParamStyle: displayMeta.dashboardConnectParamStyle,
    dashboardIconBg: displayMeta.dashboardIconBg,
    dashboardQuickStartBg: displayMeta.dashboardQuickStartBg,
    dashboardQuickStartBorder: displayMeta.dashboardQuickStartBorder,
    dashboardServerTileHint: displayMeta.dashboardServerTileHint,
  };
}

const runtimeConnectSurfaces = ALL_PROVIDER_RUNTIMES.flatMap((provider) => {
  const runtimeSurface = buildRuntimeConnectSurface(provider);
  return runtimeSurface ? [runtimeSurface] : [];
});

const providerPlatformService = createApplicationServices({
  providerPlatform: {
    listRuntimeConnectSurfaces: () => runtimeConnectSurfaces,
    getRuntimeConnectSurface: (providerKey) =>
      runtimeConnectSurfaces.find((runtimeSurface) => runtimeSurface.providerKey === providerKey),
    isVerificationAvailable: (providerKey) => getVerificationConfig(providerKey) !== null,
    getVerificationOnlyDisplay: (providerKey) => VERIFICATION_ONLY_PROVIDER_DISPLAY[providerKey],
  },
}).providerPlatform;

export function getConnectedAccountProviderDisplay(providerKey: string): ProviderDisplaySummary {
  return providerPlatformService.getConnectedAccountProviderDisplay(providerKey);
}

export function listUserLinkProviderDisplays(): ProviderDisplaySummary[] {
  return providerPlatformService.listUserLinkProviderDisplays();
}

export function listDashboardProviderDisplays(): DashboardProviderSummary[] {
  return providerPlatformService.listDashboardProviderDisplays();
}
