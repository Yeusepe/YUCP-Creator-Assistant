/**
 * Portions of this file are adapted from
 * https://github.com/vrchatapi/vrchatapi-javascript under the MIT license.
 * See LICENSE.vrchatapi in this directory.
 */

import type { RequiresTwoFactorAuth, TwoFactorAuthType, VrchatCurrentUser } from './types';

export function requiresTwoFactorAuth(data?: unknown): data is RequiresTwoFactorAuth {
  return !!data
    && typeof data === 'object'
    && 'requiresTwoFactorAuth' in data
    && Array.isArray((data as { requiresTwoFactorAuth?: unknown }).requiresTwoFactorAuth);
}

export function isUser(data?: unknown): data is VrchatCurrentUser {
  return !!data
    && typeof data === 'object'
    && 'id' in data
    && typeof (data as { id?: unknown }).id === 'string';
}

export function sanitizeTwoFactorMethods(methods: readonly string[]): TwoFactorAuthType[] {
  return methods.filter(
    (method): method is TwoFactorAuthType =>
      method === 'totp' || method === 'emailOtp' || method === 'otp'
  );
}
