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
  await expect(page.locator('.entry-card', { hasText: 'submitted snapshot' }).first()).toBeVisible();
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

// B5: a partially uploaded inline batch must be cleaned even when a later upload fails.
test('partial inline upload batch is cleaned when a later upload fails', async ({ page, request }) => {
  let uploads = 0;
  const created = [];
  await page.route('**/api/files/**', async (route) => {
    if (route.request().method() !== 'PUT') return route.continue();
    uploads += 1;
    if (uploads === 1) {
      const response = await route.fetch();
      created.push(await response.json());
      return route.fulfill({ response });
    }
    return route.fulfill({ status: 503, body: 'upload unavailable' });
  });
  const editor = page.getByRole('textbox', { name: 'Rich text editor' });
  await editor.evaluate((element) => {
    element.innerHTML = '<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=">';
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste' }));
  });
  await page.locator('.send-button').click();
  await expect(page.locator('.composer-error')).toBeVisible();
  expect(created).toHaveLength(1);
  await expect.poll(async () => (await request.get(created[0].url)).status()).toBe(404);
});

// B5: failures for older claims remain queued even when newer cleanup succeeds.
test('older failed inline cleanup survives later successful cleanup and is retried', async ({ page }) => {
  const uploadedIds = [];
  const deleteIds = [];
  let blockOldCleanup = true;
  await page.route('**/api/messages', async (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'save unavailable' }) }));
  await page.route('**/api/files/**', async (route) => {
    const request = route.request();
    if (request.method() === 'PUT') {
      const response = await route.fetch();
      uploadedIds.push(String((await response.json()).id));
      return route.fulfill({ response });
    }
    if (request.method() !== 'DELETE') return route.continue();
    const id = new URL(request.url()).pathname.split('/').pop();
    deleteIds.push(id);
    if (blockOldCleanup && id === uploadedIds[0]) return route.fulfill({ status: 503, body: 'cleanup unavailable' });
    return route.continue();
  });
  const editor = page.getByRole('textbox', { name: 'Rich text editor' });
  const setImage = () => editor.evaluate((element) => {
    element.innerHTML = '<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=">';
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste' }));
  });
  await setImage();
  await page.locator('.send-button').click();
  await expect(page.locator('.composer-error')).toBeVisible();
  await setImage();
  await page.locator('.send-button').click();
  await expect.poll(() => uploadedIds.length).toBe(2);
  blockOldCleanup = false;
  await setImage();
  await page.locator('.send-button').click();
  await expect.poll(() => deleteIds.filter((id) => id === uploadedIds[0]).length).toBeGreaterThanOrEqual(3);
});

// B3: rejected file drops must not leave the drag overlay stuck over the composer.
test('file drop during save clears the drag overlay', async ({ page }) => {
  const editor = page.getByRole('textbox', { name: 'Rich text editor' });
  await editor.fill('submitted');
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  await page.route('**/api/messages', async (route) => { await gate; return route.continue(); });
  await page.locator('.send-button').click();
  await page.locator('.composer-editor').evaluate((element) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['x'], 'x.txt', { type: 'text/plain' }));
    element.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer: transfer }));
    element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  });
  await expect(page.locator('.drop-overlay')).toHaveCount(0);
  release();
});
