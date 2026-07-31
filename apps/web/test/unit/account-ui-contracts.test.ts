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
const accountApiSource = readFileSync(resolve(__dirname, '../../src/lib/account.ts'), 'utf8');
const dashboardRouteSource = readFileSync(
  resolve(__dirname, '../../src/routes/_authenticated/dashboard.tsx'),
  'utf8'
);
const accountCertificatesRouteSource = readFileSync(
  resolve(__dirname, '../../src/routes/_authenticated/account/certificates.tsx'),
  'utf8'
);
const dashboardCertificatesRedirectSource = readFileSync(
  resolve(__dirname, '../../src/routes/_authenticated/dashboard/certificates.tsx'),
  'utf8'
);
const dashboardBillingRedirectSource = readFileSync(
  resolve(__dirname, '../../src/routes/_authenticated/dashboard/billing.tsx'),
  'utf8'
);
const dashboardForensicsRedirectSource = readFileSync(
  resolve(__dirname, '../../src/routes/_authenticated/dashboard/forensics.tsx'),
  'utf8'
);
const accountBillingRouteRefSource = readFileSync(
  resolve(__dirname, '../../src/routes/_authenticated/account/billing.tsx'),
  'utf8'
);
const accountBillingRouteSource = readFileSync(
  resolve(__dirname, '../../src/routes/_authenticated/account/billing.lazy.tsx'),
  'utf8'
);
const accountMachinesRouteSource = readFileSync(
  resolve(__dirname, '../../src/routes/_authenticated/account/machines.lazy.tsx'),
  'utf8'
);
const accountAuthorizedAppsRouteSource = readFileSync(
  resolve(__dirname, '../../src/routes/_authenticated/account/authorized-apps.lazy.tsx'),
  'utf8'
);
const dashboardPackagesRouteSource = readFileSync(
  resolve(__dirname, '../../src/routes/_authenticated/dashboard/packages.lazy.tsx'),
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
const dashboardLazyRouteSource = readFileSync(
  resolve(__dirname, '../../src/routes/_authenticated/dashboard.lazy.tsx'),
  'utf8'
);
const connectUserVerificationRouteSource = readFileSync(
  resolve(__dirname, '../../../api/src/routes/connectUserVerification.ts'),
  'utf8'
);
const accountComponentSource = readFileSync(
  resolve(__dirname, '../../src/components/account/AccountPage.tsx'),
  'utf8'
);
const serverSettingsPanelSource = readFileSync(
  resolve(__dirname, '../../src/components/dashboard/panels/ServerSettingsPanel.tsx'),
  'utf8'
);
const dashboardIntegrationsRouteSource = readFileSync(
  resolve(__dirname, '../../src/routes/_authenticated/dashboard/integrations.lazy.tsx'),
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

  it('owns creator identity and private subdomain settings at the account level', () => {
    expect(accountIndexRouteSource).toContain('<CreatorIdentitySettingsCard />');
    expect(serverSettingsPanelSource).not.toContain('Creator identity');
    expect(serverSettingsPanelSource).not.toContain('Private VPM subdomain');
  });

  it('renders Discord identity from auth session data with the account shell as fallback', () => {
    expect(accountIndexRouteSource).toContain(
      'const { creatorAccount, viewer } = useAccountShell();'
    );
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

  it('lets a signed-in user activate a creator account without installing the bot', () => {
    expect(accountApiSource).toContain(
      "apiClient.post<CreatorAccountActivationResult>('/api/connect/creator-account')"
    );
    expect(accountIndexRouteSource).toContain('activateCreatorAccount');
    expect(accountIndexRouteSource).toContain('isLoading={isActivatingCreatorAccount}');
    expect(accountIndexRouteSource).toContain('Become a creator');
    expect(accountIndexRouteSource).not.toContain('Add bot to a server');
    expect(dashboardRouteSource).toContain('shell.creatorAccount.isActive');
    expect(dashboardRouteSource).not.toContain(
      'shell.guilds.length === 0 && !allowsFreshGuildBootstrap'
    );
  });

  it('does not reuse creator-account or login state forever in browser memory', () => {
    expect(accountRouteSource).not.toContain('accountLoaderCache');
    expect(accountRouteSource).not.toContain('staleTime: Infinity');
    expect(accountRouteSource).toContain('queryClient.fetchQuery(');
    expect(accountIndexRouteSource).toContain('CreatorAccountSessionExpiredError');
    expect(accountIndexRouteSource).toContain("to: '/sign-in'");
    expect(accountIndexRouteSource).toContain("redirectTo: '/account#creator-account'");
  });

  it('announces inline account errors to assistive technology', () => {
    expect(accountComponentSource).toContain('role="alert"');
    expect(accountComponentSource).toContain('className="account-inline-error"');
  });

  it('hosts billing and authorized machines inside the account area', () => {
    expect(accountRouteSource).not.toContain('/account/certificates');
    expect(accountIndexRouteSource).toContain('/account/billing');
    expect(accountIndexRouteSource).not.toContain('/dashboard/certificates');

    // Account billing route is the canonical billing surface.
    expect(accountBillingRouteSource).toContain(
      "createLazyFileRoute('/_authenticated/account/billing')"
    );
    expect(accountBillingRouteSource).toContain('Polar');
    expect(accountBillingRouteSource).not.toContain('useActiveDashboardContext');

    // Authorized machines live in the account area, not a dashboard certificates page.
    expect(accountMachinesRouteSource).toContain(
      "createLazyFileRoute('/_authenticated/account/machines')"
    );
    expect(accountMachinesRouteSource).toContain('Authorized Machines');
    expect(accountMachinesRouteSource).toContain('CertificateDeviceRow');

    // The legacy account/certificates and dashboard certificate/billing paths redirect.
    expect(accountCertificatesRouteSource).toContain(
      "createFileRoute('/_authenticated/account/certificates')"
    );
    expect(accountCertificatesRouteSource).toContain('beforeLoad');
    expect(accountCertificatesRouteSource).toContain(
      "to: hasBillingSearch ? '/account/billing' : '/account/machines'"
    );
    expect(dashboardBillingRedirectSource).toContain("to: '/account/billing'");
    expect(dashboardCertificatesRedirectSource).toContain("to: '/account/machines'");

    expect(dashboardPrefetchSource).toContain("queryKey: ['creator-certificates']");
    expect(dashboardPrefetchSource).toContain('prefetchQuery(');
  });

  it('lets users sign native YUCP applications out from the website', () => {
    expect(accountAuthorizedAppsRouteSource).toContain("grant.platform === 'native'");
    expect(accountAuthorizedAppsRouteSource).toContain("'Sign out'");
    expect(accountAuthorizedAppsRouteSource).toContain('`Sign out of ');
    expect(accountAuthorizedAppsRouteSource).toContain('grant.appName');
    expect(accountAuthorizedAppsRouteSource).toContain('isPending={revokeMut.isPending}');
    expect(accountAuthorizedAppsRouteSource).toContain('accessibleLabel=');
    expect(accountAuthorizedAppsRouteSource).toContain('actionLabel.toLowerCase()');
  });

  it('serializes conflicting OAuth and API-key credential mutations', () => {
    expect(dashboardIntegrationsRouteSource).toContain(
      'regenerateMutation.isPending || deleteMutation.isPending'
    );
    expect(dashboardIntegrationsRouteSource).toMatch(
      /rotateMutation\.isPending\s*\|\|\s*revokeMutation\.isPending/
    );
  });

  it('supports plan and portal deep links for Unity billing handoff', () => {
    expect(accountBillingRouteRefSource).toContain('validateSearch:');
    expect(accountBillingRouteSource).toContain("search.checkout === '1'");
    expect(accountBillingRouteSource).toContain("search.portal === '1'");
    expect(accountBillingRouteSource).toContain('isTrustedBillingAutoLaunchSource(search.source)');
    expect(accountBillingRouteSource).toContain('checkoutMut.mutate(target)');
    expect(accountBillingRouteSource).toContain('portalMut.mutate()');
    expect(accountBillingRouteSource).toContain('navigateToTrustedPolarUrl(result.url)');
  });

  it('keeps coupling forensics beside the restored package registry workspace', () => {
    expect(dashboardForensicsRedirectSource).toContain("to: '/dashboard/packages'");
    expect(dashboardForensicsRedirectSource).toContain("view: 'forensics'");
    expect(dashboardLazyRouteSource).toContain('hasCouplingTraceabilityCapability');
    expect(dashboardLazyRouteSource).toContain(
      'hasVpmRepoCapability || hasCouplingTraceabilityCapability'
    );
    expect(dashboardLazyRouteSource).toContain('Packages');
    expect(dashboardLazyRouteSource).not.toContain('tab-btn-package-forensics');

    expect(dashboardPackagesRouteSource).toContain('CouplingForensicsPanel');
    expect(dashboardPackagesRouteSource).toContain('role="tablist"');
    expect(dashboardPackagesRouteSource).toContain('Leak Tracer');
    expect(dashboardPackagesRouteSource).toContain('Uploads');
    expect(dashboardPackagesRouteSource).toContain('PackageRegistryPanel');
  });

  it('shows unavailable recovery metrics as pending instead of zero', () => {
    expect(accountIndexRouteSource).toContain("securityOverview?.passkeyCount ?? '...'");
    expect(accountIndexRouteSource).toContain("securityOverview?.backupCodeCount ?? '...'");
    expect(accountIndexRouteSource).toContain(
      "securityOverview?.verifiedRecoveryEmailCount ?? '...'"
    );
  });

  it('removes billing and certificates from the developer sidebar group', () => {
    expect(dashboardLazyRouteSource).not.toContain('id="tab-btn-billing"');
    expect(dashboardLazyRouteSource).not.toContain('id="tab-btn-certificates"');
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
