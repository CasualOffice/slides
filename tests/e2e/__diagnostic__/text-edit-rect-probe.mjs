// Inspect the live RichText BaseObject + the editor bridge's computed rect.
import { chromium } from '@playwright/test';

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.type() + ': ' + m.text()); });

await page.goto('http://127.0.0.1:5373/', { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);

await page.evaluate(async () => {
  const u = window.univer;
  const cs = u.__getInjector().get(window.__casualSlides__ICommandService);
  await cs.executeCommand('slide.command.add-text');
});
await page.waitForTimeout(800);

// Find the RichText BaseObject in the per-page scene.
const before = await page.evaluate(() => {
  const u = window.univer;
  const inj = u.__getInjector();
  const IRenderManagerService = window.__casualSlides__IRenderManagerService;
  if (!IRenderManagerService) return { err: 'no IRenderManagerService global' };
  const rm = inj.get(IRenderManagerService);
  const all = Array.from(rm.getRenderAll().entries()).map(([id, r]) => {
    const s = r.scene;
    const flatten = (objs) => {
      const out = [];
      const visit = (o) => {
        out.push({ key: o.oKey, type: o.objectType, left: o.left, top: o.top, width: o.width, height: o.height });
        if (typeof o.getObjects === 'function') {
          for (const c of o.getObjects().values()) visit(c);
        }
      };
      for (const o of objs.values()) visit(o);
      return out;
    };
    return {
      id, type: r.type,
      sceneW: s?.width, sceneH: s?.height,
      subScenes: typeof s?.getSubScenes === 'function' ? Array.from(s.getSubScenes().keys()) : [],
      objs: s ? flatten(s.getObjects?.() ?? new Map()) : [],
    };
  });
  return { rmAll: all };
});
console.log('render units + objects:', JSON.stringify(before, null, 2));
console.log('errors:', errors.slice(0, 5));

await browser.close();
