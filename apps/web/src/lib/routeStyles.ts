import notFoundHref from '@/styles/404.css?url';
import collabInviteHref from '@/styles/collab-invite.css?url';
import connectHref from '@/styles/connect.css?url';
import dashboardHref from '@/styles/dashboard.css?url';
import discordRoleSetupHref from '@/styles/discord-role-setup.css?url';
import jinxxySetupHref from '@/styles/jinxxy-setup.css?url';
import legalHref from '@/styles/legal.css?url';
import lemonsqueezySetupHref from '@/styles/lemonsqueezy-setup.css?url';
import oauthConsentHref from '@/styles/oauth-consent.css?url';
import oauthErrorHref from '@/styles/oauth-error.css?url';
import oauthLoginHref from '@/styles/oauth-login.css?url';
import payhipSetupHref from '@/styles/payhip-setup.css?url';
import signInHref from '@/styles/sign-in.css?url';
import signInRedirectHref from '@/styles/sign-in-redirect.css?url';
import verifyErrorHref from '@/styles/verify-error.css?url';
import verifySuccessHref from '@/styles/verify-success.css?url';
import vrchatVerifyHref from '@/styles/vrchat-verify.css?url';

export const routeStyleHrefs = {
  notFound: notFoundHref,
  collabInvite: collabInviteHref,
  connect: connectHref,
  dashboard: dashboardHref,
  discordRoleSetup: discordRoleSetupHref,
  jinxxySetup: jinxxySetupHref,
  legal: legalHref,
  lemonsqueezySetup: lemonsqueezySetupHref,
  oauthConsent: oauthConsentHref,
  oauthError: oauthErrorHref,
  oauthLogin: oauthLoginHref,
  payhipSetup: payhipSetupHref,
  signIn: signInHref,
  signInRedirect: signInRedirectHref,
  verifyError: verifyErrorHref,
  verifySuccess: verifySuccessHref,
  vrchatVerify: vrchatVerifyHref,
} as const;

export function routeStylesheetLinks(...hrefs: Array<string | undefined>) {
  return hrefs.filter(Boolean).map((href) => ({
    rel: 'stylesheet' as const,
    href,
    suppressHydrationWarning: true as const,
  }));
}
