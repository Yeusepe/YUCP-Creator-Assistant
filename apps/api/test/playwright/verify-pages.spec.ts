import { expect, test } from 'playwright/test';

const SKIP_REASON =
  'Requires TEST_BASE_URL env var pointing to a running API server (e.g. TEST_BASE_URL=http://localhost:3001)';

test.describe('Verify Success page', () => {
  test.skip(!process.env.TEST_BASE_URL, SKIP_REASON);

  test('page loads with 200 status', async ({ page }) => {
    const response = await page.goto('/verify-success');
    expect(response?.status()).toBe(200);
  });

  test('page has success heading', async ({ page }) => {
    await page.goto('/verify-success');
    // h1 is rendered in the DOM from initial HTML; content is accessible via textContent
    // even before the JS loading overlay fades out.
    const h1Text = await page.locator('h1').first().textContent();
    expect(h1Text?.toLowerCase()).toMatch(/verified/);
  });

  test('page has no broken images (all img src attributes are resolved)', async ({ page }) => {
    await page.goto('/verify-success');
    const imgSrcs: (string | null)[] = await page.evaluate(() =>
      Array.from(document.querySelectorAll('img')).map((img) => img.getAttribute('src'))
    );
    expect(imgSrcs.length).toBeGreaterThan(0);
    for (const src of imgSrcs) {
      expect(src).toBeTruthy();
      // Server must replace __API_BASE__ placeholder before sending HTML
      expect(src).not.toContain('__API_BASE__');
    }
  });

  test('page title is set (not empty, not "undefined")', async ({ page }) => {
    await page.goto('/verify-success');
    const title = await page.title();
    expect(title).toBeTruthy();
    expect(title).not.toBe('undefined');
    expect(title.length).toBeGreaterThan(0);
  });
});

test.describe('Verify Error page', () => {
  test.skip(!process.env.TEST_BASE_URL, SKIP_REASON);

  test('page loads with 200 status', async ({ page }) => {
    const response = await page.goto('/verify-error');
    expect(response?.status()).toBe(200);
  });

  test('page has error heading', async ({ page }) => {
    await page.goto('/verify-error');
    const h1Text = await page.locator('h1').first().textContent();
    expect(h1Text?.toLowerCase()).toMatch(/wrong|error|fail/);
  });

  test('page has actionable content (not a raw error stack trace)', async ({ page }) => {
    await page.goto('/verify-error');
    const bodyHtml = await page.evaluate(() => document.body.innerHTML);

    // Must not expose raw Node/Bun stack traces to the browser
    expect(bodyHtml).not.toMatch(/Error: .+\n\s+at /);
    expect(bodyHtml).not.toContain('at Object.<anonymous>');

    // Must surface at least one user-facing clickable element
    const actionableCount = await page.locator('a[href], button').count();
    expect(actionableCount).toBeGreaterThan(0);
  });

  test('page title is set (not empty, not "undefined")', async ({ page }) => {
    await page.goto('/verify-error');
    const title = await page.title();
    expect(title).toBeTruthy();
    expect(title).not.toBe('undefined');
    expect(title.length).toBeGreaterThan(0);
  });
});
