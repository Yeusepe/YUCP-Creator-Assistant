import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const accountRouteSource = readFileSync(resolve(__dirname, '../../src/routes/account.tsx'), 'utf8');
const accountIndexRouteSource = readFileSync(
  resolve(__dirname, '../../src/routes/account/index.tsx'),
  'utf8'
);
const accountCertificatesRouteSource = readFileSync(
  resolve(__dirname, '../../src/routes/account/certificates.tsx'),
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
    expect(accountRouteSource).toContain('useAccountShell');
    expect(accountIndexRouteSource).toContain('useAccountShell');
  });

  it('loads dashboard styling as side-effect imports and reuses the shared dashboard header', () => {
    expect(accountRouteSource).toContain("import '@/styles/dashboard.css';");
    expect(accountRouteSource).toContain("import '@/styles/dashboard-components.css';");
    expect(accountRouteSource).toContain("import '@/styles/account.css';");
    expect(accountRouteSource).toContain('DashboardHeader');
  });

  it('uses the shared account page scaffold for the redesigned account landing page', () => {
    expect(accountIndexRouteSource).toContain('AccountPage');
    expect(accountIndexRouteSource).toContain('AccountSectionCard');
    expect(accountCertificatesRouteSource).toContain('AccountPage');
    expect(accountCertificatesRouteSource).toContain('AccountSectionCard');
  });

  it('renders Discord identity from auth session data with the account shell as fallback', () => {
    expect(accountIndexRouteSource).toContain('const { guilds, viewer } = useAccountShell();');
    expect(accountIndexRouteSource).toContain('authClient.getSession()');
    expect(accountIndexRouteSource).not.toContain('useConvexQuery(api.authViewer.getViewer)');
    expect(accountIndexRouteSource).not.toContain("'Your Account'");
  });

  it('announces inline account errors to assistive technology', () => {
    expect(accountComponentSource).toContain('role="alert"');
    expect(accountComponentSource).toContain('className="account-inline-error"');
  });

  it('includes a dedicated certificates and billing account surface', () => {
    expect(accountRouteSource).toContain('/account/certificates');
    expect(accountIndexRouteSource).toContain('/account/certificates');
    expect(accountCertificatesRouteSource).toContain("createFileRoute('/account/certificates')");
    expect(accountCertificatesRouteSource).toContain('Manage billing');
  });
});
