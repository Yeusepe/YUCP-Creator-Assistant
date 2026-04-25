import type { VerificationConfig } from '../../verification/verificationConfig';
import type { ConnectConfig } from '../types';

export const PATREON_CONNECT_STATE_PREFIX = 'patreon_connect:';
export const PATREON_SHARED_CALLBACK_PATH = '/api/connect/patreon/callback';

export function isPatreonConnectState(state: string): boolean {
  return state.startsWith(PATREON_CONNECT_STATE_PREFIX);
}

export function toPatreonVerificationConfig(config: ConnectConfig): VerificationConfig {
  return {
    baseUrl: config.apiBaseUrl,
    frontendUrl: config.frontendBaseUrl,
    convexUrl: config.convexUrl,
    convexApiSecret: config.convexApiSecret,
    encryptionSecret: config.encryptionSecret,
    providerClientIds: {
      patreon: config.patreonClientId ?? '',
    },
    providerClientSecrets: {
      patreon: config.patreonClientSecret ?? '',
    },
  };
}
