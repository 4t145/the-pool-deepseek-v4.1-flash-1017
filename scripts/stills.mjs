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
 * stills/manifest.json with the exact scene time, size, stats and SHA-256 of
 * every frame so a later run can prove it reproduced the same image.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  SHOT_IDS,
  SHOT_TIMES,
  closeServer,
  createArgReader,
  formatStats,
  launchBrowser,
  navigate,
  openScene,
  prepareCapture,
  readStats,
  renderAt,
  captureCanvas,
  startServer,
  totalErrors,
  waitForReady,
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
  const { page, context, errors } = await openScene(browser, url, {
    width,
    height,
    params: { shot: shots[0], capture: 1, quality, t: timeFor(shots[0]), hud: 0, letterbox: 0 },
  });

  for (const [index, id] of shots.entries()) {
    const time = timeFor(id);
    if (index > 0) {
      await navigate(page, url, { shot: id, capture: 1, quality, t: time, hud: 0, letterbox: 0 });
      await waitForReady(page);
    }
    await prepareCapture(page, { letterbox: false });
    await renderAt(page, time, { frames: 0 });
    const stats = await readStats(page);
    const target = path.join(outDir, `${String(index + 1).padStart(2, '0')}-${id}.png`);
    await captureCanvas(page, target, { format: 'png' });
    const hash = await sha256(target);
    manifest.shots.push({ id, time, width, height, quality, sha256: hash, stats });
    console.log(`[stills] ${String(index + 1).padStart(2, '0')} ${id.padEnd(9)} t=${time.toFixed(2)}s  ${formatStats(stats)}  -> ${path.relative(process.cwd(), target)}`);
  }

  const sceneErrors = totalErrors(errors);
  for (const error of sceneErrors) console.error(`[browser] ${error}`);
  failures += sceneErrors.length;

  await context.close();

  if (!skipHero) {
    const heroTime = args.number('hero-time', timeFor(heroShot));
    const hero = await openScene(browser, url, {
      width: heroWidth,
      height: heroHeight,
      params: { shot: heroShot, capture: 1, quality, t: heroTime, hud: 0, letterbox: 0 },
    });
    await prepareCapture(hero.page, { letterbox: false });
    await renderAt(hero.page, heroTime, { frames: 0 });
    const heroStats = await readStats(hero.page);
    const target = path.join(outDir, `hero-4k-${heroShot}.png`);
    await captureCanvas(hero.page, target, { format: 'png' });
    const hash = await sha256(target);
    manifest.hero = { id: heroShot, time: heroTime, width: heroWidth, height: heroHeight, quality, sha256: hash, stats: heroStats };
    console.log(
      `[stills] HERO ${heroShot} ${heroWidth}x${heroHeight} t=${heroTime.toFixed(2)}s  ${formatStats(heroStats)}  -> ${path.relative(process.cwd(), target)}`,
    );
    const heroErrors = totalErrors(hero.errors);
    for (const error of heroErrors) console.error(`[browser] ${error}`);
    failures += heroErrors.length;
    await hero.context.close();
  }

  await writeFile(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`[stills] wrote ${path.relative(process.cwd(), path.join(outDir, 'manifest.json'))}`);
  if (failures > 0) throw new Error(`${failures} page error(s) during stills capture`);
} finally {
  await browser.close();
  await closeServer(server);
}
