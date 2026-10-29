/**
 * Deterministic still capture. Runs the real app in Chrome (hardware WebGL),
 * waits for the loader and the first resolved frame, then captures any of the
 * camera shots at a fixed scene time.
 *
 *   pnpm shot -- --shot=arrival --width=1920 --height=1080
 *   pnpm shot -- --all --time=3.5
 *   pnpm shot -- --shot=arch --letterbox --time=18.6
 *
 * The CLI is unchanged from the baseline. `--letterbox` is honoured (it used to
 * be force-reset to off) and every frame asserts the requested shot pose before
 * it is written, retrying on a saturated host instead of shipping a wrong frame.
 */
import path from 'node:path';
import {
  SHOT_IDS,
  captureStill,
  closeServer,
  createArgReader,
  formatStats,
  launchBrowser,
  startServer,
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
const attempts = Math.round(args.number('attempts', 3));
const shots = all ? [...SHOT_IDS] : [shot];

if (!SHOT_IDS.includes(shot) && !all) throw new Error(`Unknown shot "${shot}". Known: ${SHOT_IDS.join(', ')}`);

const { server, url } = await startServer(process.cwd());
const browser = await launchBrowser();
let failures = 0;

try {
  for (const [index, id] of shots.entries()) {
    const target = path.join(outDir, `${String(index + 1).padStart(2, '0')}-${id}.png`);
    const result = await captureStill(browser, url, {
      width,
      height,
      params: { shot: id, capture: 1, quality, t: time, hud: 0, letterbox: letterbox ? 1 : 0 },
      shotId: id,
      time,
      target,
      letterbox,
      attempts,
    });
    console.log(`[shot] ${id} -> ${target}`, formatStats(result.stats), result.verified ? 'verified' : 'UNVERIFIED');
    for (const error of result.errors) console.error(`[browser] ${error}`);
    failures += result.errors.length;
  }
  if (failures > 0) throw new Error(`${failures} page error(s) during capture`);
} finally {
  await browser.close();
  await closeServer(server);
}
