import { expect, test } from '@playwright/test';
import { type ChildProcess, spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

// Multi-tab collab smoke. Spawns the @point/server collab relay on a
// random high port, opens two browser contexts pointing at the same
// ?room, dispatches a slide.command.add-text in tab A, and asserts that
// tab B's window.__capturedMutations gained the broadcast.

const COLLAB_PORT = 4373; // distinct from the dev server (5373)
const COLLAB_URL = `ws://127.0.0.1:${COLLAB_PORT}/collab`;

let serverProc: ChildProcess | null = null;

test.beforeAll(async () => {
  serverProc = spawn('pnpm', ['--filter', '@point/server', 'start'], {
    env: { ...process.env, PORT: String(COLLAB_PORT), HOST: '127.0.0.1' },
    cwd: process.cwd(),
    stdio: 'pipe',
  });
  // Wait for the listening log.
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('collab server start timed out')), 15_000);
    serverProc!.stdout?.on('data', (chunk) => {
      if (chunk.toString().includes('listening on')) {
        clearTimeout(t);
        resolve();
      }
    });
    serverProc!.stderr?.on('data', (chunk) => {
      // eslint-disable-next-line no-console
      console.error('[collab server stderr]', chunk.toString());
    });
  });
});

test.afterAll(async () => {
  if (!serverProc) return;
  serverProc.kill('SIGTERM');
  await sleep(200);
});

test('mutation in tab A is captured in tab B', async ({ browser }) => {
  const room = `e2e-${Date.now()}`;
  const url = `/?room=${room}&collab=${encodeURIComponent(COLLAB_URL)}`;

  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  await Promise.all([pageA.goto(url), pageB.goto(url)]);
  await Promise.all([
    pageA.waitForFunction(
      () => Array.isArray((window as { __capturedMutations?: unknown }).__capturedMutations),
      null,
      { timeout: 15_000 },
    ),
    pageB.waitForFunction(
      () => Array.isArray((window as { __capturedMutations?: unknown }).__capturedMutations),
      null,
      { timeout: 15_000 },
    ),
  ]);
  // Wait for both bridges to land on `live`.
  await Promise.all([
    pageA.waitForSelector('[data-testid="collab-pill"].cs-titlebar__live--live', { timeout: 15_000 }),
    pageB.waitForSelector('[data-testid="collab-pill"].cs-titlebar__live--live', { timeout: 15_000 }),
  ]);
  // Plugin lifecycle takes a beat to land on Steady — that's when
  // slides-ui registers its commands. Without this wait dispatching
  // slide.command.add-text races and throws "not registered".
  await pageA.waitForTimeout(1000);
  await pageB.waitForTimeout(1000);

  // Reset capture on B so the test isn't polluted by setup chatter.
  await pageB.evaluate(() => {
    (window as { __capturedMutations: string[] }).__capturedMutations = [];
  });

  // Drive insert-text on A through the command service.
  await pageA.evaluate(async () => {
    type W = {
      univer: { __getInjector(): { get(id: unknown): { executeCommand(id: string, params?: unknown): Promise<boolean> } } };
    };
    const inj = (window as unknown as W).univer.__getInjector();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cs = inj.get((globalThis as any).__casualSlides__ICommandService);
    await cs.executeCommand('slide.command.add-text', { text: 'hello from A' });
  });

  // Give the relay a moment to broadcast + B to apply.
  await pageB.waitForFunction(
    () => ((window as { __capturedMutations: string[] }).__capturedMutations ?? []).includes('slide.mutation.insert-element'),
    null,
    { timeout: 10_000 },
  );

  const onB = await pageB.evaluate(() => [...(window as { __capturedMutations: string[] }).__capturedMutations]);
  expect(onB).toContain('slide.mutation.insert-element');

  await ctxA.close();
  await ctxB.close();
});
