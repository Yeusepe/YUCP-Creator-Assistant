const { chromium } = require('playwright');
const fs = require('node:fs');

(async () => {
  let browser;
  let context;
  try {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext();
    const page = await context.newPage();

    console.log('Navigating...');
    await page.goto('http://127.0.0.1:3000/account', { waitUntil: 'load' });

    const html = await page.evaluate(() => {
      return document.body.innerHTML;
    });

    fs.writeFileSync('scratch_results.txt', html);
    console.log('Done');
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    if (context) await context.close();
    if (browser) await browser.close();
  }
})();
