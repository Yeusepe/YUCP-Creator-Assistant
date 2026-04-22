import { chromium } from 'playwright';

(async () => {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    // Route to delay all page loading slightly to make sure we see the skeleton
    await page.route('**/*', async (route) => {
      await new Promise((r) => setTimeout(r, 500));
      await route.continue();
    });

    await page.goto('http://127.0.0.1:3000/account');

    const headerHTML = await page.evaluate(() => {
      const el = document.querySelector('header');
      return el ? el.outerHTML : 'NO HEADER';
    });

    const bodyClasses = await page.evaluate(() => document.body.className);
    const headClasses = await page.evaluate(() => document.documentElement.className);

    console.log('--- HTML ---');
    console.log(headerHTML);
    console.log('--- BODY ---', bodyClasses);
    console.log('--- HTML CLS ---', headClasses);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
})();
