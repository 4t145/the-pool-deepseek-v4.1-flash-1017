import type { Material } from 'three';
import { addShaderHook } from '../core/shaderHooks';
import { TILE } from '../core/tileMath';
import type { TileTextureSet } from './textures';

/**
 * Production tile shading for the building fabric.
 *
 * The texture set covers exactly one 125 mm tile. Everything that would repeat
 * if it were baked into that tile — per-tile colour, tilt, chipped corners — is
 * derived in the fragment shader from the tile's integer world coordinates,
 * and everything larger than a tile (drip staining, blotching, algae) is a
 * seamless world-space grime field. The result has no visible texture repeat at
 * any distance while still being one small, cheap texture set.
 *
 * The shader also does real parallax occlusion mapping on the grout/chamfer
 * height field in tangent-like world space, so grout has depth at grazing
 * angles, and it fades the bevel and the procedural variation by screen-space
 * footprint so 4K far walls do not moire.
 *
 * This patches a MeshStandardMaterial/MeshPhysicalMaterial through the shared
 * `addShaderHook` chain, so the lighting bake (probe) and water caustics hooks
 * can coexist on the same material.
 */
export interface TileShadingOptions {
  /** Submerged surfaces: greener, wider algae, no dry drip band. */
  underwater?: boolean;
  /** World y of the water surface, for the algae band. */
  waterlineY?: number;
  /** Multiplier on the drip/blotch grime field, 0..1.5. */
  grime?: number;
  /** Algae band strength at the waterline, 0..1.5. */
  algae?: number;
  /** Vertical width of the algae band, metres. */
  algaeWidth?: number;
  /** Per-tile colour variation, ±fraction (0.09 = ±4.5 %). */
  tintAmount?: number;
  /** Per-tile normal tilt, tangent units. */
  tiltAmount?: number;
  /** Fraction of tiles with a chipped corner. */
  chipRate?: number;
  /** Parallax occlusion on/off (quality tier). */
  parallax?: boolean;
  /** Metres covered by one repeat of the grime field. */
  grimeScale?: number;
}

const FRAGMENT_PRELUDE = /* glsl */ `
vec3 tileNormalW = normalize(vTileNormal);
vec3 tileAbsN = abs(tileNormalW);
vec2 tileWorldUv;
vec3 tileAxisT;
vec3 tileAxisB;
if (tileAbsN.x >= tileAbsN.y && tileAbsN.x >= tileAbsN.z) {
  tileWorldUv = vec2(vTileWorld.z, vTileWorld.y);
  tileAxisT = vec3(0.0, 0.0, 1.0);
  tileAxisB = vec3(0.0, 1.0, 0.0);
} else if (tileAbsN.y >= tileAbsN.z) {
  tileWorldUv = vec2(vTileWorld.x, vTileWorld.z);
  tileAxisT = vec3(1.0, 0.0, 0.0);
  tileAxisB = vec3(0.0, 0.0, 1.0);
} else {
  tileWorldUv = vec2(vTileWorld.x, vTileWorld.y);
  tileAxisT = vec3(1.0, 0.0, 0.0);
  tileAxisB = vec3(0.0, 1.0, 0.0);
}

vec2 tileUv = tileWorldUv * uTileTilesPerMetre;
vec2 tileCellIndex = floor(tileUv);
vec2 tileLocal = fract(tileUv);

float tileFootprint = max(fwidth(tileUv.x), fwidth(tileUv.y));
float tileDetail = 1.0 - smoothstep(0.18, 0.75, tileFootprint);
float tileVariation = 1.0 - smoothstep(0.45, 1.8, tileFootprint);

float tileH0 = tileHash(tileCellIndex);
float tileH1 = tileHash(tileCellIndex + vec2(19.17, 7.31));
float tileH2 = tileHash(tileCellIndex + vec2(43.77, 91.13));
float tileH3 = tileHash(tileCellIndex + vec2(71.37, 13.91));

float tileTint = 1.0 + (tileH0 - 0.5) * uTileTintAmount * tileVariation;
float tileWarm = (tileH2 - 0.5) * uTileTintAmount * 0.45 * tileVariation;
vec2 tileTilt = (vec2(tileH1, tileH2) - 0.5) * 2.0 * uTileTilt * tileDetail;
vec2 tileChipCorner = step(0.5, vec2(tileH1, tileH2));
float tileChipSelect = step(1.0 - uTileChipRate, tileH3);
float tileChip = tileChipSelect * (1.0 - smoothstep(0.035, 0.105, length(tileLocal - tileChipCorner))) * tileDetail;

// Hand-set irregularity: each tile is set a millimetre or two off, so the
// visible grout joint is not a perfect machine grid.
vec2 tileWarp = (vec2(tileH0, tileH1) - 0.5) * 0.024;
vec2 tileSampleUv = tileUv + tileWarp;

vec3 tileView = normalize(cameraPosition - vTileWorld);
float tileVt = dot(tileView, tileAxisT);
float tileVb = dot(tileView, tileAxisB);
float tileVn = max(abs(dot(tileView, tileNormalW)), 0.12);
vec2 tilePomDir = -vec2(tileVt, tileVb) / tileVn * uTileRelief * tileDetail;
vec2 tileSample = tileSampleUv;

if (uTileParallax > 0.5 && tileDetail > 0.02) {
  float tileStepSize = 1.0 / max(uTileSteps, 4.0);
  for (int tileI = 1; tileI <= 12; tileI++) {
    float tileT = float(tileI) * tileStepSize;
    if (tileT > 1.0) break;
    vec2 tileProbeUv = tileSampleUv + tilePomDir * tileT;
    float tileProbeH = texture2D(uTileHeight, tileProbeUv).r;
    if (tileProbeH <= 1.0 - tileT) {
      tileSample = tileProbeUv;
      break;
    }
  }
}

vec2 tileGrimeUv = tileWorldUv / max(uTileGrimeScale, 0.5);
float tileBlotch = texture2D(uTileGrime, tileGrimeUv * 0.41 + vec2(0.13, 0.71)).r;
float tileStreak = texture2D(uTileGrime, vec2(tileWorldUv.x * 0.55, tileWorldUv.y * 0.045) / max(uTileGrimeScale, 0.5)).r;
float tileDripBand = smoothstep(uTileWaterline + 0.35, uTileWaterline + 1.1, vTileWorld.y)
                   * (1.0 - smoothstep(4.4, 5.7, vTileWorld.y));
float tileGrime = clamp((smoothstep(0.56, 0.82, tileBlotch) * 0.5
                       + smoothstep(0.5, 0.8, tileStreak) * tileDripBand * 0.9) * uTileGrimeAmount, 0.0, 1.0);
float tileAlgaeBand = exp(-pow((vTileWorld.y - uTileWaterline) / max(uTileAlgaeWidth, 0.02), 2.0));
float tileAlgae = clamp(tileAlgaeBand * (0.55 + 0.75 * tileStreak) * uTileAlgae, 0.0, 1.0);

vec3 tileGrimeColor = vec3(0.30, 0.29, 0.255);
vec3 tileAlgaeColor = mix(vec3(0.17, 0.25, 0.19), vec3(0.085, 0.145, 0.115), uTileUnderwater);
`;

const REPLACEMENTS: Array<{ needle: string; replacement: string }> = [
  {
    needle: '#include <map_fragment>',
    replacement: /* glsl */ `
#ifdef USE_MAP
  vec4 sampledDiffuseColor = texture2D( map, tileSample );
  diffuseColor *= sampledDiffuseColor;
  diffuseColor.rgb *= tileTint;
  diffuseColor.rgb *= vec3(1.0 + tileWarm, 1.0, 1.0 - tileWarm);
  diffuseColor.rgb = mix(diffuseColor.rgb, tileGrimeColor, tileGrime * 0.60);
  diffuseColor.rgb = mix(diffuseColor.rgb, tileAlgaeColor, tileAlgae * 0.85);
  diffuseColor.rgb *= 1.0 - tileChip * 0.42;
#endif
`,
  },
  {
    needle: '#include <roughnessmap_fragment>',
    replacement: /* glsl */ `
float roughnessFactor = roughness;
#ifdef USE_ROUGHNESSMAP
  vec4 texelRoughness = texture2D( roughnessMap, tileSample );
  roughnessFactor *= texelRoughness.g;
  // Glaze is never perfectly uniform tile to tile: vary the specular response.
  roughnessFactor *= 0.82 + 0.36 * tileH1;
  roughnessFactor = mix(roughnessFactor, 0.86, tileGrime * 0.70);
  roughnessFactor = mix(roughnessFactor, 0.94, tileAlgae * 0.60);
  roughnessFactor = mix(roughnessFactor, 0.92, tileChip * 0.55);
#endif
`,
  },
  {
    needle: '#include <normal_fragment_maps>',
    replacement: /* glsl */ `
#if defined( USE_NORMALMAP_TANGENTSPACE )
  vec3 mapN = texture2D( normalMap, tileSample ).xyz * 2.0 - 1.0;
  // Fade the micro-normal with screen footprint: sub-pixel bevel and glaze
  // warp alias into specular fireflies on distance walls otherwise.
  mapN.xy *= normalScale * mix( 0.12, 1.0, tileDetail );
  mapN.xy += tileTilt;
  mapN = normalize( mapN );
  normal = normalize( tbn * mapN );
#elif defined( USE_NORMALMAP_OBJECTSPACE )
  normal = texture2D( normalMap, tileSample ).xyz * 2.0 - 1.0;
  #ifdef DOUBLE_SIDED
    normal = normal * faceDirection;
  #endif
  normal = normalize( normalMatrix * normal );
#endif
`,
  },
  {
    needle: '#include <aomap_fragment>',
    replacement: /* glsl */ `
#ifdef USE_AOMAP
  float ambientOcclusion = ( texture2D( aoMap, tileSample ).r - 1.0 ) * aoMapIntensity + 1.0;
  ambientOcclusion *= 1.0 - tileChip * 0.35 - tileAlgae * 0.08;
  reflectedLight.indirectDiffuse *= ambientOcclusion;
  #if defined( USE_CLEARCOAT )
    clearcoatSpecularIndirect *= ambientOcclusion;
  #endif
  #if defined( USE_SHEEN )
    sheenSpecularIndirect *= ambientOcclusion;
  #endif
  #if defined( USE_ENVMAP ) && defined( STANDARD )
    float dotNV = saturate( dot( geometryNormal, geometryViewDir ) );
    reflectedLight.indirectSpecular *= computeSpecularOcclusion( dotNV, ambientOcclusion, material.roughness );
  #endif
#endif
`,
  },
];

const VERTEX_DECLARATIONS = /* glsl */ `
varying vec3 vTileWorld;
varying vec3 vTileNormal;
`;

const FRAGMENT_DECLARATIONS = /* glsl */ `
uniform sampler2D uTileHeight;
uniform sampler2D uTileGrime;
uniform float uTileTilesPerMetre;
uniform float uTileRelief;
uniform float uTileSteps;
uniform float uTileParallax;
uniform float uTileUnderwater;
uniform float uTileWaterline;
uniform float uTileGrimeAmount;
uniform float uTileAlgae;
uniform float uTileAlgaeWidth;
uniform float uTileTintAmount;
uniform float uTileTilt;
uniform float uTileChipRate;
uniform float uTileGrimeScale;
varying vec3 vTileWorld;
varying vec3 vTileNormal;

float tileHash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}
`;

/**
 * Attach the tile shader to an already-configured standard/physical material.
 * The material must have `map`, `normalMap` and `roughnessMap` set to the tile
 * set; `aoMap` is optional. Safe to call once per material.
 */
export function applyTileShading(
  material: Material,
  tiles: TileTextureSet,
  options: TileShadingOptions = {},
): void {
  const underwater = options.underwater ?? false;
  const parallax = options.parallax ?? true;
  const key = `tile:${underwater ? 1 : 0}${parallax ? 1 : 0}`;

  addShaderHook(material, key, (shader) => {
    shader.uniforms.uTileHeight = { value: tiles.height };
    shader.uniforms.uTileGrime = { value: tiles.grime };
    shader.uniforms.uTileTilesPerMetre = { value: 1 / tiles.tileMetres };
    shader.uniforms.uTileRelief = { value: tiles.reliefTileUnits };
    shader.uniforms.uTileSteps = { value: tiles.parallaxSteps };
    shader.uniforms.uTileParallax = { value: parallax ? 1 : 0 };
    shader.uniforms.uTileUnderwater = { value: underwater ? 1 : 0 };
    shader.uniforms.uTileWaterline = { value: options.waterlineY ?? 0 };
    shader.uniforms.uTileGrimeAmount = { value: options.grime ?? 0.6 };
    shader.uniforms.uTileAlgae = { value: options.algae ?? (underwater ? 0.85 : 0.28) };
    shader.uniforms.uTileAlgaeWidth = { value: options.algaeWidth ?? (underwater ? TILE.algaeWidthMetres : 0.16) };
    shader.uniforms.uTileTintAmount = { value: options.tintAmount ?? 0.12 };
    shader.uniforms.uTileTilt = { value: options.tiltAmount ?? 0.09 };
    shader.uniforms.uTileChipRate = { value: options.chipRate ?? 0.05 };
    shader.uniforms.uTileGrimeScale = { value: options.grimeScale ?? 4.0 };

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERTEX_DECLARATIONS}`)
      .replace(
        '#include <project_vertex>',
        /* glsl */ `
vTileWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
vTileNormal = normalize( mat3( modelMatrix ) * objectNormal );
#include <project_vertex>
`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAGMENT_DECLARATIONS}`)
      .replace('#include <map_fragment>', FRAGMENT_PRELUDE + REPLACEMENTS[0]!.replacement);

    for (const entry of REPLACEMENTS.slice(1)) {
      shader.fragmentShader = shader.fragmentShader.replace(entry.needle, entry.replacement);
    }

    // The glaze is the clearcoat layer, so its highlight must follow the
    // tile's rolled edge instead of the perfectly flat geometry normal —
    // otherwise the bevel never catches light and the wall reads as glass.
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <clearcoat_normal_fragment_begin>',
        /* glsl */ `
#ifdef USE_CLEARCOAT
  vec3 clearcoatNormal = normalize( normal );
#endif
`,
      )
      .replace(
        'material.clearcoatRoughness = clearcoatRoughness;',
        'material.clearcoatRoughness = clearcoatRoughness * mix(0.8, 1.3, tileH1);',
      );
  });
}
