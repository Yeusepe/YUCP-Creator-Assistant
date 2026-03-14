import { test, expect } from 'playwright/test';

const SKIP_REASON =
  'Requires TEST_BASE_URL env var pointing to a running API server (e.g. TEST_BASE_URL=http://localhost:3001)';

test.describe('OAuth consent page', () => {
  test.skip(!process.env.TEST_BASE_URL, SKIP_REASON);

  test('OAuth consent page loads with 200 status', async ({ page }) => {
    // The consent page is served with a 200 regardless of whether query params
    // are present; missing values fall back to safe defaults.
    const response = await page.goto('/oauth/consent?client_id=test-app&scope=verification:read&consent_code=abc');
    expect(response?.status()).toBe(200);
  });

  test('OAuth consent page without client_id param shows default application name', async ({
    page,
  }) => {
    // Without a client_id the server substitutes 'unknown client' as the display name.
    await page.goto('/oauth/consent');
    const bodyHtml = await page.evaluate(() => document.body.innerHTML);
    // The template __CLIENT_ID__ must have been replaced — either with the real
    // client id or with the 'unknown client' fallback.
    expect(bodyHtml).not.toContain('__CLIENT_ID__');
    // The rendered HTML should surface some application name
    expect(bodyHtml.toLowerCase()).toMatch(/unknown client|application|app/);
  });

  test('OAuth consent page shows appropriate content when required params are missing', async ({
    page,
  }) => {
    await page.goto('/oauth/consent');
    // The page must deliver usable HTML — not a raw stack trace or blank body
    const bodyText = await page.evaluate(() => document.body.innerText.trim());
    expect(bodyText.length).toBeGreaterThan(0);
    // Must not expose Node/Bun stack traces to the browser
    expect(bodyText).not.toMatch(/Error: .+\n\s+at /);
    expect(bodyText).not.toContain('at Object.<anonymous>');
  });

  test('OAuth consent page title is set (not empty, not "undefined")', async ({ page }) => {
    await page.goto('/oauth/consent');
    const title = await page.title();
    expect(title).toBeTruthy();
    expect(title).not.toBe('undefined');
    expect(title.length).toBeGreaterThan(0);
  });

  test('OAuth consent page has no raw template literals visible', async ({ page }) => {
    await page.goto('/oauth/consent?client_id=test-app&scope=verification:read&consent_code=abc');
    const bodyHtml = await page.evaluate(() => document.body.innerHTML);
    // Server must replace all __PLACEHOLDER__ tokens before sending HTML
    expect(bodyHtml).not.toMatch(/\$\{[^}]+\}/);
    expect(bodyHtml).not.toContain('__CLIENT_ID__');
    expect(bodyHtml).not.toContain('__SCOPE__');
    expect(bodyHtml).not.toContain('__CONSENT_CODE__');
    expect(bodyHtml).not.toContain('__CONSENT_ACTION__');
  });
});
