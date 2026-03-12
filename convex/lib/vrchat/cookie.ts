/**
 * Portions of this file are adapted from
 * https://github.com/vrchatapi/vrchatapi-javascript under the MIT license.
 * See LICENSE.vrchatapi in this directory.
 */

import type { VrchatSessionTokens } from './types';

export interface Cookie {
  name: string;
  value: string;
  expires: number | null;
  options: Record<string, string>;
}

export const AUTH_COOKIE = 'auth';
export const TWO_FACTOR_AUTH_COOKIE = 'twoFactorAuth';

export function parseSetCookie(cookie: string): Cookie {
  const [name, ...rest] = cookie.split('=') as [string, ...string[]];
  const [value, ...rawOptions] = rest.join('=').split(';') as [string, ...string[]];

  const options = Object.fromEntries(
    rawOptions.map((option) => {
      const [optionName, optionValue = ''] = option.split('=') as [string, string?];
      return [optionName.trim().toLowerCase(), optionValue];
    })
  ) as Record<string, string>;

  const expires = options['max-age']
    ? Date.now() + Number(options['max-age']) * 1000
    : options.expires
      ? new Date(options.expires).getTime()
      : null;

  return { name, value, expires, options };
}

export function isCookieValid(cookie: Cookie): boolean {
  return cookie.expires === null || cookie.expires > Date.now();
}

export function serializeCookie(cookie: Pick<Cookie, 'name' | 'value'>): string {
  return `${cookie.name}=${cookie.value}`;
}

export function serializeCookies(cookies: Cookie[]): string {
  return cookies.map(serializeCookie).join('; ');
}

export function splitSetCookieHeader(raw: string): string[] {
  if (!raw) return [];

  const cookies: string[] = [];
  let start = 0;
  let inExpires = false;

  for (let index = 0; index < raw.length; index += 1) {
    const slice = raw.slice(index, index + 8).toLowerCase();
    if (slice === 'expires=') {
      inExpires = true;
      index += 7;
      continue;
    }

    const char = raw[index];
    if (inExpires && char === ';') {
      inExpires = false;
      continue;
    }

    if (!inExpires && char === ',' && raw[index + 1] === ' ') {
      cookies.push(raw.slice(start, index).trim());
      start = index + 2;
    }
  }

  cookies.push(raw.slice(start).trim());
  return cookies.filter(Boolean);
}

export function getSetCookieHeaders(headers: Headers): string[] {
  const withGetSetCookie = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof withGetSetCookie.getSetCookie === 'function') {
    return withGetSetCookie.getSetCookie();
  }

  return splitSetCookieHeader(headers.get('set-cookie') ?? '');
}

export function extractCookieValue(headers: Headers, name: string): string | undefined {
  const prefix = `${name}=`;
  for (const setCookie of getSetCookieHeaders(headers)) {
    const firstSegment = setCookie.split(';', 1)[0]?.trim();
    if (!firstSegment?.startsWith(prefix)) continue;
    return firstSegment.slice(prefix.length);
  }
  return undefined;
}

export function buildCookieHeader(session: VrchatSessionTokens): string {
  const cookies: Cookie[] = [
    { name: AUTH_COOKIE, value: session.authToken, expires: null, options: {} },
  ];
  if (session.twoFactorAuthToken) {
    cookies.push({
      name: TWO_FACTOR_AUTH_COOKIE,
      value: session.twoFactorAuthToken,
      expires: null,
      options: {},
    });
  }
  return serializeCookies(cookies);
}
