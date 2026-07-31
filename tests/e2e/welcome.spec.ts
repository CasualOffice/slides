import { expect, test } from '@playwright/test';

test('welcome page starts a presentation and exposes open and empty recents', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New presentation' })).toBeVisible();

  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open presentation' }).click();
  await chooserPromise;

  await page.getByRole('button', { name: 'Recent presentations' }).click();
  await expect(page.getByRole('dialog', { name: 'Recent files' })).toBeVisible();
  await expect(page.getByText("No recent decks yet. Open a .pptx and it'll appear here.")).toBeVisible();

  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'New presentation' }).click();
  await expect(page).toHaveURL(/#editor$/);
  await expect(page.locator('.cs-titlebar')).toBeVisible();
});
