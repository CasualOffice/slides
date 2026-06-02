import { test } from '@playwright/test';

test('trace Ctrl+M dispatch count', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  page.on('console', (m) => console.log(`[b ${m.type()}] ${m.text()}`));
  await page.goto('/');
  await page.waitForFunction(() => typeof window.__casualSlides_getPptxClient === 'function', null, { timeout: 30_000 });
  await page.waitForTimeout(2500);
  await page.evaluate(() => { window.__ctrlMTrace = []; });
  await page.waitForTimeout(200);
  console.log('--- pressing Ctrl+M ---');
  await page.keyboard.press('Control+m');
  await page.waitForTimeout(700);
  const trace = await page.evaluate(() => window.__ctrlMTrace);
  const appendTrace = await page.evaluate(() => window.__appendTrace);
  console.log('TRACE:', JSON.stringify(trace, null, 2));
  console.log('APPEND OP TRACE:', JSON.stringify(appendTrace, null, 2));
  // Count slides
  const slides = await page.evaluate(() => {
    const w = window;
    const inst = w.univer.__getInjector().get(w.__casualSlides__IUniverInstanceService);
    const unit = inst.getCurrentUnitOfType(3);
    return unit.getPageOrder().length;
  });
  console.log('SLIDES:', slides);
});
