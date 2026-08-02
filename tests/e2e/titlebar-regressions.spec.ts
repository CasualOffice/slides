import { expect, test, type Page } from '@playwright/test';

async function waitForDeck(page: Page) {
  await page.goto('/');
  await page.waitForFunction(
    () => typeof (window as { __casualSlides_getPptxClient?: unknown }).__casualSlides_getPptxClient === 'function',
    null,
    { timeout: 15_000 },
  );
}

async function readLiveTitle(page: Page): Promise<string> {
  return page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any;
    return w.univer.__getInjector()
      .get(w.__casualSlides__IUniverInstanceService)
      .getCurrentUnitOfType(3)
      .getSnapshot().title;
  });
}

async function readSelection(page: Page): Promise<{ pageId: string; elementId: string } | null> {
  return page.evaluate(() => (window as Window & {
    __casualSlides_getSelection?: () => { pageId: string; elementId: string } | null;
  }).__casualSlides_getSelection?.() ?? null);
}

test('rename updates Properties and the live slide model title', async ({ page }) => {
  await waitForDeck(page);
  const title = 'QA title regression';
  const titleButton = page.locator('button.cs-titlebar__filename');

  await titleButton.click();
  const titleInput = page.locator('input.cs-titlebar__filename-input');
  await titleInput.fill(title);
  await titleInput.press('Enter');
  await expect(titleButton).toHaveText(title);

  const fileMenu = page.locator('nav.cs-titlebar__row--menus').getByRole('button', { name: 'File', exact: true });
  await fileMenu.click();
  await page.getByRole('button', { name: 'Properties', exact: true }).click();
  await expect(page.getByTestId('properties-dialog')).toBeVisible();

  expect.soft(await readLiveTitle(page), 'canonical live model title').toBe(title);
  await expect.soft(page.getByTestId('prop-title').locator('dd'), 'Properties title').toHaveText(title);
});

test('Escape closes View and File menus and restores their trigger focus', async ({ page }) => {
  await waitForDeck(page);
  const menuStrip = page.locator('nav.cs-titlebar__row--menus');

  await menuStrip.getByRole('button', { name: 'Insert', exact: true }).click();
  await menuStrip.getByRole('button', { name: 'Shape', exact: true }).click();
  await expect.poll(() => readSelection(page)).not.toBeNull();
  const selected = await readSelection(page);
  await expect(page.getByTestId('format-pane')).toBeVisible();

  for (const name of ['View', 'File']) {
    const trigger = menuStrip.getByRole('button', { name, exact: true });
    const popup = trigger.locator('..').locator('.cs-menu__list');

    await trigger.click();
    await expect(popup).toBeVisible();
    await expect(trigger).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(popup).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect.poll(() => readSelection(page)).toEqual(selected);
    await expect(page.getByTestId('format-pane')).toBeVisible();
  }
});
