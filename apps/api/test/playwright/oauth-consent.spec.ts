import { expect, test } from 'playwright/test';

// Source: https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html
// Source: https://cheatsheetseries.owasp.org/cheatsheets/Content_Security_Policy_Cheat_Sheet.html

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

test.describe('OAuth consent page', () => {
  test.skip(!process.env.TEST_BASE_URL, SKIP_REASON);

  test('OAuth consent page loads with 200 status', async ({ page }) => {
    // The consent page is served with a 200 regardless of whether query params
    // are present; missing values fall back to safe defaults.
    const response = await page.goto(
      '/oauth/consent?client_id=test-app&scope=verification:read&consent_code=abc'
    );
    expect(response?.status()).toBe(200);
  });

  test('OAuth consent page serves CSP and anti-framing protections', async ({ page }) => {
    const response = await page.goto(
      '/oauth/consent?client_id=test-app&scope=verification:read&consent_code=abc'
    );
    expect(response?.status()).toBe(200);
    expectHtmlSecurityHeaders(response?.headers() ?? {});
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
    expect(bodyHtml).not.toContain('__CLIENT_ID__');
    expect(bodyHtml).not.toContain('__SCOPE__');
    expect(bodyHtml).not.toContain('__CONSENT_CODE__');
    expect(bodyHtml).not.toContain('__CONSENT_ACTION__');
  });

  test('OAuth consent page safely renders attacker-controlled client and scope values', async ({
    page,
  }) => {
    const clientIdPayload = `phase8"><img src=x onerror="window.__phase8ConsentClient=1">`;
    const scopePayload = `verification:read <img src=x onerror="window.__phase8ConsentScope=1">`;

    await page.goto(
      `/oauth/consent?client_id=${encodeURIComponent(clientIdPayload)}&scope=${encodeURIComponent(scopePayload)}&consent_code=abc`
    );

    await expect
      .poll(() =>
        page.evaluate(() => {
          const phase8Window = window as Window & {
            __phase8ConsentClient?: unknown;
            __phase8ConsentScope?: unknown;
          };

          return {
            client: phase8Window.__phase8ConsentClient,
            scope: phase8Window.__phase8ConsentScope,
          };
        })
      )
      .toEqual({ client: undefined, scope: undefined });

    await expect(page.locator('#client-id-display')).toContainText(
      'phase8"><img src=x onerror="window.__phase8ConsentClient=1">'
    );
    await expect(page.locator('img[src="x"]')).toHaveCount(0);
    await expect(page.locator('script')).toHaveCount(1);
    const bodyHtml = await page.evaluate(() => document.body.innerHTML);
    expect(bodyHtml).not.toContain(clientIdPayload);
    expect(bodyHtml).not.toContain(scopePayload);
  });
});
