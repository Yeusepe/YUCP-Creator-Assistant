/**
 * License Verification Handler Registry
 *
 * Each provider that supports license-key verification registers a handler here.
 * To add a new provider: create a handler file and add one entry to HANDLERS.
 */

import type { ConvexServerClient } from '../../lib/convex';
import type { CompleteLicenseInput, CompleteLicenseResult } from '../completeLicense';
import type { VerificationConfig } from '../sessionManager';

export interface LicenseVerificationHandler {
  verify(
    input: CompleteLicenseInput,
    config: VerificationConfig,
    convex: ConvexServerClient
  ): Promise<CompleteLicenseResult>;
}

/** Registry: providerKey → handler. Add new providers here. */
export async function getHandler(provider: string): Promise<LicenseVerificationHandler | null> {
  switch (provider) {
    case 'gumroad': {
      const { gumroadHandler } = await import('./gumroad');
      return gumroadHandler;
    }
    case 'jinxxy': {
      const { jinxxyHandler } = await import('./jinxxy');
      return jinxxyHandler;
    }
    case 'lemonsqueezy': {
      const { lemonSqueezyHandler } = await import('./lemonsqueezy');
      return lemonSqueezyHandler;
    }
    default:
      return null;
  }
}
