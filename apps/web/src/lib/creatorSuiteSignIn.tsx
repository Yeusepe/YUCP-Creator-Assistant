import { KeyRound } from 'lucide-react';
import type { ReactNode } from 'react';

/** Full wordmark used on the generic Creator Suite OAuth / sign-in page only. */
export const CREATOR_SUITE_LOGO_SRC = '/Icons/SuiteLogo.png';

export const CREATOR_SUITE_PRODUCT_NAME = 'YUCP Creator Suite';

export type CreatorSuiteSignInMethodId = 'discord' | 'passkey';

/**
 * Ordered list of primary sign-in methods. Add entries here (and handle them in
 * `SignInPageContent`) to surface new providers without restructuring the page.
 */
export interface CreatorSuiteSignInMethod {
  id: CreatorSuiteSignInMethodId;
  label: string;
  loadingLabel: string;
  /** `brand` = Discord-style primary; `neutral` = glass secondary (passkeys, future SSO tiles). */
  visual: 'brand' | 'neutral';
}

export const CREATOR_SUITE_SIGN_IN_METHODS: readonly CreatorSuiteSignInMethod[] = [
  {
    id: 'discord',
    label: 'Sign in with Discord',
    loadingLabel: 'Starting Discord sign-in…',
    visual: 'brand',
  },
  {
    id: 'passkey',
    label: 'Sign in with passkey',
    loadingLabel: 'Signing in with passkey…',
    visual: 'neutral',
  },
];

function DiscordGlyph() {
  return (
    <svg
      width="20"
      height="15"
      viewBox="0 0 22 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
    >
      <title>Discord</title>
      <path
        d="M18.6405 1.34005C17.2162 0.692466 15.6894 0.214918 14.0937 -0.000976562C13.8964 0.351023 13.668 0.827571 13.5104 1.20625C11.8109 0.957596 10.1272 0.957596 8.45984 1.20625C8.30222 0.827571 8.06802 0.351023 7.86887 -0.000976562C6.27139 0.214918 4.74277 0.694558 3.31851 1.34394C0.477068 5.53193 -0.29243 9.61536 0.0923454 13.6397C2.01043 15.0637 3.86783 15.9288 5.69467 16.4888C6.14896 15.8688 6.55408 15.2091 6.90196 14.5152C6.23869 14.2665 5.60335 13.9559 5.0046 13.5937C5.16222 13.4775 5.31618 13.3572 5.46618 13.2369C9.00034 14.9215 12.8434 14.9215 16.3356 13.2369C16.4875 13.3572 16.6415 13.4775 16.7972 13.5937C16.1965 13.9578 15.5592 14.2684 14.8959 14.5171C15.2438 15.2091 15.6471 15.8707 16.1032 16.4907C17.932 15.9307 19.7913 15.0656 21.7094 13.6397C22.1637 8.99328 20.9479 4.94768 18.6405 1.34005ZM7.35277 11.1872C6.27139 11.1872 5.38261 10.1885 5.38261 8.96893C5.38261 7.74936 6.25165 6.74884 7.35277 6.74884C8.4539 6.74884 9.34267 7.74756 9.32294 8.96893C9.32479 10.1885 8.4539 11.1872 7.35277 11.1872ZM14.449 11.1872C13.3677 11.1872 12.4789 10.1885 12.4789 8.96893C12.4789 7.74936 13.3479 6.74884 14.449 6.74884C15.5502 6.74884 16.439 7.74756 16.4192 8.96893C16.4192 10.1885 15.5502 11.1872 14.449 11.1872Z"
        fill="currentColor"
      />
    </svg>
  );
}

function PasskeyGlyph() {
  return <KeyRound width={16} height={16} strokeWidth={2} aria-hidden={true} />;
}

export function CreatorSuiteSignInMethodIcon({
  name,
}: {
  name: CreatorSuiteSignInMethodId;
}): ReactNode {
  switch (name) {
    case 'discord':
      return <DiscordGlyph />;
    case 'passkey':
      return <PasskeyGlyph />;
    default: {
      const _n: never = name;
      return _n;
    }
  }
}
