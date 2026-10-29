import { getShot, SHOTS } from '../world/layout';
import { isQualityName, type QualityName } from './quality';

export interface AppSettings {
  quality: QualityName;
  /** Shot id, or null for the cinematic camera. */
  shotId: string | null;
  /** Fixed scene time in seconds, or null for wall-clock playback. */
  fixedTime: number | null;
  /** Capture mode disables intro fades, adaptive resolution and input. */
  capture: boolean;
  showHud: boolean;
  letterbox: boolean;
  /** Start directly in free-look. */
  freeLook: boolean;
  seed: number;
  renderScaleOverride: number | null;
  debug: boolean;
}

const readNumber = (params: URLSearchParams, key: string): number | null => {
  const raw = params.get(key);
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
};

const readBoolean = (params: URLSearchParams, key: string, fallback: boolean): boolean => {
  const raw = params.get(key);
  if (raw === null) return fallback;
  return raw !== '0' && raw !== 'false' && raw !== 'off';
};

export function readSettings(location: Location = window.location): AppSettings {
  const params = new URLSearchParams(location.search);
  const shotParam = params.get('shot');
  const shotId = shotParam ? (getShot(shotParam)?.id ?? null) : null;
  const qualityParam = params.get('quality');
  const fixed = readNumber(params, 't');
  const capture = readBoolean(params, 'capture', false);

  return {
    quality: isQualityName(qualityParam) ? qualityParam : 'ultra',
    shotId,
    fixedTime: fixed,
    capture,
    showHud: readBoolean(params, 'hud', !capture),
    letterbox: readBoolean(params, 'letterbox', false),
    freeLook: readBoolean(params, 'free', false),
    seed: readNumber(params, 'seed') ?? 20261029,
    renderScaleOverride: readNumber(params, 'scale'),
    debug: readBoolean(params, 'debug', false),
  };
}

export const SHOT_COUNT = SHOTS.length;
