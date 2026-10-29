/**
 * Performance measurement on the real app: fps distribution in shot mode,
 * draw calls, triangles, and a low-preset boot check.
 *
 *   pnpm perf                            # 1920x1080 ultra, arrival, 6 s sample
 *   pnpm perf -- --shot=flume --seconds=10
 *   pnpm perf -- --quality=high --width=1280 --height=720
 *   pnpm perf -- --skip-low              # skip the 1280x720 low-preset boot
 *
 * Writes shots/perf.json (ignored by git) and prints a table for the report.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  SHOT_TIMES,
  closeServer,
  createArgReader,
  formatStats,
  launchBrowser,
  openScene,
  prepareCapture,
  readStats,
  renderAt,
  startServer,
  totalErrors,
} from './lib/bench.mjs';

const args = createArgReader();

const width = Math.round(args.number('width', 1920));
const height = Math.round(args.number('height', 1080));
const quality = args.option('quality', 'ultra');
const shot = args.option('shot', 'arrival');
const seconds = args.number('seconds', 6);
const warmupSeconds = args.number('warmup', 1.5);
const skipLow = args.flag('skip-low');
const jsonPath = path.resolve(args.option('json', 'shots/perf.json'));
const frameBudgetMs = 1000 / 45;

const percentile = (sorted, p) => {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
};

const { server, url } = await startServer(process.cwd());
const browser = await launchBrowser();
const report = { generatedAt: new Date().toISOString().slice(0, 10), primary: null, low: null };
let failures = 0;

try {
  const scene = await openScene(browser, url, {
    width,
    height,
    params: { shot, capture: 1, quality, t: SHOT_TIMES[shot] ?? 2.4, hud: 0, letterbox: 0 },
  });
  const page = scene.page;
  await prepareCapture(page, { letterbox: false });
  await renderAt(page, SHOT_TIMES[shot] ?? 2.4);

  // Unpause the app loop and sample real frame intervals from the page.
  const sample = await page.evaluate(
    async ({ sampleSeconds }) => {
      window.__pool?.setPaused(false);
      const frames = [];
      let previous = performance.now();
      const start = previous;
      await new Promise((resolve) => {
        const tick = () => {
          const now = performance.now();
          frames.push(now - previous);
          previous = now;
          if (now - start >= sampleSeconds * 1000) resolve();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      return { frames, stats: window.__pool?.getStats() ?? null };
    },
    { sampleSeconds: seconds },
  );

  const warmupFrames = Math.min(sample.frames.length, Math.ceil(warmupSeconds * 60));
  const frames = sample.frames.slice(warmupFrames).sort((a, b) => a - b);
  const mean = frames.reduce((sum, value) => sum + value, 0) / Math.max(frames.length, 1);
  const stats = await readStats(page);
  const fps = 1000 / mean;
  const overBudget = frames.filter((value) => value > frameBudgetMs).length;
  const metrics = {
    width,
    height,
    quality,
    shot,
    sampleSeconds: seconds,
    frames: frames.length,
    fps: Number(fps.toFixed(2)),
    reportedFps: stats?.fps ?? 0,
    frameMs: {
      p50: Number(percentile(frames, 50).toFixed(2)),
      p95: Number(percentile(frames, 95).toFixed(2)),
      max: Number(percentile(frames, 100).toFixed(2)),
    },
    framesOverBudget: overBudget,
    budgetMs: Number(frameBudgetMs.toFixed(2)),
    drawCalls: stats?.drawCalls ?? 0,
    triangles: stats?.triangles ?? 0,
  };
  report.primary = metrics;

  console.log(`[perf] ${width}x${height} ${quality} · shot=${shot}`);
  console.log(`[perf] ${metrics.frames} frames · ${metrics.fps.toFixed(1)} fps avg · p50 ${metrics.frameMs.p50} ms · p95 ${metrics.frameMs.p95} ms · max ${metrics.frameMs.max} ms`);
  console.log(`[perf] ${metrics.drawCalls} draw calls · ${metrics.triangles} triangles`);
  console.log(`[perf] frames over ${frameBudgetMs.toFixed(1)} ms (45 fps) after warmup: ${overBudget}`);

  const problems = [];
  if (metrics.drawCalls > 700) problems.push(`${metrics.drawCalls} draw calls > 700`);
  if (metrics.triangles > 500_000) problems.push(`${metrics.triangles} triangles > 500k`);
  if (metrics.fps < 45) problems.push(`${metrics.fps.toFixed(1)} fps < 45`);
  if (totalErrors(scene.errors).length > 0) problems.push(`${totalErrors(scene.errors).length} browser error(s)`);
  for (const error of totalErrors(scene.errors)) console.error(`[browser] ${error}`);
  await scene.context.close();

  if (!skipLow) {
    const low = await openScene(browser, url, {
      width: 1280,
      height: 720,
      params: { shot: 'arrival', capture: 1, quality: 'low', t: 2, hud: 0, letterbox: 0 },
    });
    await prepareCapture(low.page, { letterbox: false });
    await renderAt(low.page, 2);
    const lowStats = await readStats(low.page);
    const lowOk = Boolean(lowStats && lowStats.triangles > 0);
    report.low = { width: 1280, height: 720, quality: 'low', booted: lowOk, stats: lowStats };
    console.log(`[perf] low preset 1280x720 boot: ${lowOk ? 'PASS' : 'FAIL'} · ${formatStats(lowStats)}`);
    if (!lowOk) problems.push('low preset failed to boot at 1280x720');
    if (totalErrors(low.errors).length > 0) problems.push(`${totalErrors(low.errors).length} browser error(s) on low preset`);
    await low.context.close();
  }

  await mkdir(path.dirname(jsonPath), { recursive: true });
  report.ok = problems.length === 0;
  report.problems = problems;
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`[perf] wrote ${path.relative(process.cwd(), jsonPath)}`);

  if (problems.length > 0) {
    for (const problem of problems) console.warn(`[perf] below target: ${problem}`);
    process.exitCode = args.flag('allow-miss') ? 0 : 1;
  }
} finally {
  await browser.close();
  await closeServer(server);
}
