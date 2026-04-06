/**
 * API provider composition root
 *
 * Provider runtime behavior is assembled per provider module, while API-only
 * transport hooks remain in apps/api during the cutover. Keep those concerns
 * separate here so runtime consumers ask for runtime capabilities and route
 * dispatchers ask for transport hooks instead of everyone depending on one
 * god-object plugin shape.
 */

import type { RuntimeProviderKey } from '@yucp/providers/types';
import gumroad from './gumroad/index';
import jinxxy from './jinxxy/index';
import lemonsqueezy from './lemonsqueezy/index';
import payhip from './payhip/index';
import type {
  ApiProviderEntry,
  ApiProviderHooks,
  ConnectPlugin,
  ProviderRuntime,
  WebhookPlugin,
} from './types';
import vrchat from './vrchat/index';

function defineProviderRegistry<TRegistry extends Record<RuntimeProviderKey, ApiProviderEntry>>(
  registry: TRegistry
): TRegistry {
  for (const [providerKey, entry] of Object.entries(registry)) {
    if (entry.runtime.id !== providerKey) {
      throw new Error(
        `Provider registry key "${providerKey}" does not match runtime id "${entry.runtime.id}"`
      );
    }
  }
  return registry;
}

const PROVIDER_ENTRIES = defineProviderRegistry({
  gumroad,
  jinxxy,
  lemonsqueezy,
  payhip,
  vrchat,
});

export const ALL_PROVIDER_RUNTIMES = Object.freeze(
  Object.values(PROVIDER_ENTRIES).map((entry) => entry.runtime)
);

export const PROVIDER_RUNTIMES: ReadonlyMap<string, ProviderRuntime> = new Map(
  Object.entries(PROVIDER_ENTRIES).map(([providerKey, entry]) => [providerKey, entry.runtime])
);

const PROVIDER_HOOKS: ReadonlyMap<string, ApiProviderHooks> = new Map(
  Object.entries(PROVIDER_ENTRIES).map(([providerKey, entry]) => [providerKey, entry.hooks])
);

export function getProviderRuntime(id: string): ProviderRuntime | undefined {
  return PROVIDER_RUNTIMES.get(id);
}

export function getProviderHooks(id: string): ApiProviderHooks | undefined {
  return PROVIDER_HOOKS.get(id);
}

export function listConnectPlugins(): readonly ConnectPlugin[] {
  return [...PROVIDER_HOOKS.values()]
    .flatMap((hooks) => (hooks.connect ? [hooks.connect] : []))
    .sort((left, right) => left.providerId.localeCompare(right.providerId));
}

export function resolveWebhookPlugin(
  urlProvider: string
): { providerId: string; webhook: WebhookPlugin } | undefined {
  const directMatch = PROVIDER_HOOKS.get(urlProvider)?.webhook;
  if (directMatch) {
    return { providerId: urlProvider, webhook: directMatch };
  }

  for (const [providerId, hooks] of PROVIDER_HOOKS.entries()) {
    if (hooks.webhook?.extraProviders?.includes(urlProvider)) {
      return { providerId, webhook: hooks.webhook };
    }
  }

  return undefined;
}
