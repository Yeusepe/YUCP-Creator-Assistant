/**
 * Stable runtime configuration contracts for verification flows.
 *
 * Provider-owned OAuth metadata now lives with each provider's buyer-link
 * plugin. This file only carries shared runtime config and generic lookup
 * helpers so verification callers do not hard-code providers.
 */

import { getBuyerLinkPluginByMode } from '../providers';
import type { BuyerLinkOAuthConfig } from '../providers/types';

export interface VerificationConfig {
  /** Base URL for the API */
  baseUrl: string;
  /** Frontend URL for redirects */
  frontendUrl: string;
  /** Convex URL for backend calls */
  convexUrl: string;
  /** Convex API secret for authenticated mutations */
  convexApiSecret: string;
  /** Gumroad client ID */
  gumroadClientId?: string;
  /** Gumroad client secret */
  gumroadClientSecret?: string;
  /** Discord client ID */
  discordClientId?: string;
  /** Discord client secret */
  discordClientSecret?: string;
  /** Jinxxy client ID */
  jinxxyClientId?: string;
  /** Jinxxy client secret */
  jinxxyClientSecret?: string;
  /** Secret for decrypting tenant-stored keys (e.g. Jinxxy API key) */
  encryptionSecret?: string;
  /**
   * Generic OAuth client IDs for additional providers.
   * Keys are verification modes (e.g. 'itchio'); values are client IDs.
   */
  providerClientIds?: Record<string, string>;
  /**
   * Generic OAuth client secrets for additional providers.
   * Keys are verification modes; values are client secrets.
   */
  providerClientSecrets?: Record<string, string>;
  /**
   * Extra OAuth query params per mode.
   */
  providerExtraOAuthParams?: Record<string, Record<string, string>>;
}

export type VerificationModeConfig = BuyerLinkOAuthConfig;

export function getVerificationConfig(mode: string): VerificationModeConfig | null {
  return getBuyerLinkPluginByMode(mode)?.oauth ?? null;
}
