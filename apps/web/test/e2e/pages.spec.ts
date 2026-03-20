import { expect, test } from 'playwright/test';

/**
 * E2E tests to verify all routes render without crashes.
 * These tests check that pages load, contain expected content,
 * and don't throw JavaScript errors.
 */

test.describe('Page Rendering', () => {
  test('sign-in page renders with Discord button', async ({ page }) => {
    await page.goto('/sign-in');
    await expect(page.locator('.card-title')).toContainText('Creator Assistant');
    await expect(page.locator('#discord-signin-btn')).toBeVisible();
  });

  test('sign-in page keeps dashboard auth independent from guild selection', async ({ page }) => {
    await page.goto('/sign-in?redirectTo=%2Fdashboard%3Fguild_id%3D123');

    await expect(page.locator('#discord-signin-btn')).toBeVisible();
  });

  test('404 page renders for unknown routes', async ({ page }) => {
    await page.goto('/some-nonexistent-page');
    await expect(page).toHaveTitle(/Page Not Found/);
  });

  test('legal/terms page renders', async ({ page }) => {
    await page.goto('/legal/terms-of-service');
    await expect(page.locator('h1')).toContainText('Terms of Service');
  });

  test('legal/privacy page renders', async ({ page }) => {
    await page.goto('/legal/privacy-policy');
    await expect(page.locator('h1')).toContainText('Privacy Policy');
  });

  test('verify/success page renders', async ({ page }) => {
    await page.goto('/verify/success');
    await expect(page).toHaveTitle(/Creator Assistant/);
  });

  test('verify/error page renders', async ({ page }) => {
    await page.goto('/verify/error');
    await expect(page).toHaveTitle(/Creator Assistant/);
  });

  test('oauth/login page renders', async ({ page }) => {
    await page.goto('/oauth/login');
    await expect(page).toHaveTitle(/Creator Assistant/);
  });

  test('oauth/consent page renders', async ({ page }) => {
    await page.goto('/oauth/consent');
    await expect(page).toHaveTitle(/Creator Assistant/);
  });

  test('oauth/error page renders', async ({ page }) => {
    await page.goto('/oauth/error');
    await expect(page).toHaveTitle(/Creator Assistant/);
  });

  test('connect page renders', async ({ page }) => {
    await page.goto('/connect?userId=test&guildId=test');
    await expect(page).toHaveTitle(/Creator Assistant/);
  });

  test('collab-invite page renders', async ({ page }) => {
    await page.goto('/collab-invite?token=test');
    await expect(page).toHaveTitle(/Creator Assistant/);
  });
});

test.describe('Navigation', () => {
  test('root redirects to sign-in', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/sign-in/);
  });
});

test.describe('SSR Validation', () => {
  test('sign-in page returns pre-rendered HTML', async ({ request }) => {
    const response = await request.get('/sign-in');
    expect(response.status()).toBe(200);
    const html = await response.text();
    expect(html).toContain('Creator Assistant');
    expect(html).toContain('discord-signin-btn');
  });

  test('legal/terms returns pre-rendered content', async ({ request }) => {
    const response = await request.get('/legal/terms-of-service');
    expect(response.status()).toBe(200);
    const html = await response.text();
    expect(html).toContain('Terms of Service');
  });
});

test.describe('No JavaScript Errors', () => {
  const routes = [
    '/sign-in',
    '/dashboard',
    '/dashboard/integrations',
    '/dashboard/collaboration',
    '/legal/terms-of-service',
    '/legal/privacy-policy',
    '/verify/success',
    '/verify/error',
    '/oauth/login',
    '/oauth/error',
    '/connect?userId=test&guildId=test',
    '/collab-invite?token=test',
  ];

  for (const route of routes) {
    test(`no runtime errors or 5xx responses on ${route}`, async ({ page }) => {
      const runtimeIssues: string[] = [];
      page.on('pageerror', (error) => runtimeIssues.push(`pageerror: ${error.message}`));
      page.on('console', (message) => {
        if (message.type() === 'error') {
          runtimeIssues.push(`console.error: ${message.text()}`);
        }
      });
      page.on('requestfailed', (request) => {
        runtimeIssues.push(
          `requestfailed: ${request.method()} ${request.url()} :: ${request.failure()?.errorText ?? 'unknown'}`
        );
      });
      page.on('response', (response) => {
        if (response.status() >= 500) {
          runtimeIssues.push(
            `response.${response.status()}: ${response.request().method()} ${response.url()}`
          );
        }
      });

      await page.goto(route, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => document.readyState === 'complete');
      await page.waitForTimeout(1500);

      expect(
        runtimeIssues,
        runtimeIssues.join('\n') || `Unexpected runtime issues on ${route}`
      ).toEqual([]);
    });
  }
});
