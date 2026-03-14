/**
 * Connect Plugin Registry
 *
 * This is the ONLY file to touch when adding a new provider's connect flow.
 * Import the plugin and add it to the array — nothing else changes.
 */

import gumroadConnect from './gumroad';
import jinxxyConnect from './jinxxy';
import lemonsqueezyConnect from './lemonsqueezy';
import payhipConnect from './payhip';
import type { ConnectPlugin } from './types';

export const CONNECT_PLUGINS: ReadonlyArray<ConnectPlugin> = [
  gumroadConnect,
  jinxxyConnect,
  lemonsqueezyConnect,
  payhipConnect,
];
