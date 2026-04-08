import type { VerificationConfig } from '../../verification/verificationConfig';
import type { ConnectConfig } from '../types';

export const GUMROAD_CONNECT_STATE_PREFIX = 'connect_gumroad:';
export const GUMROAD_SHARED_CALLBACK_PATH = '/api/connect/gumroad/callback';

export function isGumroadConnectState(state: string): boolean {
  return state.startsWith(GUMROAD_CONNECT_STATE_PREFIX);
}

export function toGumroadVerificationConfig(config: ConnectConfig): VerificationConfig {
  return {
    baseUrl: config.apiBaseUrl,
    frontendUrl: config.frontendBaseUrl,
    convexUrl: config.convexUrl,
    convexApiSecret: config.convexApiSecret,
    gumroadClientId: config.gumroadClientId,
    gumroadClientSecret: config.gumroadClientSecret,
  };
}
