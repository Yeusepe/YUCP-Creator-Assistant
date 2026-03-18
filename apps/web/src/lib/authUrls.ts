import { normalizeAuthRedirectTarget } from '@yucp/shared/authRedirects';

export function buildDiscordSignInUrl(callbackUrl: string): string {
  return `/api/auth/sign-in/discord?callbackURL=${encodeURIComponent(callbackUrl)}`;
}

export function buildSignInCallbackUrl({
  browserAuthBaseUrl,
  redirectTo,
}: Readonly<{
  browserAuthBaseUrl: string;
  redirectTo?: string | null;
}>): string {
  const callbackUrl = new URL('/sign-in', browserAuthBaseUrl);
  const safeRedirectTo = normalizeAuthRedirectTarget(redirectTo);
  callbackUrl.searchParams.set('redirectTo', safeRedirectTo);
  return callbackUrl.toString();
}

export function buildSignInUrlForRedirectTarget({
  browserAuthBaseUrl,
  redirectTo,
}: Readonly<{
  browserAuthBaseUrl: string;
  redirectTo?: string | null;
}>): string {
  return buildDiscordSignInUrl(
    buildSignInCallbackUrl({
      browserAuthBaseUrl,
      redirectTo,
    })
  );
}

export function buildCurrentSignInUrl(currentHref: string, browserAuthBaseUrl: string): string {
  return buildSignInUrlForRedirectTarget({
    browserAuthBaseUrl,
    redirectTo: new URL(currentHref).searchParams.get('redirectTo'),
  });
}

export function buildAbsoluteCallbackUrl(
  pathAndSearch: string,
  browserAuthBaseUrl: string
): string {
  return new URL(pathAndSearch, browserAuthBaseUrl).toString();
}
