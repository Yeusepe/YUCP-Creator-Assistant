import type { TwoFactorAuthType } from '@yucp/providers';
import {
  createEncryptedPendingState,
  type TimestampedPendingState,
} from '../../lib/encryptedPendingState';

interface VrchatConnectPendingPayload {
  authUserId: string;
  pendingState: string;
  types: TwoFactorAuthType[];
}

export type VrchatConnectPendingState = TimestampedPendingState<VrchatConnectPendingPayload>;

function validateConnectPayload(value: unknown): VrchatConnectPendingPayload | null {
  if (!value || typeof value !== 'object') return null;
  const state = value as Partial<VrchatConnectPendingPayload>;
  const validTypes = Array.isArray(state.types)
    ? state.types.filter(
        (type): type is TwoFactorAuthType =>
          type === 'totp' || type === 'emailOtp' || type === 'otp'
      )
    : [];

  if (
    typeof state.authUserId !== 'string' ||
    typeof state.pendingState !== 'string' ||
    validTypes.length === 0
  ) {
    return null;
  }

  return {
    authUserId: state.authUserId,
    pendingState: state.pendingState,
    types: validTypes,
  };
}

export const {
  appendClearedCookie: appendClearedConnectPendingCookie,
  create: createConnectPendingState,
  read: readConnectPendingState,
  clear: clearConnectPendingState,
} = createEncryptedPendingState<VrchatConnectPendingPayload>({
  cookieName: 'yucp_vrchat_connect_pending',
  cookiePath: '/api/connect/vrchat',
  storagePrefix: 'vrchat_connect_pending:',
  purpose: 'vrchat-connect-pending-state',
  payloadValidator: validateConnectPayload,
});
