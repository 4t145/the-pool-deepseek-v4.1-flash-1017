/**
 * Debug harness: capture a shot with arbitrary post-load uniform overrides.
 * Usage: node /tmp/debug.mjs --shot=arrival --width=1280 --height=720 --time=2 --out=/tmp/dbg
 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const prefix = `--${name}=`;
  const found = args.find((arg) => arg.startsWith(prefix));
  if (found) return found.slice(prefix.length);
  const index = args.indexOf(`--${name}`);
  if (index >= 0 && args[index + 1]) return args[index + 1];
  return fallback;
};

const width = Number(option('width', '1280'));
const height = Number(option('height', '720'));
const time = Number(option('time', '2'));
const shot = option('shot', 'arrival');
const outDir = path.resolve(option('out', '/tmp/dbg'));
const chrome = process.env.CHROME_BIN;
if (!chrome) throw new Error('CHROME_BIN not set');
await mkdir(outDir, { recursive: true });

const server = await createServer({
  root: process.cwd(),
  logLevel: 'error',
  server: { port: 0, strictPort: false, host: '127.0.0.1' },
});
await server.listen();
const address = server.httpServer?.address();
const url = `http://127.0.0.1:${address.port}/`;
console.log('[debug] serving', url);

const browser = await chromium.launch({
  executablePath: chrome,
  headless: false,
  args: [
    '--no-sandbox',
    '--disable-gpu-sandbox',
    '--window-position=6000,6000',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    '--disable-features=CalculateNativeWinOcclusion',
    '--hide-scrollbars',
  ],
});

const variants = JSON.parse(option('variants', '[{"name":"base","uniforms":{}}]'));

try {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  page.on('console', (message) => {
    if (message.type() === 'error') console.error('[browser]', message.text().slice(0, 2000));
  });
  page.on('pageerror', (error) => console.error('[pageerror]', error.message));

  const query = new URLSearchParams({ shot, capture: '1', quality: 'ultra', t: String(time), hud: '0' });
  await page.goto(`${url}?${query.toString()}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__POOL_READY__ === true, undefined, { timeout: 180_000 });
  await page.evaluate(() => {
    document.getElementById('loader')?.remove();
    document.getElementById('ui')?.remove();
    window.__pool?.setHud(false);
    window.__pool?.setLetterbox(false);
  });

  for (const variant of variants) {
    const stats = await page.evaluate(async ({ overrides, sceneTime }) => {
      const water = window.__pool.scene.getObjectByName('water');
      const uniforms = water?.material?.uniforms ?? {};
      for (const [key, value] of Object.entries(overrides)) {
        if (uniforms[key]) uniforms[key].value = value;
      }
      window.__pool.renderAt(sceneTime);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return window.__pool.getStats();
    }, { overrides: variant.uniforms ?? {}, sceneTime: time });
    const target = path.join(outDir, `${variant.name}.png`);
    await page.screenshot({ path: target, type: 'png' });
    console.log('[debug]', variant.name, '->', target, stats);
  }
} finally {
  await browser.close();
  await server.close();
}
