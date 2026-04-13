/**
 * VRChat API response types
 * @see https://vrchat.community/reference/get-current-user
 * @see https://vrchat.community/reference/get-licensed-avatars
 * @see https://vrchat.community/reference/verify2fa
 */

/**
 * 2FA method types returned in requiresTwoFactorAuth array.
 * - totp: authenticator app (Google Authenticator, Authy, etc.)
 * - emailOtp: code sent to email
 * - otp: recovery code
 */
export type TwoFactorAuthType = 'totp' | 'emailOtp' | 'otp';

/**
 * Response from GET /auth/user when 2FA is required.
 * VRChat always returns HTTP 200; 2FA is signalled via the body.
 */
export interface RequiresTwoFactorAuth {
  requiresTwoFactorAuth: TwoFactorAuthType[];
}

/** Current user from GET /auth/user */
export interface VrchatCurrentUser {
  id: string;
  displayName: string;
  username?: string;
  twoFactorAuthEnabled?: boolean;
  [key: string]: unknown;
}

/** Licensed avatar from GET /avatars/licensed */
export interface VrchatLicensedAvatar {
  id: string;
  name: string;
  productId?: string;
  authorId?: string;
  authorName?: string;
  [key: string]: unknown;
}

/** 2FA verify response from POST /auth/twofactorauth/totp/verify */
export interface Vrchat2FAVerifyResponse {
  verified: boolean;
  enabled: boolean;
}

/** VRChat API error response */
export interface VrchatApiError {
  error?: {
    message?: string;
    status_code?: number;
  };
}

/** Raw VRChat session tokens extracted from cookies */
export interface VrchatSessionTokens {
  authToken: string;
  twoFactorAuthToken?: string;
}

/** Pending SDK-backed login state kept between password and 2FA steps */
export interface VrchatPendingLoginState {
  authToken: string;
  requiresTwoFactorAuth: TwoFactorAuthType[];
}

/** Result of the initial sign-in attempt */
export type VrchatBeginLoginResult =
  | {
      success: true;
      user: VrchatCurrentUser;
      session: VrchatSessionTokens;
    }
  | {
      success: false;
      requiresTwoFactorAuth: TwoFactorAuthType[];
      pendingState: string;
    };

/** Result of verifyOwnership - owned avatars for retroactive grant */
export interface VrchatVerifyOwnershipResult {
  vrchatUserId: string;
  displayName: string;
  ownedAvatarIds: string[];
  licensedAvatars: VrchatLicensedAvatar[];
}

/**
 * Thrown by VrchatApiClient when the VRChat API returns 401, the stored
 * session has expired or been invalidated. The provider plugin layer
 * (apps/api/src/providers/vrchat/index.ts) catches this and rethrows as
 * the framework-level CredentialExpiredError.
 *
 * Source: https://vrchat.community/reference/get-product-listings
 */
export class VrchatSessionExpiredError extends Error {
  constructor() {
    super('VRChat session expired or invalid (HTTP 401)');
    this.name = 'VrchatSessionExpiredError';
  }
}

/**
 * A single product listing from the VRChat creator store.
 * Source: GET /api/1/user/{userId}/listings
 * @see https://vrchat.community/reference/get-product-listings
 * @see https://github.com/vrchatapi/specification/blob/main/openapi/components/paths/economy.yaml
 */
export interface VrchatProductListing {
  id: string;
  displayName: string;
  listingType: string;
  hasAvatar: boolean;
  sellerId: string;
}
