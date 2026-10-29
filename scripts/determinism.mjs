/**
 * Determinism check for renderAt(t). Every case is captured twice in two fresh
 * browser launches; the two PNGs must be byte-identical, and the transform dump
 * of every scene object must match exactly. A third capture of the same frame in
 * the same session proves renderAt is idempotent.
 *
 *   pnpm determinism
 *   pnpm determinism -- --out=shots/determinism
 *
 * If the two runs differ, ffmpeg PSNR is reported so a difference caused by
 * driver AA noise can be separated from a real non-deterministic scene change.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  closeServer,
  createArgReader,
  launchBrowser,
  openScene,
  prepareCapture,
  readTransforms,
  captureCanvas,
  renderAt,
  startServer,
  totalErrors,
} from './lib/bench.mjs';

const args = createArgReader();
const outDir = path.resolve(args.option('out', 'shots/determinism'));
await mkdir(outDir, { recursive: true });

const CASES = [
  {
    id: 'shot-arrival-1080p',
    width: 1920,
    height: 1080,
    time: 2.4,
    params: { shot: 'arrival', capture: 1, quality: 'ultra', t: 2.4, hud: 0, letterbox: 0 },
  },
  {
    id: 'cinematic-1080p',
    width: 1920,
    height: 1080,
    time: 21.3,
    params: { capture: 1, quality: 'ultra', t: 21.3, hud: 0, letterbox: 0 },
  },
];

const sha256 = async (file) => createHash('sha256').update(await readFile(file)).digest('hex');

function run(command, commandArgs) {
  return new Promise((resolve) => {
    const child = spawn(command, commandArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stderr = [];
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', () => resolve(null));
    child.on('close', () => resolve(Buffer.concat(stderr).toString()));
  });
}

/** PSNR between two PNGs; "inf" means pixel-identical. */
async function psnr(a, b) {
  const output = await run('ffmpeg', ['-hide_banner', '-i', a, '-i', b, '-lavfi', '[0:v][1:v]psnr', '-f', 'null', '-']);
  if (!output) return null;
  const match = output.match(/average:([0-9.]+|inf)/);
  return match ? match[1] : null;
}

const { server, url } = await startServer(process.cwd());
const report = { generatedAt: new Date().toISOString().slice(0, 10), cases: [] };
let failures = 0;

async function captureOnce(caseDef, runLabel) {
  const browser = await launchBrowser();
  try {
    // Boot can time out when peers are rendering on the same host: retry a
    // fresh page instead of failing the evidence run.
    let scene = null;
    for (let attempt = 1; attempt <= 3 && !scene; attempt++) {
      try {
        scene = await openScene(browser, url, {
          width: caseDef.width,
          height: caseDef.height,
          params: caseDef.params,
        });
      } catch (error) {
        console.warn(`[determinism] ${caseDef.id} boot attempt ${attempt}/3 failed: ${error.message}`);
        await new Promise((resolve) => setTimeout(resolve, 800 * attempt));
      }
    }
    if (!scene) throw new Error(`${caseDef.id}: page never reached __POOL_READY__`);
    const { page, context, errors } = scene;
    await prepareCapture(page, { letterbox: false });
    await renderAt(page, caseDef.time, { frames: 0 });
    const transforms = await readTransforms(page);
    const first = path.join(outDir, `${caseDef.id}-run${runLabel}-a.png`);
    await captureCanvas(page, first, { format: 'png' });
    const hashA = await sha256(first);

    // Same scene time again, same session: renderAt must be idempotent.
    await renderAt(page, caseDef.time, { frames: 0 });
    const second = path.join(outDir, `${caseDef.id}-run${runLabel}-b.png`);
    await captureCanvas(page, second, { format: 'png' });
    const hashB = await sha256(second);
    const sceneErrors = totalErrors(errors);
    await context.close();
    return { file: first, secondFile: second, hash: hashA, repeatHash: hashB, transforms, errors: sceneErrors };
  } finally {
    await browser.close();
  }
}

try {
  for (const caseDef of CASES) {
    const runA = await captureOnce(caseDef, 'A');
    const runB = await captureOnce(caseDef, 'B');

    const hashesMatch = runA.hash === runB.hash;
    const repeatMatches = runA.hash === runA.repeatHash;
    const transformsMatch = JSON.stringify(runA.transforms) === JSON.stringify(runB.transforms);
    const differences = [];
    if (!hashesMatch) {
      const value = await psnr(runA.file, runB.file);
      differences.push(`pixel diff (PSNR ${value ?? 'unknown'} dB)`);
    }
    if (!repeatMatches) differences.push('renderAt(t) is not idempotent in one session');
    if (!transformsMatch) differences.push('object transforms differ between runs');
    if (runA.errors.length > 0 || runB.errors.length > 0) differences.push(`${runA.errors.length + runB.errors.length} browser error(s)`);
    if (differences.length > 0) failures += 1;

    const entry = {
      id: caseDef.id,
      width: caseDef.width,
      height: caseDef.height,
      time: caseDef.time,
      sha256: runA.hash,
      sha256RunB: runB.hash,
      sameSessionHash: runA.repeatHash,
      pixelIdentical: hashesMatch,
      idempotent: repeatMatches,
      transformsIdentical: transformsMatch,
      objects: runA.transforms?.objects.length ?? 0,
      ok: differences.length === 0,
      differences,
    };
    report.cases.push(entry);
    console.log(
      `[determinism] ${entry.ok ? 'PASS' : 'FAIL'} ${caseDef.id} · ` +
        `identical=${hashesMatch} idempotent=${repeatMatches} transforms=${transformsMatch} · ` +
        `sha256=${runA.hash.slice(0, 16)}…` +
        (differences.length > 0 ? ` · ${differences.join(', ')}` : ''),
    );
    for (const error of [...runA.errors, ...runB.errors]) console.error(`[browser] ${error}`);
  }

  await writeFile(path.join(outDir, 'determinism.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  if (failures > 0) throw new Error(`${failures} determinism case(s) failed — see ${path.relative(process.cwd(), outDir)}/determinism.json`);
  console.log(`[determinism] all ${report.cases.length} cases pixel-identical with stable transforms`);
} finally {
  await closeServer(server);
}
