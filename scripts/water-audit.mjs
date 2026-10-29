/**
 * Water-body luminance audit. Turns the art-direction/owner wording ("water body
 * reads dark green-black", "floor only faintly visible") into a measurement:
 * the open water surface is isolated by rendering the same frame with the water
 * material hidden and diffing, then the display luminance distribution of those
 * pixels is reported.
 *
 *   pnpm water-audit
 *   pnpm water-audit -- --shot=arrival --time=2.4 --threshold=0.2 --enforce
 *
 * Output: shots/water-audit.json and a printed table. Without `--enforce` it is
 * informational (exit 0); with it, the command fails if more than
 * `--max-bright-fraction` of the water pixels exceed the luminance threshold,
 * or if the median exceeds it.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  SHOT_TIMES,
  captureCanvas,
  closeServer,
  createArgReader,
  ensureShot,
  launchBrowser,
  openScene,
  prepareCapture,
  readStats,
  renderAt,
  startServer,
} from './lib/bench.mjs';

const args = createArgReader();
const shot = args.option('shot', 'arrival');
const time = args.number('time', SHOT_TIMES[shot] ?? 2.4);
const width = Math.round(args.number('width', 1920));
const height = Math.round(args.number('height', 1080));
const quality = args.option('quality', 'ultra');
const threshold = args.number('threshold', 0.2);
const maxBrightFraction = args.number('max-bright-fraction', 0.4);
const enforce = args.flag('enforce');
const jsonPath = path.resolve(args.option('json', 'shots/water-audit.json'));
const frameDir = path.resolve(args.option('frames', 'shots/water-audit'));

const run = (command, commandArgs) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`${command} exited ${code}: ${Buffer.concat(stderr).toString().slice(-400)}`));
      else resolve(Buffer.concat(stdout));
    });
  });

const gray = (file) => run('ffmpeg', ['-v', 'error', '-i', file, '-vf', 'format=gray', '-f', 'rawvideo', '-pix_fmt', 'gray', '-']);

const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))] ?? 0;

await mkdir(frameDir, { recursive: true });
const { server, url } = await startServer(process.cwd());
const browser = await launchBrowser();
let report = null;
try {
  const scene = await openScene(browser, url, {
    width,
    height,
    params: { shot, capture: 1, quality, t: time, hud: 0, letterbox: 0 },
  });
  const { page, context, errors } = scene;
  await prepareCapture(page, { letterbox: false });
  await ensureShot(page, shot);
  await renderAt(page, time, { frames: 0 });
  const stats = await readStats(page);
  const normalFile = path.join(frameDir, `${shot}-normal.png`);
  await captureCanvas(page, normalFile, { format: 'png' });

  // The water system re-shows its own mesh every frame; hiding the material
  // (not the mesh) removes the surface from both the main and mirror passes.
  await page.evaluate(() => {
    const water = window.__pool?.scene.getObjectByName('water');
    if (water?.material) water.material.visible = false;
  });
  await renderAt(page, time, { frames: 0 });
  const hiddenFile = path.join(frameDir, `${shot}-no-water.png`);
  await captureCanvas(page, hiddenFile, { format: 'png' });
  await page.evaluate(() => {
    const water = window.__pool?.scene.getObjectByName('water');
    if (water?.material) water.material.visible = true;
  });

  const [normalLuma, hiddenLuma] = await Promise.all([gray(normalFile), gray(hiddenFile)]);
  if (normalLuma.length !== hiddenLuma.length) throw new Error('gray buffers differ in size');

  const waterLuma = [];
  let changed = 0;
  for (let index = 0; index < normalLuma.length; index++) {
    const difference = Math.abs(normalLuma[index] - hiddenLuma[index]);
    if (difference <= 8) continue;
    changed += 1;
    waterLuma.push(normalLuma[index] / 255);
  }
  waterLuma.sort((a, b) => a - b);
  const bright = waterLuma.filter((value) => value > threshold).length;
  const brightFraction = waterLuma.length > 0 ? bright / waterLuma.length : 0;
  const mean = waterLuma.reduce((sum, value) => sum + value, 0) / Math.max(waterLuma.length, 1);

  report = {
    generatedAt: new Date().toISOString().slice(0, 10),
    shot,
    time,
    width,
    height,
    quality,
    stats: stats ?? null,
    waterPixels: waterLuma.length,
    fractionOfFrame: Number((waterLuma.length / (width * height)).toFixed(3)),
    luminance: {
      mean: Number(mean.toFixed(3)),
      p50: Number(percentile(waterLuma, 50).toFixed(3)),
      p75: Number(percentile(waterLuma, 75).toFixed(3)),
      p90: Number(percentile(waterLuma, 90).toFixed(3)),
      p99: Number(percentile(waterLuma, 99).toFixed(3)),
    },
    threshold,
    brightFraction: Number(brightFraction.toFixed(3)),
    frames: { normal: path.relative(process.cwd(), normalFile), hidden: path.relative(process.cwd(), hiddenFile) },
    pageErrors: errors.length,
  };
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(
    `[water] ${shot} t=${time}s · ${waterLuma.length} water px (${(report.fractionOfFrame * 100).toFixed(1)}% of frame) · ` +
      `luma p50 ${report.luminance.p50} p75 ${report.luminance.p75} p90 ${report.luminance.p90} p99 ${report.luminance.p99} · ` +
      `above ${threshold}: ${(brightFraction * 100).toFixed(1)}%`,
  );
  console.log(`[water] wrote ${path.relative(process.cwd(), jsonPath)}`);
  if (errors.length > 0) console.error(`[water] ${errors.length} browser error(s)`);
  await context.close();

  if (enforce) {
    const problems = [];
    if (report.luminance.p50 > threshold) problems.push(`median water luma ${report.luminance.p50} > ${threshold}`);
    if (brightFraction > maxBrightFraction) problems.push(`${(brightFraction * 100).toFixed(1)}% of water pixels above ${threshold} (> ${(maxBrightFraction * 100).toFixed(0)}%)`);
    if (problems.length > 0) {
      for (const problem of problems) console.error(`[water] below target: ${problem}`);
      process.exitCode = 1;
    }
  }
} finally {
  await browser.close();
  await closeServer(server);
}
