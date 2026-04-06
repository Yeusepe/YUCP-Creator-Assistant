import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const accountRouteSource = readFileSync(
  resolve(__dirname, '../../src/routes/_authenticated/account.tsx'),
  'utf8'
);
const accountLazyRouteSource = readFileSync(
  resolve(__dirname, '../../src/routes/_authenticated/account.lazy.tsx'),
  'utf8'
);
const accountIndexRouteSource = readFileSync(
  resolve(__dirname, '../../src/routes/_authenticated/account/index.lazy.tsx'),
  'utf8'
);
const accountCertificatesRouteSource = readFileSync(
  resolve(__dirname, '../../src/routes/_authenticated/account/certificates.tsx'),
  'utf8'
);
const dashboardCertificatesRouteSource = readFileSync(
  resolve(__dirname, '../../src/routes/_authenticated/dashboard/certificates.lazy.tsx'),
  'utf8'
);
const dashboardBillingRouteRefSource = readFileSync(
  resolve(__dirname, '../../src/routes/_authenticated/dashboard/billing.tsx'),
  'utf8'
);
const dashboardBillingRouteSource = readFileSync(
  resolve(__dirname, '../../src/routes/_authenticated/dashboard/billing.lazy.tsx'),
  'utf8'
);
const dashboardPrefetchSource = readFileSync(
  resolve(__dirname, '../../src/lib/dashboardPrefetch.ts'),
  'utf8'
);
const accountVerifyRouteSource = readFileSync(
  resolve(__dirname, '../../src/routes/_authenticated/account/verify.lazy.tsx'),
  'utf8'
);
const dashboardSource = readFileSync(resolve(__dirname, '../../src/lib/dashboard.ts'), 'utf8');
const connectUserVerificationRouteSource = readFileSync(
  resolve(__dirname, '../../../api/src/routes/connectUserVerification.ts'),
  'utf8'
);
const accountComponentSource = readFileSync(
  resolve(__dirname, '../../src/components/account/AccountPage.tsx'),
  'utf8'
);

describe('account UI contracts', () => {
  it('uses an account-scoped shell hook instead of the dashboard route hook', () => {
    expect(accountRouteSource).not.toContain('useDashboardShell');
    expect(accountIndexRouteSource).not.toContain('useDashboardShell');
    expect(accountLazyRouteSource).toContain('useAccountShell');
    expect(accountIndexRouteSource).toContain('useAccountShell');
  });

  it('declares account shell styles from the base route head and reuses the shared dashboard header', () => {
    expect(accountRouteSource).toContain('routeStylesheetLinks(');
    expect(accountRouteSource).toContain('routeStyleHrefs.dashboard');
    expect(accountRouteSource).toContain('routeStyleHrefs.dashboardComponents');
    expect(accountRouteSource).toContain('routeStyleHrefs.account');
    expect(accountLazyRouteSource).toContain('DashboardHeader');
    expect(accountLazyRouteSource).toContain('normalizeAccountPath(');
    expect(accountLazyRouteSource).toContain('onClick={closeAccountSidebar}');
  });

  it('uses the shared account page scaffold for the redesigned account landing page', () => {
    expect(accountIndexRouteSource).toContain('AccountPage');
    expect(accountIndexRouteSource).toContain('AccountSectionCard');
    expect(accountCertificatesRouteSource).not.toContain('AccountPage');
    expect(accountCertificatesRouteSource).toContain('beforeLoad');
  });

  it('renders Discord identity from auth session data with the account shell as fallback', () => {
    expect(accountIndexRouteSource).toContain('const { guilds, viewer } = useAccountShell();');
    expect(accountIndexRouteSource).toContain('authClient.getSession()');
    expect(accountIndexRouteSource).not.toContain('useConvexQuery(api.authViewer.getViewer)');
    expect(accountIndexRouteSource).not.toContain("'Your Account'");
    expect(accountIndexRouteSource).toContain('enabled: isCreator');
    expect(accountIndexRouteSource).toContain(
      '<Link to="/dashboard" className="account-btn account-btn--primary">'
    );
    expect(accountIndexRouteSource).not.toContain(
      '<a href="/dashboard" className="account-btn account-btn--primary">'
    );
    expect(accountIndexRouteSource).not.toContain('key={label}');
  });

  it('announces inline account errors to assistive technology', () => {
    expect(accountComponentSource).toContain('role="alert"');
    expect(accountComponentSource).toContain('className="account-inline-error"');
  });

  it('routes certificate billing through the creator dashboard instead of account space', () => {
    expect(accountRouteSource).not.toContain('/account/certificates');
    expect(accountIndexRouteSource).toContain('/dashboard/certificates');
    expect(accountCertificatesRouteSource).toContain(
      "createFileRoute('/_authenticated/account/certificates')"
    );
    expect(accountCertificatesRouteSource).toContain('beforeLoad');
    expect(accountCertificatesRouteSource).toContain(
      "to: hasBillingSearch ? '/dashboard/billing' : '/dashboard/certificates'"
    );
    expect(dashboardCertificatesRouteSource).toContain(
      "createLazyFileRoute('/_authenticated/dashboard/certificates')"
    );
    expect(dashboardCertificatesRouteSource).toContain('Open Billing');
    expect(dashboardCertificatesRouteSource).toContain('PackageRegistryPanel');
    expect(dashboardCertificatesRouteSource).toContain("queryKey: ['creator-certificates']");
    expect(dashboardCertificatesRouteSource).not.toContain('ensureQueryData(');
    expect(dashboardBillingRouteSource).toContain(
      "createLazyFileRoute('/_authenticated/dashboard/billing')"
    );
    expect(dashboardBillingRouteSource).toContain('Polar Portal');
    expect(dashboardPrefetchSource).toContain("queryKey: ['creator-certificates']");
    expect(dashboardPrefetchSource).toContain('prefetchQuery(');
  });

  it('supports creator-scoped plan and portal deep links for Unity billing handoff', () => {
    expect(dashboardBillingRouteRefSource).toContain('validateSearch:');
    expect(dashboardBillingRouteSource).toContain("search.checkout === '1'");
    expect(dashboardBillingRouteSource).toContain("search.portal === '1'");
    expect(dashboardBillingRouteSource).toContain('checkoutMut.mutate(target)');
    expect(dashboardBillingRouteSource).toContain('portalMut.mutate()');
    expect(dashboardBillingRouteSource).toContain('dashboard-tab-panel');
  });

  it('keeps package management inside certificates instead of a separate sidebar tab', () => {
    expect(dashboardSource).not.toContain('id="tab-btn-packages"');
    expect(dashboardSource).not.toContain('aria-controls="tab-panel-packages"');
  });

  it('keeps buyer provider linking inside the hosted verification flow', () => {
    expect(accountVerifyRouteSource).toContain('listUserAccounts');
    expect(accountVerifyRouteSource).toContain('listUserProviders');
    expect(accountVerifyRouteSource).toContain('startUserVerify');
    expect(accountVerifyRouteSource).toContain('Connect ' + '$' + '{method.providerLabel}');
    expect(accountVerifyRouteSource).toContain('Reconnect ' + '$' + '{method.providerLabel}');
    expect(accountVerifyRouteSource).toContain('Open connections');
    expect(dashboardSource).toContain('returnUrl?: string');
    expect(connectUserVerificationRouteSource).toContain('getSafeRelativeRedirectTarget');
    expect(connectUserVerificationRouteSource).toContain(
      'const safeReturnUrl = getSafeRelativeRedirectTarget(body.returnUrl)'
    );
    expect(connectUserVerificationRouteSource).not.toContain('userSetupPath');
  });
});
