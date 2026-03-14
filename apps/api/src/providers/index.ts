/**
 * Provider registry
 *
 * To add a new provider:
 * 1. Create apps/api/src/providers/{name}.ts implementing ProviderPlugin
 * 2. Add an import below and include it in ALL_PROVIDERS
 * That's it — route handlers require no changes.
 */

import gumroad from './gumroad/index';
import jinxxy from './jinxxy/index';
import lemonsqueezy from './lemonsqueezy/index';
import payhip from './payhip/index';
import type { ProviderPlugin } from './types';

const ALL_PROVIDERS: ProviderPlugin[] = [gumroad, jinxxy, lemonsqueezy, payhip];

export const PROVIDERS: ReadonlyMap<string, ProviderPlugin> = new Map(
  ALL_PROVIDERS.map((p) => [p.id, p])
);

export function getProvider(id: string): ProviderPlugin | undefined {
  return PROVIDERS.get(id);
}
