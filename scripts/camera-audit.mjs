/**
 * Camera-path audit: proves (or disproves) the "slow moves, invisible loop, no
 * clipping" part of the acceptance bar without eyeballing 24 fps of video.
 *
 *   pnpm camera-audit
 *   pnpm camera-audit -- --fps=24 --window=8 --json=shots/camera-audit.json
 *
 * What it checks:
 * - guided take: loop seam with a 1 ms finite difference (position, linear
 *   velocity and turn rate at the wrap), max linear speed, max turn rate, max
 *   acceleration, and that every CINEMATIC_KEYS beat is visited exactly;
 * - clipping: camera stays inside the hall with a margin and away from the
 *   columns / stair block;
 * - each of the seven shots: the sampled camera matches the authoritative
 *   LAYOUT pose and fov and stays inside the room;
 * - slowest window scan: the calmest N-second windows of the take, which is what
 *   a trailer cut should be built from.
 *
 * Exit code is non-zero only for hard failures (seam discontinuity, out of
 * bounds, beat/pose mismatch); speed limits are warnings so a stylised move can
 * still be reported honestly.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CINEMATIC_DURATION, CINEMATIC_KEYS, LAYOUT, SHOTS } from '../src/world/layout.ts';
import {
  closeServer,
  createArgReader,
  launchBrowser,
  openScene,
  prepareCapture,
  startServer,
  totalErrors,
} from './lib/bench.mjs';

const args = createArgReader();
const fps = args.number('fps', 24);
const duration = args.number('duration', CINEMATIC_DURATION);
const windowSeconds = args.number('window', 8);
const jsonPath = path.resolve(args.option('json', 'shots/camera-audit.json'));

const WARN_LINEAR_SPEED = args.number('max-speed', 1.6); // m/s
const WARN_ANGULAR_SPEED = args.number('max-turn', 22); // deg/s
const WARN_ACCELERATION = args.number('max-accel', 6); // m/s^2
const SEAM_EPSILON = 0.001; // seconds

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const length = (v) => Math.hypot(v[0], v[1], v[2]);
const distance = (a, b) => length(sub(a, b));
const scale = (v, s) => [v[0] * s, v[1] * s, v[2] * s];

/** Angle between two quaternions in degrees. */
function quaternionAngleDegrees(a, b) {
  const dot = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
  return (2 * Math.acos(Math.min(1, dot)) * 180) / Math.PI;
}

const percentile = (values, p) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
};

const { server, url } = await startServer(process.cwd());
const browser = await launchBrowser();
const report = {
  generatedAt: new Date().toISOString().slice(0, 10),
  fps,
  guidedTake: null,
  beats: [],
  slowWindows: [],
  shots: [],
};
const hardFailures = [];
const warnings = [];

try {
  const { page, context, errors } = await openScene(browser, url, {
    width: 640,
    height: 360,
    params: { capture: 1, quality: 'low', t: 0, hud: 0, letterbox: 0 },
  });
  await prepareCapture(page, { letterbox: false });

  // --- Guided take: dense sampling from the authoritative Cinematics sampler.
  const guided = await page.evaluate(
    ({ frameRate, takeSeconds }) => {
      const api = window.__pool;
      if (!api) throw new Error('window.__pool missing');
      const round = (value) => Math.round(value * 1e7) / 1e7;
      const sample = (t) => {
        api.setCinematic(t);
        return {
          t: round(t),
          position: api.camera.position.toArray().map(round),
          quaternion: api.camera.quaternion.toArray().map(round),
          fov: round(api.camera.fov),
        };
      };
      const frames = [];
      const count = Math.round(takeSeconds * frameRate);
      for (let index = 0; index < count; index++) frames.push(sample(index / frameRate));

      // Loop seam with a 1 ms finite difference on both sides of the wrap. These
      // samples stay unrounded: the deltas are ~1e-5 m / ~1e-3 deg and rounding
      // to the display precision used above would drown them in noise.
      const raw = (t) => {
        api.setCinematic(t);
        return { position: api.camera.position.toArray(), quaternion: api.camera.quaternion.toArray() };
      };
      const beforeOuter = raw(takeSeconds - 0.001);
      const atEnd = raw(takeSeconds);
      const atStart = raw(0);
      const afterOuter = raw(0.001);
      return { frames, seam: { beforeOuter, atEnd, atStart, afterOuter } };
    },
    { frameRate: fps, takeSeconds: duration },
  );

  const frames = guided.frames;
  const step = 1 / fps;
  const motion = [];
  const linearSpeeds = [];
  const angularSpeeds = [];
  const accelerations = [];
  let maxLinear = { value: 0, t: 0 };
  let maxAngular = { value: 0, t: 0 };
  let maxAcceleration = { value: 0, t: 0 };

  for (let index = 1; index < frames.length; index++) {
    const previous = frames[index - 1];
    const current = frames[index];
    const speed = distance(current.position, previous.position) / step;
    const turn = quaternionAngleDegrees(previous.quaternion, current.quaternion) / step;
    linearSpeeds.push(speed);
    angularSpeeds.push(turn);
    motion.push({ t: current.t, speed, turn });
    if (index > 1) {
      const previousSpeed = linearSpeeds[linearSpeeds.length - 2];
      const acceleration = Math.abs(speed - previousSpeed) / step;
      accelerations.push(acceleration);
      if (acceleration > maxAcceleration.value) maxAcceleration = { value: acceleration, t: current.t };
    }
    if (speed > maxLinear.value) maxLinear = { value: speed, t: current.t };
    if (turn > maxAngular.value) maxAngular = { value: turn, t: current.t };
  }

  const seam = guided.seam;
  const seamDistance = distance(seam.atEnd.position, seam.atStart.position);
  const velocityIn = scale(sub(seam.atEnd.position, seam.beforeOuter.position), 1 / SEAM_EPSILON);
  const velocityOut = scale(sub(seam.afterOuter.position, seam.atStart.position), 1 / SEAM_EPSILON);
  const seamVelocity = distance(velocityIn, velocityOut);
  const turnIn = quaternionAngleDegrees(seam.beforeOuter.quaternion, seam.atEnd.quaternion) / SEAM_EPSILON;
  const turnOut = quaternionAngleDegrees(seam.atStart.quaternion, seam.afterOuter.quaternion) / SEAM_EPSILON;
  const seamTurnRate = Math.abs(turnIn - turnOut);

  // Clip test: hall box with margin, plus the two column rows and stair block.
  const hall = LAYOUT.hall;
  const margin = 0.12;
  const inside = (position) =>
    Math.abs(position[0]) < hall.halfWidth - margin &&
    position[1] > 0.14 &&
    position[1] < hall.ceiling - margin &&
    position[2] > hall.zMin + margin &&
    position[2] < hall.zMax - margin;
  const outside = frames.filter((frame) => !inside(frame.position)).map((frame) => frame.t);
  const columnHalf = LAYOUT.columns.size / 2 + 0.22;
  const nearColumns = frames
    .filter((frame) =>
      LAYOUT.columns.z.some(
        (z) => Math.abs(Math.abs(frame.position[0]) - LAYOUT.columns.x) < columnHalf && Math.abs(frame.position[2] - z) < columnHalf,
      ),
    )
    .map((frame) => frame.t);
  const stairs = LAYOUT.stairs;
  const nearStairs = frames
    .filter(
      (frame) =>
        Math.abs(frame.position[0] - stairs.x) < stairs.width / 2 + 0.2 && Math.abs(frame.position[2] - stairs.z) < 1.4,
    )
    .map((frame) => frame.t);

  report.guidedTake = {
    duration,
    sampledFrames: frames.length,
    seam: { distance: seamDistance, velocityDelta: seamVelocity, turnRateDelta: seamTurnRate },
    linearSpeed: { max: maxLinear.value, at: maxLinear.t, p50: percentile(linearSpeeds, 50), p95: percentile(linearSpeeds, 95) },
    angularSpeed: { max: maxAngular.value, at: maxAngular.t, p50: percentile(angularSpeeds, 50), p95: percentile(angularSpeeds, 95) },
    acceleration: { max: maxAcceleration.value, at: maxAcceleration.t },
    clipping: { outsideHall: outside, nearColumns, nearStairs },
  };

  if (seamDistance > 0.003) hardFailures.push(`guided take does not close: seam distance ${seamDistance.toFixed(4)} m`);
  if (seamVelocity > 0.01) hardFailures.push(`guided take has a velocity cut at the wrap: ${seamVelocity.toFixed(5)} m/s`);
  if (seamTurnRate > 0.5) hardFailures.push(`guided take has a turn-rate cut at the wrap: ${seamTurnRate.toFixed(3)} deg/s`);
  if (outside.length > 0) hardFailures.push(`camera leaves the hall at ${outside.length} sampled frames (first t=${outside[0]})`);
  if (maxLinear.value > WARN_LINEAR_SPEED) warnings.push(`max linear speed ${maxLinear.value.toFixed(2)} m/s > ${WARN_LINEAR_SPEED} m/s at t=${maxLinear.t}`);
  if (maxAngular.value > WARN_ANGULAR_SPEED) warnings.push(`max turn rate ${maxAngular.value.toFixed(1)} deg/s > ${WARN_ANGULAR_SPEED} deg/s at t=${maxAngular.t}`);
  if (maxAcceleration.value > WARN_ACCELERATION) warnings.push(`max acceleration ${maxAcceleration.value.toFixed(2)} m/s^2 > ${WARN_ACCELERATION} at t=${maxAcceleration.t}`);
  if (nearColumns.length > 0) warnings.push(`camera passes within ${columnHalf.toFixed(2)} m of a column at ${nearColumns.length} frames`);
  if (nearStairs.length > 0) warnings.push(`camera passes over the stair block at ${nearStairs.length} frames`);

  console.log(
    `[camera] guided take ${duration}s · seam pos ${seamDistance.toFixed(5)} m · seam vel ${seamVelocity.toFixed(5)} m/s · seam turn ${seamTurnRate.toFixed(3)} deg/s · ` +
      `speed max ${maxLinear.value.toFixed(2)} m/s at t=${maxLinear.t} (p95 ${percentile(linearSpeeds, 95).toFixed(2)}) · ` +
      `turn max ${maxAngular.value.toFixed(1)} deg/s (p95 ${percentile(angularSpeeds, 95).toFixed(1)}) · accel max ${maxAcceleration.value.toFixed(2)} m/s^2`,
  );

  // --- Every cinematic beat must be visited exactly (position + fov).
  const beatSamples = await page.evaluate((times) => {
    const api = window.__pool;
    const round = (value) => Math.round(value * 1e7) / 1e7;
    return times.map((time) => {
      api.setCinematic(time);
      return {
        time,
        position: api.camera.position.toArray().map(round),
        fov: round(api.camera.fov),
      };
    });
  }, CINEMATIC_KEYS.map((key) => key.time));
  for (const [index, key] of CINEMATIC_KEYS.entries()) {
    const sample = beatSamples[index];
    const poseError = distance(sample.position, [...key.position]);
    const fovError = Math.abs(sample.fov - key.fov);
    report.beats.push({ time: key.time, poseError, fovError });
    if (poseError > 0.002) hardFailures.push(`guided take misses the beat at t=${key.time} by ${poseError.toFixed(3)} m`);
    if (fovError > 0.05) hardFailures.push(`guided take fov at t=${key.time} is ${sample.fov}, key says ${key.fov}`);
  }
  console.log(`[camera] beats: ${report.beats.map((beat) => `${beat.time}s/${beat.poseError.toFixed(4)}m`).join(' · ')}`);

  // --- Slowest N-second windows: the candidate trailer cuts.
  const starts = [];
  for (let start = 0; start + windowSeconds <= duration + 1e-9; start += 0.5) starts.push(start);
  const windows = starts.map((start) => {
    const insideWindow = motion.filter((sample) => sample.t > start && sample.t <= start + windowSeconds);
    const maxSpeed = insideWindow.reduce((max, sample) => Math.max(max, sample.speed), 0);
    const maxTurn = insideWindow.reduce((max, sample) => Math.max(max, sample.turn), 0);
    const meanSpeed = insideWindow.reduce((sum, sample) => sum + sample.speed, 0) / Math.max(insideWindow.length, 1);
    return { start, end: start + windowSeconds, maxSpeed, maxTurn, meanSpeed };
  });
  windows.sort((a, b) => a.maxSpeed - b.maxSpeed || a.maxTurn - b.maxTurn);
  report.slowWindows = windows.slice(0, 6);
  console.log(
    `[camera] calmest ${windowSeconds}s windows: ${report.slowWindows
      .map((window) => `[${window.start.toFixed(1)}-${window.end.toFixed(1)}] ${window.maxSpeed.toFixed(2)} m/s / ${window.maxTurn.toFixed(1)} °/s`)
      .join(' · ')}`,
  );

  // --- Each shot must land exactly on its LAYOUT pose and stay inside the room.
  for (const shot of SHOTS) {
    const sample = await page.evaluate((id) => {
      const api = window.__pool;
      api.setShot(id);
      const round = (value) => Math.round(value * 1e7) / 1e7;
      return {
        position: api.camera.position.toArray().map(round),
        fov: round(api.camera.fov),
      };
    }, shot.id);
    const poseError = distance(sample.position, [...shot.position]);
    const fovError = Math.abs(sample.fov - shot.fov);
    const insideHall = inside(sample.position);
    report.shots.push({ id: shot.id, label: shot.label, position: sample.position, fov: sample.fov, poseError, fovError, insideHall });
    if (poseError > 0.002) hardFailures.push(`shot ${shot.id} camera is ${poseError.toFixed(3)} m from its LAYOUT pose`);
    if (fovError > 0.01) hardFailures.push(`shot ${shot.id} fov ${sample.fov} != LAYOUT ${shot.fov}`);
    if (!insideHall) hardFailures.push(`shot ${shot.id} camera is outside the hall at ${sample.position.join(', ')}`);
    console.log(`[camera] shot ${shot.id.padEnd(9)} pose error ${poseError.toFixed(4)} m · fov ${sample.fov.toFixed(1)} · inside hall ${insideHall}`);
  }

  const sceneErrors = totalErrors(errors);
  for (const error of sceneErrors) console.error(`[browser] ${error}`);
  if (sceneErrors.length > 0) hardFailures.push(`${sceneErrors.length} browser error(s)`);

  report.hardFailures = hardFailures;
  report.warnings = warnings;
  report.ok = hardFailures.length === 0;
  await mkdir(path.dirname(jsonPath), { recursive: true });
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`[camera] wrote ${path.relative(process.cwd(), jsonPath)}`);
  for (const warning of warnings) console.warn(`[camera] warn: ${warning}`);
  for (const failure of hardFailures) console.error(`[camera] FAIL: ${failure}`);
  if (!report.ok) process.exitCode = 1;
  await context.close();
} finally {
  await browser.close();
  await closeServer(server);
}
