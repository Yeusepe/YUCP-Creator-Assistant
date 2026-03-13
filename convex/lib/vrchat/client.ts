/**
 * Portions of the VRChat auth flow in this file are adapted from
 * https://github.com/vrchatapi/vrchatapi-javascript under the MIT license.
 * See LICENSE.vrchatapi in this directory.
 */

import {
  AUTH_COOKIE,
  buildCookieHeader,
  extractCookieValue,
  TWO_FACTOR_AUTH_COOKIE,
} from './cookie';
import { isUser, requiresTwoFactorAuth, sanitizeTwoFactorMethods } from './guards';
import type {
  TwoFactorAuthType,
  VrchatCurrentUser,
  VrchatLicensedAvatar,
  VrchatLoginResult,
  VrchatOwnershipResult,
  VrchatSessionTokens,
} from './types';

const VRCHAT_API_BASE = 'https://api.vrchat.cloud/api/1';
const VRCHAT_USER_AGENT = 'YUCP Creator Assistant/0.1.0 (https://yucp.app)';

function buildBasicAuth(username: string, password: string): string {
  return `Basic ${btoa(`${encodeURIComponent(username)}:${encodeURIComponent(password)}`)}`;
}

async function parseResponseJson(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

async function request(
  path: string,
  init: RequestInit = {}
): Promise<{ response: Response; data: unknown }> {
  const headers = new Headers(init.headers);
  headers.set('user-agent', VRCHAT_USER_AGENT);
  const response = await fetch(`${VRCHAT_API_BASE}${path}`, {
    ...init,
    headers,
  });
  const data = await parseResponseJson(response);
  return { response, data };
}

function verificationPathForType(type: TwoFactorAuthType): string {
  switch (type) {
    case 'totp':
      return '/auth/twofactorauth/totp/verify';
    case 'emailOtp':
      return '/auth/twofactorauth/emailotp/verify';
    case 'otp':
      return '/auth/twofactorauth/otp/verify';
  }
}

function isVerifiedResponse(data: unknown): data is { verified?: boolean } {
  return !!data && typeof data === 'object' && 'verified' in data;
}

export class VrchatWebClient {
  async login(username: string, password: string): Promise<VrchatLoginResult> {
    const { response, data } = await request('/auth/user', {
      method: 'GET',
      headers: {
        authorization: buildBasicAuth(username, password),
      },
    });

    const authToken = extractCookieValue(response.headers, AUTH_COOKIE);
    if (!authToken) {
      throw new Error(`Verification failed: missing auth cookie (status ${response.status})`);
    }

    if (requiresTwoFactorAuth(data)) {
      const methods = sanitizeTwoFactorMethods(data.requiresTwoFactorAuth);
      if (!methods.length) {
        throw new Error('Verification failed: no supported two-factor methods');
      }

      return {
        success: false,
        requiresTwoFactorAuth: methods,
        pending: {
          authToken,
          requiresTwoFactorAuth: methods,
        },
      };
    }

    if (!isUser(data)) {
      throw new Error(
        `Verification failed: unexpected auth/user response (status ${response.status})`
      );
    }

    return {
      success: true,
      user: data,
      session: {
        authToken,
        twoFactorAuthToken: extractCookieValue(response.headers, TWO_FACTOR_AUTH_COOKIE),
      },
    };
  }

  async verify2fa(
    authToken: string,
    allowedMethods: readonly TwoFactorAuthType[],
    code: string,
    requestedType?: TwoFactorAuthType
  ): Promise<VrchatSessionTokens> {
    const methods = requestedType ? [requestedType] : allowedMethods;
    const finalMethods = methods.filter((method) => allowedMethods.includes(method));

    if (!finalMethods.length) {
      throw new Error('Verification failed: no allowed two-factor methods');
    }

    for (const method of finalMethods) {
      const { response, data } = await request(verificationPathForType(method), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `${AUTH_COOKIE}=${authToken}`,
        },
        body: JSON.stringify({ code }),
      });

      if (!isVerifiedResponse(data) || !data.verified) {
        continue;
      }

      return {
        authToken: extractCookieValue(response.headers, AUTH_COOKIE) ?? authToken,
        twoFactorAuthToken: extractCookieValue(response.headers, TWO_FACTOR_AUTH_COOKIE),
      };
    }

    throw new Error('Verification failed: two-factor verification was not accepted');
  }

  async getCurrentUser(session: VrchatSessionTokens): Promise<VrchatCurrentUser | null> {
    const { data } = await request('/auth/user', {
      method: 'GET',
      headers: {
        cookie: buildCookieHeader(session),
      },
    });

    if (!data || requiresTwoFactorAuth(data) || !isUser(data)) {
      return null;
    }

    return data;
  }

  async getLicensedAvatars(
    session: VrchatSessionTokens,
    n = 100,
    offset = 0
  ): Promise<VrchatLicensedAvatar[]> {
    const query = new URLSearchParams({
      n: String(Math.min(100, Math.max(1, n))),
      offset: String(Math.max(0, offset)),
    });

    const { data } = await request(`/avatars/licensed?${query.toString()}`, {
      method: 'GET',
      headers: {
        cookie: buildCookieHeader(session),
      },
    });

    if (!Array.isArray(data)) {
      throw new Error('Verification failed');
    }

    return data.filter(
      (entry): entry is VrchatLicensedAvatar =>
        !!entry && typeof entry === 'object' && typeof (entry as { id?: unknown }).id === 'string'
    );
  }

  async getOwnershipFromSession(
    session: VrchatSessionTokens
  ): Promise<VrchatOwnershipResult | null> {
    const user = await this.getCurrentUser(session);
    if (!user) {
      return null;
    }

    const ownedAvatarIds: string[] = [];
    let offset = 0;
    const pageSize = 100;

    for (;;) {
      const page = await this.getLicensedAvatars(session, pageSize, offset);
      for (const avatar of page) {
        ownedAvatarIds.push(avatar.id);
      }

      if (page.length < pageSize) {
        break;
      }
      offset += pageSize;
    }

    return {
      vrchatUserId: user.id,
      displayName: user.displayName ?? user.username ?? user.id,
      ownedAvatarIds,
    };
  }

  async completeLogin(
    authToken: string,
    allowedMethods: readonly TwoFactorAuthType[],
    code: string,
    requestedType?: TwoFactorAuthType
  ): Promise<{ user: VrchatCurrentUser; session: VrchatSessionTokens }> {
    const session = await this.verify2fa(authToken, allowedMethods, code, requestedType);
    const user = await this.getCurrentUser(session);

    if (!user) {
      throw new Error('Verification failed: session did not resolve to a user');
    }

    return { user, session };
  }
}
