import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test } from 'playwright/test';

const productAccessCssPath = resolve(import.meta.dirname, '../../src/styles/product-access.css');
const registryCssPath = resolve(
  import.meta.dirname,
  '../../src/styles/dashboard-components/partials/05-registry-tail.css'
);

async function loadStyles(): Promise<string> {
  return `${await readFile(productAccessCssPath, 'utf8')}\n${await readFile(registryCssPath, 'utf8')}`;
}

test.describe('narrow package access layout', () => {
  for (const width of [320, 420]) {
    test(`contains long manual URLs at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 760 });
      await page.setContent(`
        <main class="vpa-card" style="width:100%; box-sizing:border-box">
          <section class="vpa-manual">
            <button class="vpa-manual-toggle" type="button">
              Manual setup and troubleshooting
            </button>
            <div class="vpa-manual-panel is-open">
              <div>
                <div class="vpa-repo-box">
                  <p class="vpa-repo-url">${'https://localhost.example.test/vcc/'.padEnd(420, 'a')}</p>
                  <button class="vpa-repo-copy" type="button">Copy</button>
                </div>
              </div>
            </div>
          </section>
        </main>
      `);
      await page.addStyleTag({ content: await loadStyles() });

      const measurements = await page.locator('.vpa-repo-box').evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const url = element.querySelector('.vpa-repo-url')?.getBoundingClientRect();
        const copy = element.querySelector('.vpa-repo-copy')?.getBoundingClientRect();
        return {
          clientWidth: element.clientWidth,
          documentWidth: document.documentElement.scrollWidth,
          left: rect.left,
          right: rect.right,
          scrollWidth: element.scrollWidth,
          urlBottom: url?.bottom ?? 0,
          copyTop: copy?.top ?? 0,
          viewportWidth: window.innerWidth,
        };
      });
      expect(measurements.documentWidth).toBeLessThanOrEqual(width);
      expect(measurements.scrollWidth).toBeLessThanOrEqual(measurements.clientWidth);
      expect(measurements.left).toBeGreaterThanOrEqual(0);
      expect(measurements.right).toBeLessThanOrEqual(measurements.viewportWidth);
      expect(measurements.copyTop).toBeGreaterThanOrEqual(measurements.urlBottom);
      await expect(page.locator('.vpa-repo-copy')).toHaveCSS('min-height', '44px');
    });
  }

  for (const width of [320, 420]) {
    test(`keeps upload footer actions clear at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 420 });
      await page.setContent(`
        <div style="height:100vh; display:flex; flex-direction:column; overflow:hidden">
          <div style="min-height:0; flex:1; overflow:auto">Upload content</div>
          <footer class="pm-sheet-footer">
            <button type="button" style="height:44px">Cancel</button>
            <button type="button" style="height:44px">Upload package</button>
          </footer>
        </div>
      `);
      await page.addStyleTag({ content: 'body { margin: 0; }' });
      await page.addStyleTag({ content: await loadStyles() });

      const footer = page.locator('.pm-sheet-footer');
      const footerBox = await footer.boundingBox();
      const uploadBox = await page.getByRole('button', { name: 'Upload package' }).boundingBox();
      expect(footerBox).not.toBeNull();
      expect(uploadBox).not.toBeNull();
      if (!footerBox || !uploadBox) {
        throw new Error('Expected visible package footer actions');
      }
      expect(420 - (uploadBox.y + uploadBox.height)).toBeGreaterThanOrEqual(20);
      expect(footerBox.height - uploadBox.height).toBeGreaterThanOrEqual(20);
    });
  }

  test('disables access animations for reduced motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setContent(`
      <article class="vpa-card">
        <span class="vpa-step-bag"><span class="plo-bag-outline"></span></span>
        <div class="vpa-manual-panel is-open"></div>
      </article>
    `);
    await page.addStyleTag({ content: await loadStyles() });

    await expect(page.locator('.vpa-card')).toHaveCSS('animation-name', 'none');
    await expect(page.locator('.plo-bag-outline')).toHaveCSS('animation-name', 'none');
    await expect(page.locator('.vpa-manual-panel')).toHaveCSS('transition-property', 'none');
  });
});
