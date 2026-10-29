export type QualityName = 'low' | 'medium' | 'high' | 'ultra';

export interface QualityPreset {
  name: QualityName;
  label: string;
  /** Multiplier applied to the CSS canvas resolution. */
  renderScale: number;
  maxPixelRatio: number;
  shadowMapSize: number;
  shadowCascades: number;
  reflectionScale: number;
  msaaSamples: number;
  anisotropy: number;
  bloomLevels: number;
  waterSegments: number;
  materialDetail: number;
}

export const QUALITY: Record<QualityName, QualityPreset> = {
  low: {
    name: 'low',
    label: 'Low',
    renderScale: 0.6,
    maxPixelRatio: 1,
    shadowMapSize: 1024,
    shadowCascades: 1,
    reflectionScale: 0.3,
    msaaSamples: 0,
    anisotropy: 4,
    bloomLevels: 4,
    waterSegments: 1,
    materialDetail: 0.55,
  },
  medium: {
    name: 'medium',
    label: 'Medium',
    renderScale: 0.8,
    maxPixelRatio: 1,
    shadowMapSize: 2048,
    shadowCascades: 1,
    reflectionScale: 0.45,
    msaaSamples: 2,
    anisotropy: 8,
    bloomLevels: 5,
    waterSegments: 1,
    materialDetail: 0.75,
  },
  high: {
    name: 'high',
    label: 'High',
    renderScale: 1,
    maxPixelRatio: 1.5,
    shadowMapSize: 2048,
    shadowCascades: 1,
    reflectionScale: 0.6,
    msaaSamples: 4,
    anisotropy: 16,
    bloomLevels: 6,
    waterSegments: 1,
    materialDetail: 0.9,
  },
  ultra: {
    name: 'ultra',
    label: 'Ultra',
    renderScale: 1,
    maxPixelRatio: 2,
    shadowMapSize: 4096,
    shadowCascades: 1,
    reflectionScale: 0.8,
    msaaSamples: 4,
    anisotropy: 16,
    bloomLevels: 6,
    waterSegments: 1,
    materialDetail: 1,
  },
};

export const isQualityName = (value: string | null): value is QualityName =>
  value === 'low' || value === 'medium' || value === 'high' || value === 'ultra';
