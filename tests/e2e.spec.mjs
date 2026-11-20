import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const tinyImage = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

async function accessibilityInsightsScan(page, testInfo) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  await testInfo.attach('accessibility-insights-automated-checks', {
    body: JSON.stringify(results, null, 2),
    contentType: 'application/json',
  });
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.app-shell')).toBeVisible();
});

test('desktop layout fills viewport and keeps composer action visible', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.locator('.entries-panel')).toBeVisible();
  await expect(page.locator('.composer-panel')).toBeVisible();
  await expect(page.getByText(/^v1\.6\.1$/)).toBeVisible();
  const entries = await page.locator('.entries-panel').boundingBox();
  const composer = await page.locator('.composer-panel').boundingBox();
  const send = await page.getByRole('button', { name: 'Send entry' }).boundingBox();
  expect(entries.x).toBeLessThan(composer.x);
  expect(send.y + send.height).toBeLessThanOrEqual(900);
});

test('composer collapses horizontally and restores', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const before = await page.locator('.entries-panel').boundingBox();
  await page.getByRole('button', { name: 'Collapse composer' }).click();
  await expect(page.locator('.composer-panel')).toHaveClass(/is-collapsed/);
  await page.waitForTimeout(400);
  const after = await page.locator('.entries-panel').boundingBox();
  expect(after.width).toBeGreaterThan(before.width);
  await page.getByRole('button', { name: 'Expand composer' }).click();
  await expect(page.locator('.composer-panel')).not.toHaveClass(/is-collapsed/);
});

test('creates, copies rich text with an image, and deletes an entry', async ({ page, context }) => {
  await page.evaluate(() => {
    const stored = { items: [] };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      write: async (items) => { stored.items = items; },
      read: async () => stored.items,
      readText: async () => (stored.items[0] ? stored.items[0].getType('text/plain').then((blob) => blob.text()) : ''),
    } });
    window.ClipboardItem = class ClipboardItem {
      constructor(items) { this.items = items; this.types = Object.keys(items); }
      getType(type) { return Promise.resolve(this.items[type]); }
    };
  });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const marker = `QA-${Date.now()}`;
  const editor = page.locator('.rich-editor');
  await editor.fill(marker);
  await page.evaluate(({ marker: value, image }) => {
    const target = document.querySelector('.rich-editor');
    target.innerHTML = `<p><strong>${value}</strong></p><p><img alt="Test pixel" src="${image}"></p>`;
    target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
  }, { marker, image: tinyImage });
  await page.getByRole('button', { name: 'Send entry' }).click();
  const card = page.locator('.entry-card', { hasText: marker });
  await expect(card).toBeVisible();
  await expect(card.locator('img')).toBeVisible();
  await card.getByRole('button', { name: 'Copy entry' }).click();
  const clipboard = await page.evaluate(async () => ({
    text: await navigator.clipboard.readText(),
    types: (await navigator.clipboard.read())[0]?.types || [],
  }));
  expect(clipboard.text).toContain(marker);
  expect(clipboard.types).toContain('text/html');
  await card.getByRole('button', { name: 'Delete entry' }).click();
  await expect(card).toHaveCount(0);
});

test('mobile layout remains usable without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: 'Send entry' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
});

test('Accessibility Insights automated checks find no WCAG A/AA violations', async ({ page }, testInfo) => {
  await accessibilityInsightsScan(page, testInfo);
  await page.getByRole('button', { name: 'Collapse composer' }).click();
  await accessibilityInsightsScan(page, testInfo);
});

test('accessibility: User guide dialog and focus return', async ({ page }, testInfo) => {
  const guide = page.getByRole('button', { name: /guide/i }).first();
  await guide.click();
  await expect(page.getByRole('dialog', { name: 'User guide' })).toBeVisible();
  await accessibilityInsightsScan(page, testInfo);
  await page.keyboard.press('Escape');
  await expect(guide).toBeFocused();
});

test('Accessibility Insights tab-stop check has logical focus order and no traps', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.reload();
  const names = [];
  for (let index = 0; index < 200; index += 1) {
    await page.keyboard.press('Tab');
    const name = await page.evaluate(() => document.activeElement?.getAttribute('aria-label') || document.activeElement?.textContent?.trim() || document.activeElement?.className);
    names.push(name);
    if (names.includes('Collapse composer') && names.includes('Rich text editor') && names.includes('Bold')) break;
  }
  expect(names[0]).toContain('Skip to saved entries');
  expect(names).toContain('Collapse composer');
  expect(names).toContain('Rich text editor');
  expect(names).toContain('Bold');
  await expect(page.getByRole('button', { name: 'Send entry' })).toBeDisabled();
  expect(names).not.toContain('Send entry');
});

test('formatting toolbar works with keyboard activation', async ({ page }) => {
  const editor = page.getByRole('textbox', { name: 'Rich text editor' });
  await editor.fill('keyboard formatting');
  await editor.press('Control+A');
  const bold = page.getByRole('button', { name: 'Bold' });
  await bold.focus();
  await page.keyboard.press('Enter');
  await expect(editor.locator('b, strong')).toContainText('keyboard formatting');
});

test('200 percent zoom equivalent reflows without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 700 });
  await expect(page.getByRole('button', { name: 'Send entry' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
});

test('search matches visible text after HTML entity decoding', async ({ page, request }) => {
  const marker = `entity-${Date.now()}`;
  const created = await request.post('/api/messages', {
    data: { text: `<p>${marker} Alpha &amp; Beta <strong>Needle</strong></p>` },
  });
  const entry = await created.json();
  try {
    await page.reload();
    await page.getByRole('searchbox', { name: 'Search entries' }).fill(`${marker} alpha & beta`);
    await expect(page.locator('.entry-card', { hasText: marker })).toBeVisible();
  } finally {
    await request.delete(`/api/messages/${entry.id}`);
  }
});

test('auto-refresh observes a remote pin change when ordering stays unchanged', async ({ page, request }) => {
  const marker = `pin-sync-${Date.now()}`;
  const older = await (await request.post('/api/messages', { data: { text: `${marker}-older` } })).json();
  const newest = await (await request.post('/api/messages', { data: { text: `${marker}-newest` } })).json();
  try {
    await page.reload();
    await page.getByRole('button', { name: /Auto-refresh/ }).click();
    const pinned = await request.patch(`/api/messages/${newest.id}`, { data: { is_pinned: true } });
    expect(pinned.status()).toBe(200);
    const newestCard = page.locator('.entry-card', { hasText: `${marker}-newest` });
    await expect(newestCard.getByRole('button', { name: 'Unpin' })).toBeVisible({ timeout: 5000 });
  } finally {
    await request.delete(`/api/messages/${newest.id}`);
    await request.delete(`/api/messages/${older.id}`);
  }
});

test('web addresses get an open-in-new-tab icon that keeps the visible text and its punctuation together', async ({ page, request }) => {
  const marker = `links-${Date.now()}`;
  const created = await request.post('/api/messages', {
    data: { text: `<p>${marker} see https://example.com/docs/page. Then (https://example.org/a_(b)), done</p><p>A <a href="https://example.net/rich">rich link</a>.</p><p>javascript:alert(1)</p>` },
  });
  const entry = await created.json();
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.reload();
    const content = page.locator('.entry-card', { hasText: marker }).locator('.entry-content');
    await expect(content).toBeVisible();
    const icons = content.locator('a.link-open');
    await expect(icons).toHaveCount(3);
    expect(await icons.evaluateAll((links) => links.map((link) => [link.getAttribute('href'), link.target, link.rel]))).toEqual([
      ['https://example.com/docs/page', '_blank', 'noopener noreferrer'],
      ['https://example.org/a_(b)', '_blank', 'noopener noreferrer'],
      ['https://example.net/rich', '_blank', 'noopener noreferrer'],
    ]);
    await expect(icons.first()).toHaveAccessibleName('Open link in a new tab');
    await expect(content.getByRole('link', { name: 'rich link' })).toHaveAttribute('target', '_blank');
    expect((await content.innerText()).replace(/\s+/g, ' ').trim())
      .toBe(`${marker} see https://example.com/docs/page. Then (https://example.org/a_(b)), done A rich link. javascript:alert(1)`);

    // At any width, the end of each address, its icon and the punctuation after it share one line.
    const splits = await content.evaluate((element) => {
      const overlap = (a, b) => a.top < b.bottom && b.top < a.bottom;
      const textRect = (node) => { const range = document.createRange(); range.selectNodeContents(node); return range.getBoundingClientRect(); };
      let count = 0;
      for (let width = 140; width <= 640; width += 4) {
        element.style.width = `${width}px`;
        for (const tail of element.querySelectorAll('.link-tail')) {
          const icon = tail.querySelector('.link-open').getBoundingClientRect();
          const texts = [...tail.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE);
          if (texts.some((node) => !overlap(textRect(node), icon))) count += 1;
        }
      }
      element.style.width = '';
      return count;
    });
    expect(splits).toBe(0);
  } finally {
    await request.delete(`/api/messages/${entry.id}`);
  }
});

test('copying an entry gives the stored entry without link icons, also through the legacy copy fallback', async ({ page, request }) => {
  const marker = `copy-links-${Date.now()}`;
  const entry = await (await request.post('/api/messages', { data: { text: `<p>${marker} https://example.com/x.</p>` } })).json();
  try {
    await page.reload();
    const card = page.locator('.entry-card', { hasText: marker });
    await expect(card.locator('a.link-open')).toHaveCount(1);

    await page.evaluate(() => {
      window.copiedItems = [];
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { write: async (items) => { window.copiedItems = items; } } });
      window.ClipboardItem = class ClipboardItem { constructor(items) { this.items = items; } };
    });
    await card.getByRole('button', { name: 'Copy entry' }).click();
    const modern = await page.evaluate(async () => (await window.copiedItems[0].items['text/html']).text());
    expect(modern).toContain(marker);
    expect(modern).not.toContain('link-open');

    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
      window.ClipboardItem = undefined;
      document.execCommand = (command) => {
        if (command === 'copy') {
          const box = document.createElement('div');
          box.append(window.getSelection().getRangeAt(0).cloneContents());
          window.legacyCopy = box.innerHTML;
        }
        return true;
      };
    });
    await card.getByRole('button', { name: 'Copy entry' }).click();
    const legacy = await page.evaluate(() => window.legacyCopy);
    expect(legacy).toContain(marker);
    expect(legacy).not.toContain('link-open');
  } finally {
    await request.delete(`/api/messages/${entry.id}`);
  }
});

test('a file attached in the composer is sent with the entry and can be downloaded', async ({ page, request }) => {
  const name = `notes-${Date.now()}.txt`;
  await expect(page.locator('.file-limits')).toContainText('100 MB');
  await page.locator('input[type="file"][multiple]').setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from('lab notes') });
  await expect(page.locator('.composer-file', { hasText: name })).toHaveClass(/is-done/);
  await page.getByRole('button', { name: 'Send entry' }).click();
  const card = page.locator('.entry-card', { hasText: name });
  await expect(card.locator('.file-name')).toHaveText(name);
  const download = await request.get(await card.locator('.file-name').getAttribute('href'));
  expect(download.headers()['content-disposition']).toMatch(/^attachment;/);
  expect(await download.text()).toBe('lab notes');
  const id = (await card.locator('.entry-id').innerText()).replace('#', '');
  await request.delete(`/api/messages/${id}`);
});
