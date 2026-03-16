import { expect, test } from 'playwright/test';

const SKIP_REASON =
  'Requires TEST_BASE_URL env var pointing to a running API server (e.g. TEST_BASE_URL=http://localhost:3001)';

test.describe('Collab invite page', () => {
  test.skip(!process.env.TEST_BASE_URL, SKIP_REASON);

  test('page loads with 200 status', async ({ page }) => {
    const response = await page.goto('/collab-invite', { waitUntil: 'commit' });
    expect(response?.status()).toBe(200);
  });

  test('#page-content becomes visible after load (is-visible class added)', async ({ page }) => {
    await page.goto('/collab-invite', { waitUntil: 'load' });
    // The module script adds is-visible via requestAnimationFrame — wait for it.
    await expect(page.locator('#page-content')).toHaveClass(/is-visible/, { timeout: 3000 });
  });

  test('#page-content is not permanently transparent (opacity not stuck at 0)', async ({
    page,
  }) => {
    await page.goto('/collab-invite', { waitUntil: 'load' });
    await page.waitForTimeout(500);
    const opacity = await page.evaluate(
      () => window.getComputedStyle(document.getElementById('page-content')!).opacity
    );
    expect(Number(opacity)).toBeGreaterThan(0.5);
  });

  test('page shows loading stage on first visit without a token', async ({ page }) => {
    await page.goto('/collab-invite', { waitUntil: 'load' });
    // Without a valid collab session cookie, it should show an error or the consent stage,
    // but never remain stuck on stage-loading.
    await page.waitForTimeout(2000);
    const loadingVisible = await page.evaluate(() => {
      const el = document.getElementById('stage-loading');
      return el ? el.classList.contains('active') : false;
    });
    // stage-loading should have been replaced by either stage-error or stage-consent
    expect(loadingVisible).toBe(false);
  });

  test('page shows error stage when hash token is invalid', async ({ page }) => {
    await page.goto('/collab-invite#t=invalidtoken123', { waitUntil: 'load' });
    // Should surface an error — not a blank screen
    await page.waitForTimeout(2000);
    const errorVisible = await page.evaluate(() => {
      const el = document.getElementById('stage-error');
      return el ? el.classList.contains('active') : false;
    });
    expect(errorVisible).toBe(true);
  });

  test('page has no unresolved __API_BASE__ placeholders', async ({ page }) => {
    await page.goto('/collab-invite', { waitUntil: 'load' });
    const bodyHtml = await page.evaluate(() => document.body.innerHTML);
    expect(bodyHtml).not.toContain('__API_BASE__');
  });
});
