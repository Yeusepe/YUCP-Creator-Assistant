import { access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'playwright/test';

const defaultUploadPath = path.join(
  os.homedir(),
  'Downloads',
  'Novaspil Kitbash Test License Verification_1.0.0.unitypackage'
);
const uploadPath = process.env.YUCP_FORENSICS_TEST_UPLOAD_PATH ?? defaultUploadPath;
const baseURL = 'http://localhost:3100';

async function fileExists(filePath: string) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

test('supported unitypackage is analyzed instead of being reported as having no eligible assets', async ({
  page,
  context,
}) => {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });

  test.skip(
    !(await fileExists(uploadPath)),
    `Upload fixture not found: ${uploadPath}. Set YUCP_FORENSICS_TEST_UPLOAD_PATH to a supported .unitypackage file.`
  );

  await context.addCookies([
    {
      name: 'yucp.session_token',
      value: 'e2e-session-token',
      url: baseURL,
      httpOnly: true,
      sameSite: 'Lax',
    },
  ]);

  await page.goto('/dashboard/forensics');
  await page.waitForLoadState('networkidle');
  await expect(page).toHaveURL(/\/dashboard\/forensics(?:\?.*)?$/);
  expect(pageErrors, `Page errors: ${pageErrors.join('\n')}`).toEqual([]);
  expect(consoleErrors, `Console errors: ${consoleErrors.join('\n')}`).toEqual([]);

  await expect(page.getByRole('heading', { name: 'Coupling Forensics' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Novaspil Test Package/i })).toBeVisible();

  await page.locator('#forensics-file').setInputFiles(uploadPath);
  await page.getByRole('button', { name: 'Scan upload' }).click();

  await expect(page.getByText('No coupling signals found')).toBeVisible();
  await expect(page.getByText('No eligible assets found')).toHaveCount(0);
});
