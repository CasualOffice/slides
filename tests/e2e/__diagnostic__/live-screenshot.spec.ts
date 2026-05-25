import { expect, test } from '@playwright/test';

// Diagnostic: hit the deployed URL, dump everything useful for triage.
// Not part of the main suite. Run via:
//   pnpm exec playwright test tests/e2e/__diagnostic__/live-screenshot.spec.ts --config=playwright.diagnostic.config.ts

test('snapshot deployed slide.schnsrw.live', async ({ page }, testInfo) => {
  const errors: string[] = [];
  const warns: string[] = [];
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    const text = `${msg.type()}: ${msg.text()}`;
    if (msg.type() === 'error') errors.push(text);
    else if (msg.type() === 'warning') warns.push(text);
  });

  await page.goto('https://slide.schnsrw.live/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(3000);

  // Screenshot what the user is seeing.
  await page.screenshot({ path: testInfo.outputPath('live.png'), fullPage: true });

  // What's actually in the DOM?
  const domSnapshot = await page.evaluate(() => {
    const root = document.getElementById('root');
    const mount = document.querySelector('.univer-mount');
    return {
      rootChildren: root ? Array.from(root.children).map((c) => c.tagName + (c.className ? '.' + String(c.className).replace(/\s+/g, '.') : '')) : [],
      mountRect: mount ? (mount as HTMLElement).getBoundingClientRect().toJSON() : null,
      canvases: Array.from(document.querySelectorAll('canvas')).map((c) => {
        const r = c.getBoundingClientRect();
        return { w: r.width, h: r.height, hasContext: !!(c as HTMLCanvasElement).getContext('2d') };
      }),
      // What Univer-related DOM did the plugins inject inside .univer-mount?
      mountInnerHTML: mount?.innerHTML.slice(0, 2000) ?? null,
      bodyTexts: Array.from(document.body.querySelectorAll('*'))
        .map((el) => el.textContent?.trim())
        .filter((t): t is string => !!t && t.length > 0 && t.length < 80)
        .slice(0, 30),
    };
  });

  // eslint-disable-next-line no-console
  console.log('====== DOM SNAPSHOT ======');
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(domSnapshot, null, 2));
  // eslint-disable-next-line no-console
  console.log('====== ERRORS ======');
  for (const e of errors) console.log(e);
  // eslint-disable-next-line no-console
  console.log('====== WARNS ======');
  for (const w of warns.slice(0, 10)) console.log(w);

  // Soft assertion so the diagnostic always produces output.
  expect(true).toBe(true);
});
