import { expect, test } from 'playwright/test';

// Source: https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/11-Client-side_Testing/09-Testing_for_Clickjacking
// Source: https://cheatsheetseries.owasp.org/cheatsheets/Content_Security_Policy_Cheat_Sheet.html
// Source: https://cheatsheetseries.owasp.org/cheatsheets/Unvalidated_Redirects_and_Forwards_Cheat_Sheet.html

const SKIP_REASON =
  'Requires TEST_BASE_URL env var pointing to a running API server (e.g. TEST_BASE_URL=http://localhost:3001)';

function expectHtmlSecurityHeaders(headers: Record<string, string>) {
  expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
  expect(headers['content-security-policy']).toContain("object-src 'none'");
  expect(headers['content-security-policy']).toContain("base-uri 'none'");
  expect(headers['x-frame-options']).toBe('DENY');
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['referrer-policy']).toBe('no-referrer');
}

test.describe('Sign-in page', () => {
  test.skip(!process.env.TEST_BASE_URL, SKIP_REASON);

  test('sign-in page loads with 200 status', async ({ page }) => {
    const response = await page.goto('/sign-in');
    expect(response?.status()).toBe(200);
  });

  test('sign-in page serves CSP, nosniff, and frame-deny protections', async ({ page }) => {
    const response = await page.goto('/sign-in');
    expect(response?.status()).toBe(200);
    expectHtmlSecurityHeaders(response?.headers() ?? {});
  });

  test('sign-in page has Discord OAuth button', async ({ page }) => {
    await page.goto('/sign-in');

    const discordBtn = page.locator('#discord-signin-btn');
    // Button must exist in the DOM
    await expect(discordBtn).toBeAttached();

    // Button text must reference Discord
    const btnText = await discordBtn.textContent();
    expect(btnText?.toLowerCase()).toContain('discord');
  });

  test('clicking Discord button navigates to the Discord OAuth endpoint', async ({ page }) => {
    // This test requires the server to be fully configured with Discord client credentials
    // and a reachable auth backend. Skip in environments where those are unavailable.
    test.skip(
      !process.env.DISCORD_CLIENT_ID,
      'Requires DISCORD_CLIENT_ID env var — Discord OAuth flow needs real credentials'
    );

    // Intercept any navigation toward discord.com so we verify the redirect
    // without actually leaving the test origin.
    let discordOAuthUrl = '';
    await page.route('https://discord.com/**', (route) => {
      discordOAuthUrl = route.request().url();
      route.abort('aborted');
    });

    await page.goto('/sign-in');

    // The button href is set by server-injected JS on DOMContentLoaded.
    // Wait until the href is no longer the initial "#" placeholder.
    await page.waitForFunction(() => {
      const btn = document.getElementById('discord-signin-btn') as HTMLAnchorElement | null;
      return btn !== null && btn.href !== '' && !btn.href.endsWith('#');
    });

    const discordBtn = page.locator('#discord-signin-btn');
    await discordBtn.click();

    // Allow the redirect chain (local auth → discord.com) to be initiated
    await page.waitForTimeout(2000);

    expect(discordOAuthUrl).toContain('discord.com/oauth2');
  });

  test('sign-in page constrains redirect targets to safe relative paths', async ({ page }) => {
    await page.goto('/sign-in?redirectTo=//evil.example/phish');

    await page.waitForFunction(() => {
      const btn = document.getElementById('discord-signin-btn') as HTMLAnchorElement | null;
      return btn !== null && btn.href !== '' && !btn.href.endsWith('#');
    });

    const discordHref = await page.locator('#discord-signin-btn').getAttribute('href');
    expect(discordHref).toBeTruthy();
    expect(discordHref).not.toContain('evil.example');

    const callbackUrl = new URL(discordHref ?? '').searchParams.get('callbackURL');
    expect(callbackUrl).toBeTruthy();
    expect(callbackUrl).toContain('/sign-in');
    expect(callbackUrl).toContain('redirectTo=%2Fdashboard');
  });

  test('sign-in page does not leak expired OTTs into the DOM after the browser handles them', async ({
    page,
  }) => {
    const response = await page.goto('/sign-in?ott=phase8-secret-ott-token');
    expect(response?.status()).toBe(200);

    await expect(page).toHaveURL(/\/sign-in$/);
    const bodyHtml = await page.evaluate(() => document.body.innerHTML);
    expect(bodyHtml).not.toContain('phase8-secret-ott-token');
    await expect(page.locator('#error-detail')).toContainText('expired');
  });
});
