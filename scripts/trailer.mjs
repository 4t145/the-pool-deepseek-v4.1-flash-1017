/**
 * Deterministic trailer capture: steps the guided cinematic camera at an exact
 * frame cadence, screenshots every frame with the 2.39:1 letterbox burned in,
 * then cuts the windows together with short cross-dissolves and encodes H.264.
 *
 *   pnpm trailer                                   # defaults: 3 x 8 s windows, 22.8 s
 *   pnpm trailer -- --seconds=24                   # retime to an exact total
 *   pnpm trailer -- --segments=0:8,14:8,33:8       # guided-take start:duration windows
 *   pnpm trailer -- --quality=high --keep-frames   # keep PNGs for inspection
 *
 * Output: stills/trailer.mp4 (1920x1080, 24 fps, yuv420p, letterboxed) plus
 * stills/trailer.json with the frame plan and ffprobe verification.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  closeServer,
  createArgReader,
  launchBrowser,
  openScene,
  prepareCapture,
  captureCanvas,
  renderAt,
  startServer,
  totalErrors,
} from './lib/bench.mjs';
import { CINEMATIC_DURATION } from '../src/world/layout.ts';
import {
  buildTrailerPlan,
  buildXfadeFilter,
  frameName,
  parseSegments,
  validateTrailerPlan,
} from './lib/trailer-plan.mjs';

const args = createArgReader();

const fps = args.number('fps', 24);
const width = Math.round(args.number('width', 1920));
const height = Math.round(args.number('height', 1080));
const quality = args.option('quality', 'ultra');
const crossfade = args.number('crossfade', 0.6);
const requestedSeconds = args.number('seconds', null);
const outFile = path.resolve(args.option('out', 'stills/trailer.mp4'));
const framesRoot = path.resolve(args.option('frames', 'shots/trailer-frames'));
const mediaRoot = path.join(framesRoot, 'segments');
const keepFrames = args.flag('keep-frames');
// Testing escape hatch: permits a short/single-segment cut for bench smoke tests.
const allowShort = args.flag('allow-short');
const crf = Math.round(args.number('crf', 18));
const preset = args.option('preset', 'slow');
const intermediateCrf = Math.round(args.number('intermediate-crf', 10));
// JPEG frames are ~6x faster to capture than PNG and are re-encoded by H.264
// anyway; PNG stays available for maximum-fidelity runs.
const frameFormat = args.option('frame-format', 'jpeg').toLowerCase();
if (frameFormat !== 'jpeg' && frameFormat !== 'png') throw new Error('--frame-format must be jpeg or png');
const frameExtension = frameFormat === 'jpeg' ? 'jpg' : 'png';
const jpegQuality = Math.round(args.number('jpeg-quality', 95));

const baseSegments = parseSegments(args.option('segments', null));
let segments = baseSegments;
if (requestedSeconds !== null) {
  const share = (requestedSeconds + crossfade * Math.max(0, baseSegments.length - 1)) / baseSegments.length;
  const duration = Math.max(1 / fps, Math.round(share * fps) / fps);
  segments = baseSegments.map((segment) => ({ start: segment.start, duration }));
}

// The guided take length is authoritative in src/world/layout.ts; Node 24 strips
// the types on import, so the trailer windows are always bound-checked against
// the real CINEMATIC_DURATION instead of a duplicated constant.
const takeSeconds = args.number('take', CINEMATIC_DURATION);
const plan = buildTrailerPlan({ segments, fps, width, height, crossfade, cinematicDuration: takeSeconds });
const validation = validateTrailerPlan(plan);
if (!allowShort && !validation.ok) throw new Error(`Trailer plan rejected: ${validation.problems.join('; ')}`);

console.log(
  `[trailer] ${plan.width}x${plan.height} @ ${plan.fps} fps · ${plan.totalSeconds.toFixed(2)}s · ` +
    `${plan.segments.map((segment) => `${segment.frameCount}f@${segment.start}s`).join(' + ')} · xfade ${crossfade}s`,
);

/** Run a child process and return stdout/stderr; reject with the stderr tail. */
function run(command, commandArgs, { allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      const result = { code: code ?? 1, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() };
      if (result.code !== 0 && !allowFailure) {
        reject(new Error(`${command} exited ${result.code}\n${result.stderr.trim().split('\n').slice(-12).join('\n')}`));
        return;
      }
      resolve(result);
    });
  });
}

async function encodeSegment(segment, index) {
  const source = path.join(framesRoot, `segment-${String(index).padStart(2, '0')}`);
  const target = path.join(mediaRoot, `segment-${String(index).padStart(2, '0')}.mp4`);
  const result = await run('ffmpeg', [
    '-y',
    '-hide_banner',
    '-loglevel', 'error',
    '-framerate', String(fps),
    '-start_number', '0',
    '-i', path.join(source, frameName(0, frameExtension).replace('00000', '%05d')),
    '-vf', 'scale=in_range=full:out_range=limited:out_color_matrix=bt709,format=yuv420p',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', String(intermediateCrf),
    '-pix_fmt', 'yuv420p',
    '-color_range', 'tv',
    '-colorspace', 'bt709',
    '-color_primaries', 'bt709',
    '-color_trc', 'bt709',
    '-r', String(fps),
    target,
  ]);
  if (result.stderr.trim()) console.warn(`[trailer] ffmpeg (segment ${index}): ${result.stderr.trim()}`);
  void segment;
  return target;
}

async function encodeTrailer(segmentFiles) {
  await mkdir(path.dirname(outFile), { recursive: true });
  const common = ['-y', '-hide_banner', '-loglevel', 'error'];
  const encode = [
    '-c:v', 'libx264',
    '-preset', preset,
    '-crf', String(crf),
    '-pix_fmt', 'yuv420p',
    '-color_range', 'tv',
    '-colorspace', 'bt709',
    '-color_primaries', 'bt709',
    '-color_trc', 'bt709',
    '-r', String(fps),
    '-movflags', '+faststart',
  ];
  if (segmentFiles.length === 1) {
    await run('ffmpeg', [...common, '-i', segmentFiles[0], ...encode, outFile]);
    return 'single';
  }
  const filter = buildXfadeFilter(plan);
  if (!filter) throw new Error('Expected an xfade filter chain for a multi-segment trailer');
  const inputs = segmentFiles.flatMap((file) => ['-i', file]);
  const result = await run('ffmpeg', [
    ...common,
    ...inputs,
    '-filter_complex', filter,
    '-map', '[v]',
    ...encode,
    outFile,
  ]);
  if (result.stderr.trim()) console.warn(`[trailer] ffmpeg (xfade): ${result.stderr.trim()}`);
  return filter;
}

async function probe(file) {
  const result = await run('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=codec_name,width,height,r_frame_rate,nb_frames,pix_fmt',
    '-show_entries', 'format=duration',
    '-of', 'json',
    file,
  ]);
  return JSON.parse(result.stdout);
}

const sha256 = async (file) => createHash('sha256').update(await readFile(file)).digest('hex');

await rm(framesRoot, { recursive: true, force: true });
await mkdir(mediaRoot, { recursive: true });

const { server, url } = await startServer(process.cwd());
const browser = await launchBrowser();
let failures = 0;

try {
  const { page, context, errors } = await openScene(browser, url, {
    width,
    height,
    params: { capture: 1, quality, t: 0, hud: 0, letterbox: 1 },
  });
  await prepareCapture(page, { letterbox: true });

  const started = Date.now();
  let renderedFrames = 0;

  for (const [segmentIndex, segment] of plan.segments.entries()) {
    const directory = path.join(framesRoot, `segment-${String(segmentIndex).padStart(2, '0')}`);
    await mkdir(directory, { recursive: true });
    for (const frame of segment.frames) {
      await renderAt(page, frame.time, { frames: 0 });
      await captureCanvas(page, path.join(directory, frameName(frame.index, frameExtension)), {
        format: frameFormat,
        quality: jpegQuality,
      });
      renderedFrames += 1;
      if (renderedFrames % 24 === 0 || renderedFrames === plan.totalFrames) {
        const elapsed = (Date.now() - started) / 1000;
        const rate = renderedFrames / elapsed;
        const remaining = (plan.totalFrames - renderedFrames) / Math.max(rate, 0.001);
        console.log(
          `[trailer] ${renderedFrames}/${plan.totalFrames} frames · ${rate.toFixed(1)} fps capture · ~${remaining.toFixed(0)}s left`,
        );
      }
    }
  }

  const sceneErrors = totalErrors(errors);
  for (const error of sceneErrors) console.error(`[browser] ${error}`);
  failures += sceneErrors.length;
  await context.close();

  const segmentFiles = [];
  for (const [index] of plan.segments.entries()) {
    segmentFiles.push(await encodeSegment(plan.segments[index], index));
  }
  console.log('[trailer] encoding H.264...');
  const filter = await encodeTrailer(segmentFiles);
  const info = await probe(outFile);
  const stream = info.streams?.[0] ?? {};
  const duration = Number(info.format?.duration ?? 0);
  const hash = await sha256(outFile);

  const report = {
    generatedAt: new Date().toISOString().slice(0, 10),
    file: path.relative(process.cwd(), outFile),
    sha256: hash,
    bytes: Number((await readFile(outFile)).length),
    plan: {
      width: plan.width,
      height: plan.height,
      fps: plan.fps,
      crossfade: plan.crossfade,
      frameFormat,
      totalSeconds: plan.totalSeconds,
      totalFrames: plan.totalFrames,
      // 2.39:1 bars burned in by PostPipeline (138 px top and bottom at 1080p).
      letterboxBarsPx: Math.max(0, Math.round(((1 - plan.width / plan.height / 2.39) / 2) * plan.height)),
      segments: plan.segments.map((segment) => ({ start: segment.start, duration: segment.duration, frames: segment.frameCount })),
      xfade: filter,
    },
    ffprobe: {
      codec: stream.codec_name,
      width: stream.width,
      height: stream.height,
      rFrameRate: stream.r_frame_rate,
      frames: Number(stream.nb_frames ?? 0),
      pixelFormat: stream.pix_fmt,
      duration,
    },
  };
  await writeFile(path.join(path.dirname(outFile), 'trailer.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  console.log(
    `[trailer] ${path.relative(process.cwd(), outFile)} · ${stream.codec_name} ${stream.width}x${stream.height} ` +
      `${stream.r_frame_rate} fps · ${duration.toFixed(2)}s · ${(report.bytes / 1e6).toFixed(1)} MB`,
  );

  const problems = [];
  if (stream.codec_name !== 'h264') problems.push(`codec is ${stream.codec_name}, expected h264`);
  if (stream.width !== width || stream.height !== height) problems.push(`size ${stream.width}x${stream.height}, expected ${width}x${height}`);
  if (stream.r_frame_rate !== '24/1') problems.push(`frame rate ${stream.r_frame_rate}, expected 24/1`);
  if (!allowShort && (duration < 20 || duration > 30.5)) problems.push(`duration ${duration.toFixed(2)}s outside 20–30 s`);
  if (failures > 0) problems.push(`${failures} page error(s)`);
  if (problems.length > 0) throw new Error(`Trailer verification failed: ${problems.join('; ')}`);
  console.log('[trailer] verified: h264 · 1920x1080 · 24 fps · letterboxed · UI-free');

  if (!keepFrames) await rm(framesRoot, { recursive: true, force: true });
  else console.log(`[trailer] frames kept in ${path.relative(process.cwd(), framesRoot)}`);
} finally {
  await browser.close();
  await closeServer(server);
}
