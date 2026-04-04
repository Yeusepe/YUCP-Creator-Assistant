import { getProviderDescriptor, PROVIDER_KEYS } from '@yucp/shared';
import { getVerificationConfig } from '../verification/sessionManager';
import { ALL_PROVIDERS, getProvider } from './index';
import type { ConnectDisplayMeta, ProviderPlugin } from './types';

type ProviderKey = (typeof PROVIDER_KEYS)[number];

interface VerificationOnlyProviderDisplay {
  readonly icon: string | null;
  readonly color: string | null;
  readonly description?: string | null;
}

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

const VERIFICATION_ONLY_PROVIDER_DISPLAY: Partial<
  Record<ProviderKey, VerificationOnlyProviderDisplay>
> = {
  discord: { icon: 'Discord.png', color: '#5865F2' },
};

function buildProviderDisplaySummary(
  providerKey: string,
  displayMeta?: ConnectDisplayMeta,
  fallbackDisplay?: VerificationOnlyProviderDisplay
): ProviderDisplaySummary {
  const descriptor = getProviderDescriptor(providerKey);

  return {
    id: providerKey,
    label: displayMeta?.label ?? descriptor?.label ?? providerKey,
    icon: displayMeta?.icon ?? fallbackDisplay?.icon ?? null,
    color: displayMeta?.color ?? fallbackDisplay?.color ?? null,
    description: displayMeta?.description ?? fallbackDisplay?.description ?? null,
  };
}

function buildDashboardProviderSummary(provider: ProviderPlugin): DashboardProviderSummary | null {
  const displayMeta = provider.displayMeta;
  if (!displayMeta?.dashboardConnectPath) return null;

  return {
    key: provider.id,
    label: displayMeta.label,
    icon: displayMeta.icon,
    iconBg: displayMeta.dashboardIconBg,
    quickStartBg: displayMeta.dashboardQuickStartBg,
    quickStartBorder: displayMeta.dashboardQuickStartBorder,
    serverTileHint: displayMeta.dashboardServerTileHint,
    connectPath: displayMeta.dashboardConnectPath,
    connectParamStyle: displayMeta.dashboardConnectParamStyle,
  };
}

export function getConnectedAccountProviderDisplay(providerKey: string): ProviderDisplaySummary {
  return buildProviderDisplaySummary(providerKey, getProvider(providerKey)?.displayMeta);
}

export function listUserLinkProviderDisplays(): ProviderDisplaySummary[] {
  const seenIds = new Set<string>();
  const providers: ProviderDisplaySummary[] = [];

  for (const provider of ALL_PROVIDERS) {
    const descriptor = getProviderDescriptor(provider.id);
    const supportsOAuthLink =
      descriptor?.supportsOAuth === true && getVerificationConfig(provider.id) !== null;
    if (!provider.displayMeta || !supportsOAuthLink) continue;

    seenIds.add(provider.id);
    providers.push(buildProviderDisplaySummary(provider.id, provider.displayMeta));
  }

  for (const providerKey of PROVIDER_KEYS) {
    if (seenIds.has(providerKey)) continue;
    if (getVerificationConfig(providerKey) === null) continue;

    const descriptor = getProviderDescriptor(providerKey);
    if (!descriptor?.supportsOAuth) continue;

    seenIds.add(providerKey);
    providers.push(
      buildProviderDisplaySummary(
        providerKey,
        undefined,
        VERIFICATION_ONLY_PROVIDER_DISPLAY[providerKey]
      )
    );
  }

  return providers;
}

export function listDashboardProviderDisplays(): DashboardProviderSummary[] {
  return ALL_PROVIDERS.flatMap((provider) => {
    const summary = buildDashboardProviderSummary(provider);
    return summary ? [summary] : [];
  });
}
