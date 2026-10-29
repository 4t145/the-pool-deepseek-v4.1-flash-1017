/**
 * Shared capture bench. Every script here drives the real app in headed Chrome
 * on hardware WebGL (see scripts/chrome-env.sh), waits for __POOL_READY__, and
 * then talks to the stable window.__pool capture API.
 *
 * Nothing in here may depend on wall-clock time for the image: frames are
 * rendered with __pool.renderAt(t) so captures are reproducible.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

/** Canonical shot ids, in playback order. Mirrors src/world/layout.ts SHOTS. */
export const SHOT_IDS = Object.freeze(['arrival', 'flume', 'ring', 'arch', 'skylight', 'tile', 'float']);

/** Per-shot default scene times: chosen so water ripples/wakes are mid-motion. */
export const SHOT_TIMES = Object.freeze({
  arrival: 2.4,
  flume: 6.5,
  ring: 11.2,
  arch: 18.6,
  skylight: 24.3,
  tile: 30.8,
  float: 38.4,
});

export const DEFAULT_CHROME_ARGS = Object.freeze([
  '--no-sandbox',
  '--disable-gpu-sandbox',
  '--force-device-scale-factor=1',
  '--window-position=6000,6000',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling',
  '--disable-features=CalculateNativeWinOcclusion',
  '--hide-scrollbars',
]);

/**
 * Backwards-compatible argument reader for the `--name=value` / `--name value`
 * / `--flag` CLI style used by scripts/shot.mjs.
 */
export function createArgReader(argv = process.argv.slice(2)) {
  const option = (name, fallback) => {
    const prefix = `--${name}=`;
    const found = argv.find((arg) => arg.startsWith(prefix));
    if (found) return found.slice(prefix.length);
    const index = argv.indexOf(`--${name}`);
    if (index >= 0 && argv[index + 1] && !argv[index + 1].startsWith('--')) return argv[index + 1];
    return fallback;
  };
  const number = (name, fallback) => {
    const raw = option(name, null);
    if (raw === null || raw === '') return fallback;
    const value = Number(raw);
    return Number.isFinite(value) ? value : fallback;
  };
  const flag = (name) => argv.includes(`--${name}`);
  const list = (name, fallback) => {
    const raw = option(name, null);
    if (raw === null) return fallback;
    return raw
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  };
  return { argv, option, number, flag, list };
}

export function requireChrome() {
  const chrome = process.env.CHROME_BIN;
  if (!chrome) throw new Error('CHROME_BIN is not set. Run through scripts/run-browser.sh or source scripts/chrome-env.sh.');
  return chrome;
}

/** Start the Vite dev server on an ephemeral local port. */
export async function startServer(root = process.cwd()) {
  const server = await createServer({
    root,
    logLevel: 'error',
    server: { port: 0, strictPort: false, host: '127.0.0.1' },
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === 'string') throw new Error('Vite server did not expose a port');
  return { server, url: `http://127.0.0.1:${address.port}/` };
}

export async function closeServer(server) {
  await server?.close();
}

/** Launch headed Chrome with hardware WebGL. Off-screen and non-throttled. */
export async function launchBrowser(chrome = requireChrome()) {
  return chromium.launch({
    executablePath: chrome,
    headless: false,
    args: [...DEFAULT_CHROME_ARGS],
  });
}

/**
 * Open a page at a fixed viewport. Errors are collected; a script may downgrade
 * them to warnings but should never silently swallow a pageerror.
 */
export async function openScene(browser, url, { width, height, params = {} } = {}) {
  const context = await browser.newContext({
    viewport: { width: Math.round(width), height: Math.round(height) },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(`[pageerror] ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`[console] ${message.text()}`);
  });
  page.setDefaultTimeout(180_000);
  // An unfocused off-screen window gets its rAF loop throttled to ~1 Hz, which
  // makes both frame stepping and fps measurement meaningless. Focus the tab.
  await page.bringToFront();
  await navigate(page, url, params);
  await waitForReady(page);
  return { page, context, errors };
}

export async function navigate(page, url, params = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    query.set(key, String(value));
  }
  const suffix = query.toString();
  await page.goto(`${url}${suffix ? `?${suffix}` : ''}`, { waitUntil: 'domcontentloaded' });
}

export async function waitForReady(page) {
  await page.waitForFunction(() => window.__POOL_READY__ === true, undefined, { timeout: 180_000 });
}

/**
 * Capture-grade UI hygiene: remove the loader and the entire interface, hide the
 * HUD through the API (so the app state is honest), and set the letterbox to the
 * requested value. Call once per navigation.
 */
export async function prepareCapture(page, { letterbox = false } = {}) {
  await page.evaluate((wantedLetterbox) => {
    document.getElementById('loader')?.remove();
    document.getElementById('ui')?.remove();
    window.__pool?.setHud(false);
    window.__pool?.setLetterbox(wantedLetterbox);
  }, letterbox);
}

/** Render one deterministic frame and wait for it to be composited. */
export async function renderAt(page, time, { frames = 2 } = {}) {
  await page.evaluate(
    async ({ t, frames: waitFrames }) => {
      window.__pool?.renderAt(t);
      for (let i = 0; i < waitFrames; i++) {
        await new Promise((resolve) => requestAnimationFrame(() => resolve()));
      }
    },
    { t: time, frames },
  );
}

/** Advance the cinematic camera to a deterministic time (no shot lock). */
export async function cinematicAt(page, time, { frames = 2 } = {}) {
  await page.evaluate(
    async ({ t, frames: waitFrames }) => {
      window.__pool?.setCinematic(t);
      window.__pool?.setPaused(true);
      window.__pool?.renderAt(t);
      for (let i = 0; i < waitFrames; i++) {
        await new Promise((resolve) => requestAnimationFrame(() => resolve()));
      }
    },
    { t: time, frames },
  );
}

export async function readStats(page) {
  return page.evaluate(() => window.__pool?.getStats() ?? null);
}

/**
 * Fail-safe shot assertion. A navigation/capture race can leave the page in a
 * different camera mode than requested (seen once during review captures), so
 * every positioned capture snaps the requested shot and verifies the app state
 * before a frame is taken. Retries a couple of times, then throws.
 */
export async function ensureShot(page, id) {
  let last = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    await page.evaluate((shotId) => {
      window.__pool?.setShot(shotId);
    }, id);
    const stats = await readStats(page);
    last = stats;
    if (stats && stats.mode === 'shot' && stats.shot === id) return { stats, attempts: attempt };
    await page.waitForTimeout(120);
  }
  throw new Error(`capture is not in shot mode for "${id}" (got mode=${last?.mode ?? '?'} shot=${last?.shot ?? '?'})`);
}

/** Fail-safe cinematic assertion for frame-stepped takes. */
export async function ensureCinematic(page) {
  const stats = await readStats(page);
  if (!stats || stats.mode !== 'cinematic') {
    throw new Error(`trailer capture is not in cinematic mode (got mode=${stats?.mode ?? '?'})`);
  }
  return stats;
}

/** Read the transform of every renderable object, for determinism evidence. */
export async function readTransforms(page) {
  return page.evaluate(() => {
    const api = window.__pool;
    if (!api) return null;
    const round = (value) => Math.round(value * 1e6) / 1e6;
    const objects = [];
    api.scene.traverse((object) => {
      objects.push({
        name: object.name || object.type,
        type: object.type,
        position: object.position.toArray().map(round),
        quaternion: object.quaternion.toArray().map(round),
        scale: object.scale.toArray().map(round),
      });
    });
    return {
      camera: {
        position: api.camera.position.toArray().map(round),
        quaternion: api.camera.quaternion.toArray().map(round),
        fov: round(api.camera.fov),
      },
      time: round(api.time()),
      objects,
    };
  });
}

export async function screenshot(page, target) {
  await mkdir(path.dirname(path.resolve(target)), { recursive: true });
  await page.screenshot({ path: target, type: 'png' });
  return target;
}

/**
 * Capture the WebGL drawing buffer directly (preserveDrawingBuffer is on).
 *
 * This is both much faster than a CDP screenshot (44 ms vs 426 ms per 1080p
 * frame) and immune to the browser's rAF throttling for off-screen windows,
 * which otherwise inserts multi-second stalls into a long frame sequence. The
 * result is pixel-identical to `page.screenshot` (verified with PSNR = inf), so
 * determinism evidence is unchanged.
 */
export async function captureCanvas(page, target, { format = 'png', quality = 95 } = {}) {
  const mime = format === 'jpeg' ? 'image/jpeg' : 'image/png';
  const dataUrl = await page.evaluate(
    ({ mimeType, jpegQuality }) => {
      const canvas = document.getElementById('c');
      if (!(canvas instanceof HTMLCanvasElement)) throw new Error('missing #c canvas');
      return canvas.toDataURL(mimeType, jpegQuality);
    },
    { mimeType: mime, jpegQuality: quality / 100 },
  );
  const separator = dataUrl.indexOf(',');
  if (separator < 0) throw new Error('canvas.toDataURL returned no data');
  await mkdir(path.dirname(path.resolve(target)), { recursive: true });
  await writeFile(target, Buffer.from(dataUrl.slice(separator + 1), 'base64'));
  return target;
}

/** Render a frame, then capture the drawing buffer to disk. */
export async function renderAndCapture(page, time, target, options = {}) {
  await renderAt(page, time, { frames: 0 });
  return captureCanvas(page, target, options);
}

/** Two rAFs after a resize so the app's own resize path settles. */
export async function settle(page) {
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
}

export const totalErrors = (errors) => errors.filter((error) => !/favicon/i.test(error));

export function formatStats(stats) {
  if (!stats) return '(no stats)';
  return `${stats.drawCalls} calls · ${(stats.triangles / 1000).toFixed(1)}k tri · ${stats.fps.toFixed(1)} fps · ${stats.mode}/${stats.shot}`;
}
