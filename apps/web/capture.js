const { chromium } = require('playwright');
const fs = require('node:fs');

(async () => {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.route('**/*', async (route) => {
      route.continue();
    });

    console.log('Navigating...');
    await page.goto('http://127.0.0.1:3000/account', { waitUntil: 'load' });

    const html = await page.evaluate(() => {
      return document.body.innerHTML;
    });

    fs.writeFileSync('scratch_results.txt', html);
    console.log('Done');
  } catch (e) {
    console.error(e);
  } finally {
    if (browser) await browser.close();
  }
})();
