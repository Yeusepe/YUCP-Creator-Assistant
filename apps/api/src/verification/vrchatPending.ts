import type { TwoFactorAuthType } from '@yucp/providers';
import {
  createEncryptedPendingState,
  type TimestampedPendingState,
} from '../lib/encryptedPendingState';

interface VrchatPendingPayload {
  verificationToken: string;
  pendingState: string;
  types: TwoFactorAuthType[];
}

export type VrchatPendingState = TimestampedPendingState<VrchatPendingPayload>;

function validateVerificationPayload(
  value: unknown,
  verificationToken: string
): VrchatPendingPayload | null {
  if (!value || typeof value !== 'object') return null;
  const state = value as Partial<VrchatPendingPayload>;
  const validTypes = Array.isArray(state.types)
    ? state.types.filter(
        (type): type is TwoFactorAuthType =>
          type === 'totp' || type === 'emailOtp' || type === 'otp'
      )
    : [];

  if (
    typeof state.verificationToken !== 'string' ||
    state.verificationToken !== verificationToken ||
    typeof state.pendingState !== 'string' ||
    validTypes.length === 0
  ) {
    return null;
  }

  return {
    verificationToken: state.verificationToken,
    pendingState: state.pendingState,
    types: validTypes,
  };
}

export const {
  appendClearedCookie: appendClearedPendingCookie,
  create: createPendingVrchatState,
  read: readPendingVrchatState,
  clear: clearPendingVrchatState,
} = createEncryptedPendingState<VrchatPendingPayload, [verificationToken: string]>({
  cookieName: 'yucp_vrchat_pending',
  cookiePath: '/api/verification/vrchat-verify',
  storagePrefix: 'vrchat_pending:',
  purpose: 'vrchat-pending-state',
  payloadValidator: validateVerificationPayload,
});
