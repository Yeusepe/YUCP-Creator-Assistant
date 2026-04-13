import { expect, test } from 'playwright/test';

// Source: https://cheatsheetseries.owasp.org/cheatsheets/Unvalidated_Redirects_and_Forwards_Cheat_Sheet.html

const SKIP_REASON =
  'Requires TEST_BASE_URL env var pointing to a running API server (e.g. TEST_BASE_URL=http://localhost:3001)';

test.describe('Sign-in page', () => {
  test.skip(!process.env.TEST_BASE_URL, SKIP_REASON);

  test('sign-in page loads with 200 status', async ({ page }) => {
    const response = await page.goto('/sign-in');
    expect(response?.status()).toBe(200);
  });

  test('sign-in page resolves through the frontend handoff and renders the auth action', async ({
    page,
  }) => {
    await page.goto('/sign-in');
    await expect(page).toHaveURL(/\/sign-in$/);
    await expect(page.locator('#discord-signin-btn')).toBeAttached();
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
      'Requires DISCORD_CLIENT_ID env var, Discord OAuth flow needs real credentials'
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
    let capturedPostData: string | null = null;
    await page.route('**/api/auth/sign-in/**', async (route) => {
      capturedPostData = route.request().postData();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ url: 'https://discord.com/oauth2/authorize?client_id=test' }),
      });
    });

    await page.goto('/sign-in?redirectTo=//evil.example/phish');
    await page.locator('#discord-signin-btn').click();
    await expect.poll(() => capturedPostData).not.toBeNull();

    const payload = JSON.parse(capturedPostData ?? '{}') as { callbackURL?: string };
    expect(payload.callbackURL).toBe('/dashboard');
  });

  test('sign-in page does not leak OTT values into rendered HTML', async ({ page }) => {
    const response = await page.goto('/sign-in?ott=phase8-secret-ott-token');
    expect(response?.status()).toBe(200);

    const bodyHtml = await page.evaluate(() => document.body.innerHTML);
    expect(bodyHtml).not.toContain('phase8-secret-ott-token');
    await expect(page.locator('#discord-signin-btn')).toBeAttached();
  });
});
