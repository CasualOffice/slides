// Drive the live editor through every major surface and dump screenshots
// + accessibility trees. Output goes to /tmp/casual-slides-ux-audit/ so we
// can read each PNG back into the audit report. Diagnostic — not a
// regression test.
//
//   pnpm exec playwright test tests/e2e/__diagnostic__/ux-audit-capture.mjs --config=playwright.diagnostic.config.ts

import { test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const OUT = '/tmp/casual-slides-ux-audit';
mkdirSync(OUT, { recursive: true });

async function shot(page, name) {
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: false });
}

test('UX audit — drive every surface', async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.waitForFunction(
    () => typeof window.__casualSlides_getPptxClient === 'function',
    null,
    { timeout: 30_000 },
  );
  await page.waitForTimeout(1500);

  // 1. Cold boot — default deck, chrome at rest
  await shot(page, '01-cold-boot');

  // 2. File menu open
  await page.getByRole('button', { name: 'File' }).click().catch(() => {});
  await page.waitForTimeout(200);
  await shot(page, '02-file-menu');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);

  // 3. Edit menu
  await page.getByRole('button', { name: 'Edit' }).click().catch(() => {});
  await page.waitForTimeout(200);
  await shot(page, '03-edit-menu');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);

  // 4. View menu
  await page.getByRole('button', { name: 'View' }).click().catch(() => {});
  await page.waitForTimeout(200);
  await shot(page, '04-view-menu');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);

  // 5. Insert menu
  await page.getByRole('button', { name: 'Insert' }).click().catch(() => {});
  await page.waitForTimeout(200);
  await shot(page, '05-insert-menu');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);

  // 6. Help menu
  await page.getByRole('button', { name: 'Help' }).click().catch(() => {});
  await page.waitForTimeout(200);
  await shot(page, '06-help-menu');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);

  // 7. Toolbar Insert dropdown
  await page.locator('button[title*="Insert" i], button[aria-label*="Insert" i]').first().click().catch(() => {});
  await page.waitForTimeout(250);
  await shot(page, '07-toolbar-insert-dropdown');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);

  // 8. Toolbar Slide dropdown
  await page.locator('button[title*="Slide" i], button[aria-label*="Slide" i]').first().click().catch(() => {});
  await page.waitForTimeout(250);
  await shot(page, '08-toolbar-slide-dropdown');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);

  // 9. Toolbar Theme picker
  await page.locator('button:has-text("Theme"), button[aria-label*="Theme" i]').first().click().catch(() => {});
  await page.waitForTimeout(400);
  await shot(page, '09-theme-picker');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);

  // 10. Toolbar Background picker
  await page.locator('button:has-text("Background"), button[aria-label*="Background" i]').first().click().catch(() => {});
  await page.waitForTimeout(400);
  await shot(page, '10-background-picker');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);

  // 11. Toolbar Layout dropdown
  await page.locator('button:has-text("Layout"), button[aria-label*="Layout" i]').first().click().catch(() => {});
  await page.waitForTimeout(400);
  await shot(page, '11-layout-picker');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);

  // 12. Font family picker
  await page.locator('button:has-text("Inter"), button[aria-label*="Font" i]').first().click().catch(() => {});
  await page.waitForTimeout(300);
  await shot(page, '12-font-family-picker');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);

  // 13. Text color picker
  await page.locator('button[aria-label*="Text color" i]').first().click().catch(() => {});
  await page.waitForTimeout(300);
  await shot(page, '13-text-color-picker');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);

  // 14. Align picker
  await page.locator('button[aria-label*="Align" i]').first().click().catch(() => {});
  await page.waitForTimeout(250);
  await shot(page, '14-align-picker');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);

  // 15. List picker
  await page.locator('button[aria-label*="Bulleted list" i], button[aria-label*="bullet" i]').first().click().catch(() => {});
  await page.waitForTimeout(250);
  await shot(page, '15-list-picker');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);

  // 16. Line spacing picker
  await page.locator('button[aria-label*="Line spacing" i]').first().click().catch(() => {});
  await page.waitForTimeout(250);
  await shot(page, '16-line-spacing-picker');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);

  // 17. Shortcuts dialog (Ctrl+/)
  await page.keyboard.press('Control+/');
  await page.waitForTimeout(400);
  await shot(page, '17-shortcuts-dialog');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);

  // 18. Find & Replace (Ctrl+F)
  await page.keyboard.press('Control+f');
  await page.waitForTimeout(400);
  await shot(page, '18-find-replace');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);

  // 19. Right-click context menu on slide thumbnail
  await page.locator('[data-testid="slide-rail-tile"], .cs-slide-rail__tile').first().click({ button: 'right' }).catch(() => {});
  await page.waitForTimeout(250);
  await shot(page, '19-slide-context-menu');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);

  // 20. Properties dialog (via File menu)
  await page.getByRole('button', { name: 'File' }).click().catch(() => {});
  await page.waitForTimeout(150);
  await page.getByRole('menuitem', { name: 'Properties' }).click().catch(() => {});
  await page.waitForTimeout(400);
  await shot(page, '20-properties-dialog');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);

  // 21. Recent files dialog
  await page.getByRole('button', { name: 'File' }).click().catch(() => {});
  await page.waitForTimeout(150);
  await page.getByRole('menuitem', { name: 'Recent files' }).click().catch(() => {});
  await page.waitForTimeout(400);
  await shot(page, '21-recent-files-dialog');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);

  // 22. About dialog
  await page.getByRole('button', { name: 'Help' }).click().catch(() => {});
  await page.waitForTimeout(150);
  await page.getByRole('menuitem', { name: /About/ }).click().catch(() => {});
  await page.waitForTimeout(400);
  await shot(page, '22-about-dialog');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);

  // 23. Page setup dialog
  await page.getByRole('button', { name: 'File' }).click().catch(() => {});
  await page.waitForTimeout(150);
  await page.getByRole('menuitem', { name: 'Page setup' }).click().catch(() => {});
  await page.waitForTimeout(400);
  await shot(page, '23-page-setup-dialog');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);

  // 24. Slideshow
  await page.keyboard.press('F5');
  await page.waitForTimeout(800);
  await shot(page, '24-slideshow');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  // 25. Click into the canvas to select an element → Format pane should appear
  const canvas = page.locator('.univer-mount canvas').first();
  const box = await canvas.boundingBox();
  if (box) {
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 3);
    await page.waitForTimeout(500);
  }
  await shot(page, '25-element-selected-format-pane');

  // 26. Notes panel toggle
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  await page.locator('button[aria-label*="Speaker notes" i], button[aria-label*="notes" i]').first().click().catch(() => {});
  await page.waitForTimeout(400);
  await shot(page, '26-notes-panel-open');

  console.log('UX audit screenshots saved to:', OUT);
});
