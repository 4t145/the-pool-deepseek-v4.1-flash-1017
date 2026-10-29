/**
 * Deterministic still capture. Runs the real app in Chrome (hardware WebGL),
 * waits for the loader and the first resolved frame, then screenshots any of the
 * camera shots at a fixed scene time.
 *
 *   pnpm shot -- --shot=arrival --width=1920 --height=1080
 *   pnpm shot -- --all --time=3.5
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
const flag = (name) => args.includes(`--${name}`);

const width = Number(option('width', '1920'));
const height = Number(option('height', '1080'));
const time = Number(option('time', '3.2'));
const quality = option('quality', 'ultra');
const letterbox = flag('letterbox');
const hud = flag('hud');
const all = flag('all');
const outDir = path.resolve(option('out', 'shots'));
const shot = option('shot', 'arrival');
const shots = all
  ? ['arrival', 'flume', 'ring', 'arch', 'skylight', 'tile', 'float']
  : [shot];

const chrome = process.env.CHROME_BIN;
if (!chrome) throw new Error('CHROME_BIN is not set. Source scripts/chrome-env.sh first.');

await mkdir(outDir, { recursive: true });

const server = await createServer({
  root: process.cwd(),
  logLevel: 'error',
  server: { port: 0, strictPort: false, host: '127.0.0.1' },
});
await server.listen();
const address = server.httpServer?.address();
if (!address || typeof address === 'string') throw new Error('Vite server did not expose a port');
const url = `http://127.0.0.1:${address.port}/`;
console.log(`[shot] serving ${url}`);

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

let failures = 0;
try {
  const page = await browser.newPage({
    viewport: { width, height },
    deviceScaleFactor: 1,
  });
  page.on('console', (message) => {
    if (message.type() === 'error') console.error('[browser]', message.text());
  });
  page.on('pageerror', (error) => {
    failures += 1;
    console.error('[pageerror]', error.message);
  });

  for (const id of shots) {
    const query = new URLSearchParams({
      shot: id,
      capture: '1',
      quality,
      t: String(time),
      hud: hud ? '1' : '0',
      letterbox: letterbox ? '1' : '0',
    });
    await page.goto(`${url}?${query.toString()}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__POOL_READY__ === true, undefined, { timeout: 180_000 });
    await page.evaluate(async (sceneTime) => {
      document.getElementById('loader')?.remove();
      document.getElementById('ui')?.remove();
      window.__pool?.setHud(false);
      window.__pool?.setLetterbox(false);
      window.__pool?.renderAt(sceneTime);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }, time);
    const stats = await page.evaluate(() => window.__pool?.getStats());
    const target = path.join(outDir, `${String(shots.indexOf(id) + 1).padStart(2, '0')}-${id}.png`);
    await page.screenshot({ path: target, type: 'png' });
    console.log(`[shot] ${id} -> ${target}`, stats ?? '');
  }
  if (failures > 0) throw new Error(`${failures} page error(s) during capture`);
} finally {
  await browser.close();
  await server.close();
}
