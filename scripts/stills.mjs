/**
 * Deterministic still capture for the committed deliverables.
 *
 *   pnpm stills                              # seven 1920x1080 frames + 4K hero
 *   pnpm stills -- --quality=high            # quality tier
 *   pnpm stills -- --skip-hero               # fast iteration set
 *   pnpm stills -- --shots=arrival,flume     # subset
 *   pnpm stills -- --out=stills --hero-shot=flume
 *
 * Files land in stills/ (committed): NN-<shot>.png and hero-4k-<shot>.png, plus
 * stills/manifest.json with the exact scene time, size, stats, per-frame
 * verification and SHA-256 so a later run can prove it reproduced the same image.
 *
 * Every frame is captured into a fresh page; if the host is saturated (other
 * peers rendering) the boot or the shot assertion is retried instead of shipping
 * a wrong pose.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  SHOT_IDS,
  SHOT_TIMES,
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
const quality = args.option('quality', 'ultra');
const outDir = path.resolve(args.option('out', 'stills'));
const skipHero = args.flag('skip-hero');
const heroShot = args.option('hero-shot', 'arrival');
const heroWidth = Math.round(args.number('hero-width', 3840));
const heroHeight = Math.round(args.number('hero-height', 2160));
const attempts = Math.round(args.number('attempts', 3));
const requested = args.list('shots', null);

const shots = requested ?? [...SHOT_IDS];
for (const shot of shots) {
  if (!SHOT_IDS.includes(shot)) throw new Error(`Unknown shot "${shot}". Known: ${SHOT_IDS.join(', ')}`);
}
if (!SHOT_IDS.includes(heroShot)) throw new Error(`Unknown hero shot "${heroShot}"`);

const timeFor = (shot) => args.number(`time-${shot}`, SHOT_TIMES[shot] ?? 2.4);
const sha256 = async (file) => createHash('sha256').update(await readFile(file)).digest('hex');

await mkdir(outDir, { recursive: true });
const { server, url } = await startServer(process.cwd());
const browser = await launchBrowser();
const manifest = {
  generatedAt: new Date().toISOString().slice(0, 10),
  quality,
  shots: [],
  hero: null,
};
let failures = 0;

try {
  for (const [index, id] of shots.entries()) {
    const time = timeFor(id);
    const target = path.join(outDir, `${String(index + 1).padStart(2, '0')}-${id}.png`);
    const result = await captureStill(browser, url, {
      width,
      height,
      params: { shot: id, capture: 1, quality, t: time, hud: 0, letterbox: 0 },
      shotId: id,
      time,
      target,
      attempts,
    });
    const hash = await sha256(target);
    manifest.shots.push({
      id,
      time,
      width,
      height,
      quality,
      verified: result.verified,
      shotAttempts: result.shotAttempts,
      bootAttempt: result.bootAttempt,
      sha256: hash,
      stats: result.stats,
    });
    console.log(
      `[stills] ${String(index + 1).padStart(2, '0')} ${id.padEnd(9)} t=${time.toFixed(2)}s  ${formatStats(result.stats)}  -> ${path.relative(process.cwd(), target)}`,
    );
    for (const error of result.errors) console.error(`[browser] ${error}`);
    failures += result.errors.length;
  }

  if (!skipHero) {
    const heroTime = args.number('hero-time', timeFor(heroShot));
    const target = path.join(outDir, `hero-4k-${heroShot}.png`);
    const result = await captureStill(browser, url, {
      width: heroWidth,
      height: heroHeight,
      params: { shot: heroShot, capture: 1, quality, t: heroTime, hud: 0, letterbox: 0 },
      shotId: heroShot,
      time: heroTime,
      target,
      attempts,
    });
    const hash = await sha256(target);
    manifest.hero = {
      id: heroShot,
      time: heroTime,
      width: heroWidth,
      height: heroHeight,
      quality,
      verified: result.verified,
      shotAttempts: result.shotAttempts,
      bootAttempt: result.bootAttempt,
      sha256: hash,
      stats: result.stats,
    };
    console.log(
      `[stills] HERO ${heroShot} ${heroWidth}x${heroHeight} t=${heroTime.toFixed(2)}s  ${formatStats(result.stats)}  -> ${path.relative(process.cwd(), target)}`,
    );
    for (const error of result.errors) console.error(`[browser] ${error}`);
    failures += result.errors.length;
  }

  await writeFile(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`[stills] wrote ${path.relative(process.cwd(), path.join(outDir, 'manifest.json'))}`);
  if (failures > 0) throw new Error(`${failures} page error(s) during stills capture`);
} finally {
  await browser.close();
  await closeServer(server);
}
