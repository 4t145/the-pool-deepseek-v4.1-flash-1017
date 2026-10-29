import { chromium } from 'playwright-core';
import { createServer } from 'vite';
const chrome = process.env.CHROME_BIN;
const server = await createServer({ root: process.cwd(), logLevel: 'error', server: { port: 0, strictPort: false, host: '127.0.0.1' } });
await server.listen();
const address = server.httpServer?.address();
const browser = await chromium.launch({
  executablePath: chrome, headless: false,
  args: ['--no-sandbox','--disable-gpu-sandbox','--window-position=6000,6000','--disable-backgrounding-occluded-windows','--disable-renderer-backgrounding','--disable-background-timer-throttling','--disable-features=CalculateNativeWinOcclusion','--hide-scrollbars'],
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror:${e.message}`));
await page.goto(`http://127.0.0.1:${address.port}/?capture=1&quality=ultra&hud=0&shot=arrival&t=2`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__POOL_READY__ === true, undefined, { timeout: 180_000 });
await page.evaluate(() => { document.getElementById('loader')?.remove(); document.getElementById('ui')?.remove(); window.__pool.renderAt(2); });
await page.waitForTimeout(600);
await page.screenshot({ path: '/tmp/w1-det-a.png' });
await page.evaluate(() => window.__pool.renderAt(2));
await page.waitForTimeout(400);
await page.screenshot({ path: '/tmp/w1-det-b.png' });
const transforms = await page.evaluate(() => {
  const out = [];
  window.__pool.scene.traverse((o) => { if (o.isMesh) out.push(`${o.name}:${o.matrixWorld.elements.map((v) => v.toFixed(5)).join(',')}`); });
  return { count: out.length, hash: out.join('|').length, sample: out.slice(0, 3) };
});
// Shot-mode perf: render the arrival shot live for 4 s.
await page.evaluate(() => { window.__pool.setShot('arrival'); window.__pool.setPaused(false); });
await page.waitForTimeout(4500);
const perf = await page.evaluate(() => {
  const s = window.__pool.getStats();
  const r = window.__pool.renderer;
  return { fps: s.fps, drawCalls: r.info.render.calls, triangles: r.info.render.triangles, mode: s.mode, shot: s.shot };
});
console.log('[qa]', JSON.stringify({ perf, errors: errors.slice(0, 5), transforms }));
await browser.close();
await server.close();
