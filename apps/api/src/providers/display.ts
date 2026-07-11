import { createApplicationServices } from '@yucp/application';
import type { ProviderLinkFallbackDisplay } from '@yucp/application/ports';
import { getVerificationConfig } from '../verification/verificationConfig';
import { ALL_PROVIDER_RUNTIMES } from './index';
import type { ConnectDisplayMeta } from './types';

const VERIFICATION_ONLY_PROVIDER_DISPLAY: Readonly<Record<string, ProviderLinkFallbackDisplay>> = {
  discord: { icon: 'Discord.png', color: '#5865F2' },
};

function buildRuntimeConnectSurface(provider: { id: string; displayMeta?: ConnectDisplayMeta }) {
  const displayMeta = provider.displayMeta;
  if (!displayMeta) return undefined;

  return {
    providerKey: provider.id,
    label: displayMeta.label,
    dashboardSetupExperience: displayMeta.dashboardSetupExperience,
    dashboardSetupHint: displayMeta.dashboardSetupHint,
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

export const providerPlatformService = createApplicationServices({
  providerPlatform: {
    listRuntimeConnectSurfaces: () => runtimeConnectSurfaces,
    getRuntimeConnectSurface: (providerKey) =>
      runtimeConnectSurfaces.find((runtimeSurface) => runtimeSurface.providerKey === providerKey),
    isVerificationAvailable: (providerKey) => getVerificationConfig(providerKey) !== null,
    getVerificationOnlyDisplay: (providerKey) => VERIFICATION_ONLY_PROVIDER_DISPLAY[providerKey],
  },
}).providerPlatform;
