import { test, expect } from 'playwright/test';

const SKIP_REASON = 'Requires TEST_BASE_URL env var pointing to a running API server (e.g. TEST_BASE_URL=http://localhost:3001)';

test.describe('Sign-in page', () => {
  test.skip(!process.env.TEST_BASE_URL, SKIP_REASON);

  test('sign-in page loads with 200 status', async ({ page }) => {
    const response = await page.goto('/sign-in');
    expect(response?.status()).toBe(200);
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
    await page.route('https://discord.com/**', route => {
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
});
