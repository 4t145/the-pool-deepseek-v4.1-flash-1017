/**
 * Pure planning math for the trailer. Kept free of Node/Playwright imports so it
 * can be unit-tested (tests/trailer.test.mjs).
 *
 * The trailer is cut from the guided cinematic camera: several consecutive
 * windows of the 40–60 s take, joined by short cross-dissolves. Every frame time
 * is exact (start + index / fps), which keeps grain, water and props deterministic
 * across re-runs.
 */

export const TRAILER_DEFAULTS = Object.freeze({
  width: 1920,
  height: 1080,
  fps: 24,
  crossfade: 0.6,
  segments: [
    { start: 0.0, duration: 8.0 },
    { start: 14.0, duration: 8.0 },
    { start: 33.0, duration: 8.0 },
  ],
});

/** Parse "start:duration,start:duration" into segment descriptors. */
export function parseSegments(spec) {
  if (!spec) return TRAILER_DEFAULTS.segments.map((segment) => ({ ...segment }));
  const segments = spec
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [startRaw, durationRaw] = entry.split(':');
      const start = Number(startRaw);
      const duration = Number(durationRaw);
      if (!Number.isFinite(start) || !Number.isFinite(duration) || duration <= 0) {
        throw new Error(`Invalid trailer segment "${entry}" (expected start:duration in seconds)`);
      }
      return { start, duration };
    });
  if (segments.length === 0) throw new Error('Trailer needs at least one segment');
  return segments;
}

/**
 * Build a full frame plan: per-segment frame counts and exact scene times, plus
 * the crossfade offsets used to chain ffmpeg xfade filters.
 */
export function buildTrailerPlan({
  segments = TRAILER_DEFAULTS.segments,
  fps = TRAILER_DEFAULTS.fps,
  width = TRAILER_DEFAULTS.width,
  height = TRAILER_DEFAULTS.height,
  crossfade = TRAILER_DEFAULTS.crossfade,
  cinematicDuration = null,
} = {}) {
  if (!Number.isFinite(fps) || fps <= 0) throw new Error('fps must be a positive number');
  if (segments.length === 0) throw new Error('Trailer needs at least one segment');
  if (crossfade < 0) throw new Error('crossfade must be >= 0');
  const crossfades = Math.max(0, segments.length - 1);
  if (crossfades > 0 && crossfade * crossfades >= segments.reduce((sum, segment) => sum + segment.duration, 0)) {
    throw new Error('crossfade is longer than the assembled trailer');
  }

  const resolved = segments.map((segment, segmentIndex) => {
    const frameCount = Math.round(segment.duration * fps);
    if (frameCount < 1) throw new Error(`Segment ${segmentIndex} has no frames`);
    const frames = [];
    for (let index = 0; index < frameCount; index++) {
      const time = segment.start + index / fps;
      if (cinematicDuration !== null && time > cinematicDuration + 1e-9) {
        throw new Error(
          `Segment ${segmentIndex} frame ${index} at t=${time.toFixed(3)}s exceeds the guided take (${cinematicDuration}s)`,
        );
      }
      frames.push({ index, time: Math.round(time * 1e6) / 1e6 });
    }
    return {
      index: segmentIndex,
      start: segment.start,
      duration: segment.duration,
      frameCount,
      frames,
    };
  });

  // xfade offset semantics: the offset is measured on the accumulated stream, so
  // each dissolve starts `crossfade` seconds before that stream ends.
  const offsets = [];
  let accumulated = resolved[0].duration;
  for (let index = 1; index < resolved.length; index++) {
    const offset = Math.max(0, accumulated - crossfade);
    offsets.push(Math.round(offset * 1e6) / 1e6);
    accumulated = accumulated + resolved[index].duration - crossfade;
  }
  const totalSeconds = Math.round(accumulated * 1e6) / 1e6;
  const totalFrames = resolved.reduce((sum, segment) => sum + segment.frameCount, 0);

  return {
    fps,
    width,
    height,
    crossfade,
    segments: resolved,
    offsets,
    totalSeconds,
    totalFrames,
  };
}

/** Validate a plan against the trailer acceptance window (20–30 s, 24 fps, 1080p). */
export function validateTrailerPlan(plan, { minSeconds = 20, maxSeconds = 30, requireWidth = 1920, requireHeight = 1080 } = {}) {
  const problems = [];
  if (plan.totalSeconds < minSeconds || plan.totalSeconds > maxSeconds) {
    problems.push(`duration ${plan.totalSeconds}s is outside ${minSeconds}–${maxSeconds}s`);
  }
  if (Math.abs(plan.fps - 24) > 1e-9) problems.push(`fps is ${plan.fps}, acceptance requires 24`);
  if (requireWidth !== null && plan.width !== requireWidth) problems.push(`width is ${plan.width}, expected ${requireWidth}`);
  if (requireHeight !== null && plan.height !== requireHeight) problems.push(`height is ${plan.height}, expected ${requireHeight}`);
  for (const segment of plan.segments) {
    if (segment.frames.length !== segment.frameCount) problems.push(`segment ${segment.index} frame count mismatch`);
  }
  return { ok: problems.length === 0, problems, duration: plan.totalSeconds };
}

/** ffmpeg filter chain that joins the encoded segments with xfade dissolves. */
export function buildXfadeFilter(plan, { transition = 'fade' } = {}) {
  if (plan.segments.length === 1) return null;
  const parts = [];
  let current = '[0:v]';
  for (let index = 1; index < plan.segments.length; index++) {
    const offset = plan.offsets[index - 1];
    const output = index === plan.segments.length - 1 ? '[v]' : `[x${index}]`;
    parts.push(
      `${current}[${index}:v]xfade=transition=${transition}:duration=${plan.crossfade.toFixed(3)}:offset=${offset.toFixed(3)}${output}`,
    );
    current = output;
  }
  return parts.join(';');
}

/** The frame filename used on disk; kept here so tests pin the format. */
export const frameName = (index, extension = 'png') => `frame_${String(index).padStart(5, '0')}.${extension}`;
