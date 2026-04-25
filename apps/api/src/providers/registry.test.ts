/**
 * Provider registry invariant tests
 *
 * These tests enforce that every runtime provider is fully configured
 * for the dashboard. They are intentionally exhaustive so that adding a new
 * provider without filling in all required display metadata fails immediately.
 *
 * Why these tests exist:
 * The dashboard provider list is now driven dynamically from ALL_PROVIDER_RUNTIMES via
 * GET /api/providers. If a runtime is added to ALL_PROVIDER_RUNTIMES but omits
 * displayMeta (or any dashboard field), the provider silently vanishes from
 * the dashboard UI with no build-time or runtime error. These tests turn that
 * silent omission into a loud test failure.
 */

import { describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getProviderDescriptor, PROVIDER_REGISTRY } from '@yucp/providers/providerMetadata';
import { RUNTIME_PROVIDER_KEYS } from '@yucp/providers/types';
import { getVerificationConfig } from '../verification/verificationConfig';
import {
  ALL_PROVIDER_RUNTIMES,
  getBuyerLinkPluginByMode,
  listBuyerLinkPlugins,
  PROVIDER_RUNTIMES,
} from './index';
import type { ConnectDisplayMeta } from './types';

const ICONS_DIR = join(import.meta.dir, '../../public/Icons');

const REQUIRED_DISPLAY_META_FIELDS: Array<keyof ConnectDisplayMeta> = [
  'label',
  'icon',
  'color',
  'shadowColor',
  'textColor',
  'connectedColor',
  'confettiColors',
  'description',
  'dashboardConnectPath',
  'dashboardConnectParamStyle',
  'dashboardIconBg',
  'dashboardQuickStartBg',
  'dashboardQuickStartBorder',
  'dashboardServerTileHint',
];

describe('provider plugin registry', () => {
  it('every registered provider has displayMeta with all required fields populated', () => {
    const problems: string[] = [];

    for (const provider of ALL_PROVIDER_RUNTIMES) {
      if (!provider.displayMeta) {
        problems.push(`${provider.id}: displayMeta is missing entirely`);
        continue;
      }

      for (const field of REQUIRED_DISPLAY_META_FIELDS) {
        const value = provider.displayMeta[field];
        const isEmpty = Array.isArray(value) ? value.length === 0 : !value;
        if (isEmpty) {
          problems.push(`${provider.id}.displayMeta.${String(field)} is empty or missing`);
        }
      }
    }

    expect(problems).toEqual([]);
  });

  it('every provider icon file referenced in displayMeta exists in public/Icons/', () => {
    const missing: string[] = [];

    for (const provider of ALL_PROVIDER_RUNTIMES) {
      if (!provider.displayMeta) continue;
      const iconPath = join(ICONS_DIR, provider.displayMeta.icon);
      if (!existsSync(iconPath)) {
        missing.push(
          `${provider.id}: icon file "${provider.displayMeta.icon}" not found in public/Icons/`
        );
      }
    }

    expect(missing).toEqual([]);
  });

  it('every provider in ALL_PROVIDER_RUNTIMES has a unique id', () => {
    const ids = ALL_PROVIDER_RUNTIMES.map((p) => p.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it('keeps provider registry keys aligned with provider ids', () => {
    const providerIds = [...ALL_PROVIDER_RUNTIMES.map((provider) => provider.id)].sort();
    const registryKeys = [...PROVIDER_RUNTIMES.keys()].sort();
    expect(registryKeys).toEqual(providerIds);
  });

  it('covers every provider-owned runtime provider key exactly once', () => {
    expect([...PROVIDER_RUNTIMES.keys()].sort()).toEqual([...RUNTIME_PROVIDER_KEYS].sort());
  });

  it('routes VRChat account linking through the connect-mode setup flow', () => {
    const vrchat = ALL_PROVIDER_RUNTIMES.find((provider) => provider.id === 'vrchat');
    expect(vrchat?.displayMeta?.userSetupPath).toBe('/setup/vrchat?mode=connect');
  });

  it('keeps active buyer OAuth descriptors executable through the buyer-link registry', () => {
    const activeBuyerOAuthProviders = PROVIDER_REGISTRY.filter(
      (provider) => provider.status === 'active' && provider.supportsBuyerOAuthLink
    ).map((provider) => provider.providerKey);

    expect(
      listBuyerLinkPlugins()
        .map((plugin) => plugin.oauth.providerId)
        .sort()
    ).toEqual([...activeBuyerOAuthProviders].sort());

    for (const providerKey of activeBuyerOAuthProviders) {
      const descriptor = getProviderDescriptor(providerKey);
      const plugin = getBuyerLinkPluginByMode(providerKey);

      expect(descriptor?.buyerVerificationMethods).toContain('account_link');
      expect(plugin?.oauth.providerId).toBe(providerKey);
      expect(getVerificationConfig(providerKey)?.providerId).toBe(providerKey);
    }
  });

  it('keeps active reconciliation descriptors aligned with runtime backfill handlers', () => {
    const runtimeProviderKeys = new Set<string>(RUNTIME_PROVIDER_KEYS);
    const descriptorsWithReconciliation = PROVIDER_REGISTRY.filter(
      (provider) =>
        provider.status === 'active' &&
        runtimeProviderKeys.has(provider.providerKey) &&
        provider.capabilities.includes('reconciliation')
    ).map((provider) => provider.providerKey);

    expect(
      ALL_PROVIDER_RUNTIMES.filter(
        (provider): provider is (typeof ALL_PROVIDER_RUNTIMES)[number] & { backfill: object } =>
          'backfill' in provider && provider.backfill != null
      ).map((provider) => provider.id)
    ).toEqual(descriptorsWithReconciliation);
  });

  it('keeps active runtime license-verification descriptors backed by executable handlers', () => {
    const runtimeProviderKeys = new Set<string>(RUNTIME_PROVIDER_KEYS);
    const descriptorsWithLicenseVerification = PROVIDER_REGISTRY.filter(
      (provider) =>
        provider.status === 'active' &&
        runtimeProviderKeys.has(provider.providerKey) &&
        provider.supportsLicenseVerify
    ).map((provider) => provider.providerKey);

    const runtimesWithLicenseVerification = new Set(
      ALL_PROVIDER_RUNTIMES.filter((provider) => provider.verification != null).map(
        (provider) => provider.id
      )
    );

    for (const providerKey of descriptorsWithLicenseVerification) {
      expect(runtimesWithLicenseVerification.has(providerKey)).toBe(true);
    }
  });

  it('keeps active tier catalog descriptors aligned with runtime tier listing handlers', () => {
    const runtimeProviderKeys = new Set<string>(RUNTIME_PROVIDER_KEYS);
    const descriptorsWithTierCatalog = PROVIDER_REGISTRY.filter(
      (provider) =>
        provider.status === 'active' &&
        runtimeProviderKeys.has(provider.providerKey) &&
        provider.capabilities.includes('tier_catalog')
    ).map((provider) => provider.providerKey);

    const runtimesWithTierCatalog = new Set(
      ALL_PROVIDER_RUNTIMES.filter((provider) => provider.tiers?.listProductTiers != null).map(
        (provider) => provider.id
      )
    );

    for (const providerKey of descriptorsWithTierCatalog) {
      expect(runtimesWithTierCatalog.has(providerKey)).toBe(true);
    }
  });

  it('keeps active tier entitlement descriptors aligned with runtime tier plugins', () => {
    const runtimeProviderKeys = new Set<string>(RUNTIME_PROVIDER_KEYS);
    const descriptorsWithTierEntitlements = PROVIDER_REGISTRY.filter(
      (provider) =>
        provider.status === 'active' &&
        runtimeProviderKeys.has(provider.providerKey) &&
        provider.capabilities.includes('tier_entitlements')
    ).map((provider) => provider.providerKey);

    const runtimesWithTierPlugins = new Set(
      ALL_PROVIDER_RUNTIMES.filter((provider) => provider.tiers != null).map(
        (provider) => provider.id
      )
    );

    for (const providerKey of descriptorsWithTierEntitlements) {
      expect(runtimesWithTierPlugins.has(providerKey)).toBe(true);
    }
  });
});
