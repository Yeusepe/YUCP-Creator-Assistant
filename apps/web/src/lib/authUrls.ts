import {
  getSafeRelativeRedirectTarget,
  normalizeAuthRedirectTarget,
} from '@yucp/shared/authRedirects';

const DEFAULT_AUTH_CALLBACK_PATH = '/sign-in';

export function buildDiscordSignInStartUrl(returnTo: string): string {
  const safeReturnTo = getSafeRelativeRedirectTarget(returnTo) ?? DEFAULT_AUTH_CALLBACK_PATH;
  return `${DEFAULT_AUTH_CALLBACK_PATH}?redirectTo=${encodeURIComponent(safeReturnTo)}`;
}

export function buildSignInCallbackPath({
  redirectTo,
}: Readonly<{
  redirectTo?: string | null;
}>): string {
  const callbackUrl = new URL(DEFAULT_AUTH_CALLBACK_PATH, 'https://auth.invalid');
  const safeRedirectTo = normalizeAuthRedirectTarget(redirectTo);
  callbackUrl.searchParams.set('redirectTo', safeRedirectTo);
  return `${callbackUrl.pathname}${callbackUrl.search}`;
}

export function buildSignInUrlForRedirectTarget({
  redirectTo,
}: Readonly<{
  redirectTo?: string | null;
}>): string {
  return buildDiscordSignInStartUrl(buildSignInCallbackPath({ redirectTo }));
}
