/**
 * Portions of the VRChat cookie and guard logic in this directory are adapted
 * from https://github.com/vrchatapi/vrchatapi-javascript under the MIT license.
 * See LICENSE.vrchatapi in this directory.
 */

export type TwoFactorAuthType = 'totp' | 'emailOtp' | 'otp';

export interface RequiresTwoFactorAuth {
  requiresTwoFactorAuth: TwoFactorAuthType[];
}

export interface VrchatCurrentUser {
  id: string;
  displayName: string;
  username?: string;
  twoFactorAuthEnabled?: boolean;
  [key: string]: unknown;
}

export interface VrchatLicensedAvatar {
  id: string;
  name?: string;
  productId?: string;
  authorId?: string;
  authorName?: string;
  [key: string]: unknown;
}

export interface VrchatSessionTokens {
  authToken: string;
  twoFactorAuthToken?: string;
}

export interface VrchatPendingState {
  authToken: string;
  requiresTwoFactorAuth: TwoFactorAuthType[];
  issuedAt: number;
  expiresAt: number;
  version: 1;
}

export type VrchatLoginResult =
  | {
      success: true;
      user: VrchatCurrentUser;
      session: VrchatSessionTokens;
    }
  | {
      success: false;
      requiresTwoFactorAuth: TwoFactorAuthType[];
      pending: Omit<VrchatPendingState, 'issuedAt' | 'expiresAt' | 'version'>;
    };

export interface VrchatOwnershipResult {
  vrchatUserId: string;
  displayName: string;
  ownedAvatarIds: string[];
}
