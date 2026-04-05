import type { StructuredLogger } from '@yucp/shared';
import {
  CredentialExpiredError,
  type ProductRecord,
  type ProviderContext,
  type ProviderPurposes,
  type ProviderRuntimeClient,
  type ProviderRuntimeModule,
} from '../contracts';
import { extractVrchatAvatarId, VrchatApiClient } from './client';
import { VrchatSessionExpiredError } from './types';

export const VRCHAT_PURPOSES = {
  credential: 'vrchat-creator-session',
} as const satisfies ProviderPurposes;

export const VRCHAT_DISPLAY_META = {
  label: 'VRChat®',
  icon: 'VRC.png',
  color: '#00b48c',
  shadowColor: '#00b48c',
  textColor: '#ffffff',
  connectedColor: '#008a6b',
  confettiColors: ['#00b48c', '#008a6b', '#80ffd8', '#ffffff'],
  description: 'Store',
  dashboardConnectPath: '/setup/vrchat?mode=connect',
  dashboardConnectParamStyle: 'snakeCase',
  userSetupPath: '/setup/vrchat?mode=connect',
  dashboardIconBg: '#00b48c',
  dashboardQuickStartBg: 'rgba(0,180,140,0.1)',
  dashboardQuickStartBorder: 'rgba(0,180,140,0.3)',
  dashboardServerTileHint: 'Allow users to verify VRChat avatar access in this Discord server.',
} as const;

type VrchatRuntimeLogger = Pick<StructuredLogger, 'warn'>;

export interface VrchatRuntimePorts<TClient extends ProviderRuntimeClient = ProviderRuntimeClient> {
  readonly logger: VrchatRuntimeLogger;
  getEncryptedCredential(ctx: ProviderContext<TClient>): Promise<string | null>;
  decryptCredential(encryptedCredential: string, ctx: ProviderContext<TClient>): Promise<string>;
}

export type VrchatProviderRuntime<TClient extends ProviderRuntimeClient = ProviderRuntimeClient> =
  Omit<ProviderRuntimeModule<never, TClient>, 'backfill'>;

interface VrchatSession {
  authToken: string;
  twoFactorAuthToken?: string;
}

function parseVrchatSession(
  credential: string,
  options: { logger?: VrchatRuntimeLogger; malformedError?: string }
): { ok: true; session: VrchatSession } | { ok: false; error: string } {
  try {
    return {
      ok: true,
      session: JSON.parse(credential) as VrchatSession,
    };
  } catch {
    if (options.logger) {
      options.logger.warn('[vrchat] getCredential returned malformed JSON');
    }
    return { ok: false, error: options.malformedError ?? 'credential_error' };
  }
}

export function createVrchatProviderModule<
  TClient extends ProviderRuntimeClient = ProviderRuntimeClient,
>(ports: VrchatRuntimePorts<TClient>): VrchatProviderRuntime<TClient> {
  return {
    id: 'vrchat',
    needsCredential: true,
    purposes: VRCHAT_PURPOSES,
    async getCredential(ctx) {
      const encryptedSession = await ports.getEncryptedCredential(ctx);
      if (!encryptedSession) {
        return null;
      }
      return await ports.decryptCredential(encryptedSession, ctx);
    },
    async fetchProducts(credential: string | null): Promise<ProductRecord[]> {
      if (!credential) {
        return [];
      }

      const parsed = parseVrchatSession(credential, { logger: ports.logger });
      if (!parsed.ok) {
        return [];
      }

      const client = new VrchatApiClient();
      try {
        const listings = await client.getProductListings(parsed.session);
        return listings.map((listing) => ({ id: listing.id, name: listing.displayName }));
      } catch (err) {
        if (err instanceof VrchatSessionExpiredError) {
          throw new CredentialExpiredError('vrchat');
        }
        throw err;
      }
    },
    displayMeta: VRCHAT_DISPLAY_META,
    async resolveProductName(credential: string | null, urlOrId: string) {
      const avatarId = extractVrchatAvatarId(urlOrId);
      if (!avatarId) {
        return { name: '', error: 'invalid_avatar_id' };
      }
      if (!credential) {
        return { name: '', error: 'not_connected' };
      }

      const parsed = parseVrchatSession(credential, { malformedError: 'credential_error' });
      if (!parsed.ok) {
        return { name: '', error: parsed.error };
      }

      try {
        const client = new VrchatApiClient();
        const avatar = await client.getAvatarById(parsed.session, avatarId);
        return { name: avatar?.name ?? '', error: avatar ? undefined : 'not_found' };
      } catch (err) {
        if (err instanceof VrchatSessionExpiredError) {
          return { name: '', error: 'session_expired' };
        }
        throw err;
      }
    },
  };
}
