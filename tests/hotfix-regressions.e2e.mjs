import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

// B3
test('composer controls are immutable while save is in flight', async ({ page }) => {
  const editor = page.getByRole('textbox', { name: 'Rich text editor' });
  await editor.fill('submitted snapshot');
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  await page.route('**/api/messages', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    await gate; return route.continue();
  });
  const send = page.locator('.send-button');
  await send.click();
  await expect(send).toContainText('Saving');
  await expect(editor).toHaveAttribute('contenteditable', 'false');
  await expect(page.getByRole('button', { name: 'Attach files' })).toBeDisabled();
  release();
  await expect(page.locator('.entry-card', { hasText: 'submitted snapshot' })).toBeVisible();
});

// B4
test('failed attachment must be removed before sending text', async ({ page }) => {
  await page.route('**/api/files/**', async (route) => route.fulfill({ status: 413, contentType: 'application/json', body: JSON.stringify({ error: 'forced upload failure' }) }));
  await page.getByRole('textbox', { name: 'Rich text editor' }).fill('do not silently omit the file');
  await page.locator('input[type="file"][multiple]').setInputFiles({ name: 'required.txt', mimeType: 'text/plain', buffer: Buffer.from('required') });
  const chip = page.locator('.composer-file', { hasText: 'required.txt' });
  await expect(chip).toHaveClass(/is-error/);
  await expect(page.getByRole('button', { name: 'Send entry' })).toBeDisabled();
  await chip.getByRole('button', { name: 'Remove required.txt' }).click();
  await expect(page.getByRole('button', { name: 'Send entry' })).toBeEnabled();
});
