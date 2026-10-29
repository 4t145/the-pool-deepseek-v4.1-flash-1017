/**
 * Deterministic still capture. Runs the real app in Chrome (hardware WebGL),
 * waits for the loader and the first resolved frame, then screenshots any of the
 * camera shots at a fixed scene time.
 *
 *   pnpm shot -- --shot=arrival --width=1920 --height=1080
 *   pnpm shot -- --all --time=3.5
 *   pnpm shot -- --shot=arch --letterbox --time=18.6
 *
 * The CLI is unchanged from the baseline; only the capture hygiene is fixed:
 * `--letterbox` is honoured (it used to be force-reset to off) and the loader /
 * HUD are removed before the screenshot.
 */
import path from 'node:path';
import {
  SHOT_IDS,
  closeServer,
  createArgReader,
  formatStats,
  launchBrowser,
  navigate,
  openScene,
  prepareCapture,
  readStats,
  captureCanvas,
  renderAt,
  startServer,
  totalErrors,
  waitForReady,
} from './lib/bench.mjs';

const args = createArgReader();

const width = Math.round(args.number('width', 1920));
const height = Math.round(args.number('height', 1080));
const time = args.number('time', 3.2);
const quality = args.option('quality', 'ultra');
const letterbox = args.flag('letterbox');
const outDir = path.resolve(args.option('out', 'shots'));
const all = args.flag('all');
const shot = args.option('shot', 'arrival');
const shots = all ? [...SHOT_IDS] : [shot];

if (!SHOT_IDS.includes(shot) && !all) throw new Error(`Unknown shot "${shot}". Known: ${SHOT_IDS.join(', ')}`);

const { server, url } = await startServer(process.cwd());
const browser = await launchBrowser();
let failures = 0;

try {
  const { page, errors } = await openScene(browser, url, {
    width,
    height,
    params: { shot: shots[0], capture: 1, quality, t: time, hud: 0, letterbox: letterbox ? 1 : 0 },
  });

  for (const [index, id] of shots.entries()) {
    if (index > 0) {
      await navigate(page, url, { shot: id, capture: 1, quality, t: time, hud: 0, letterbox: letterbox ? 1 : 0 });
      await waitForReady(page);
    }
    await prepareCapture(page, { letterbox });
    await renderAt(page, time, { frames: 0 });
    const stats = await readStats(page);
    const target = path.join(outDir, `${String(index + 1).padStart(2, '0')}-${id}.png`);
    await captureCanvas(page, target, { format: 'png' });
    console.log(`[shot] ${id} -> ${target}`, formatStats(stats));
  }

  const sceneErrors = totalErrors(errors);
  for (const error of sceneErrors) console.error(error);
  failures += sceneErrors.length;
  if (failures > 0) throw new Error(`${failures} page error(s) during capture`);
} finally {
  await browser.close();
  await closeServer(server);
}
