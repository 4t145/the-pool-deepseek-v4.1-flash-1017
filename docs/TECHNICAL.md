# Technical Contract

## Stack

- TypeScript 5.9, Vite 8, three.js r186, WebGL2.
- No external assets. All geometry and textures are generated at runtime.
- One scene, one camera, one continuous space.

## Frame pipeline

```
props/cinematics update
  -> water.renderReflection()      // mirror camera, oblique clip, half-res HDR RT
  -> post.render()
       scene -> HDR MSAA target
       bright -> half-res bloom pyramid -> additive upsample
       ACES + grade + grain + vignette + optional 2.39 letterbox -> canvas
```

The scene is rendered with `NoToneMapping` into a HalfFloat target. The final
pass owns the display transform; do not apply a second gamma or tone map.

## Modules

| File | Responsibility |
| --- | --- |
| `src/app/App.ts` | boot, render loop, resize, quality, capture API, UI |
| `src/app/cinematics.ts` | shots, guided path, free look, camera transitions |
| `src/app/cameraPath.ts` | closed-loop cinematic path: cyclic Hermite position + yaw/pitch orientation sampling |
| `src/world/layout.ts` | authoritative dimensions, anchors, shots, cinematic keys |
| `src/world/textures.ts` | tile/water/noise/sign texture generation |
| `src/world/materials.ts` | shared material library |
| `src/world/architecture.ts` | static fabric: shell, skylight, windows, columns, arch screen, stairs |
| `src/world/props.ts` | flume, rings, ladders, railings |
| `src/world/lighting.ts` | sun, area lights, fog, environment bake, shadow freeze |
| `src/world/water.ts` | water shader, planar reflection, resize |
| `src/render/PostPipeline.ts` | HDR target, bloom, composite, exposure/letterbox |
| `scripts/shot.mjs` | deterministic still capture |

### Stable contracts

- `LAYOUT` is the coordinate system. If a dimension changes, every consumer must
  change with it; prefer adding anchors to moving them.
- The `window.__pool` API is used by capture scripts: `renderAt(t)`, `setShot`,
  `setCinematic`, `setPaused`, `setLetterbox`, `setHud`, `setExposure`,
  `setBloom`, `getStats`, `camera`, `scene`, `renderer`.
- All time-driven animation must use the scene clock passed to `update`, not
  `Date.now`, so `renderAt(t)` is deterministic.
- The camera is never moved outside `Cinematics` except by debug tooling.
- `buildX()` functions attach to the scene and return an interface with `update`
  where needed. Do not add global singletons.

## Coordinates

+X right when looking **toward −Z**; the hall runs along Z, camera normally looks
toward +Z (the far arch at z = +29). When facing +Z, screen-left is +X. This
matters for shot composition and the flume side.

- water surface `y = 0`
- deck `y = 0.35`
- basin floor `y = -3.2`
- ceiling `y = 8.6`
- water `x ∈ [-7.2, 7.2]`, `z ∈ [-27.5, 27.5]`
- camera shots are inside the hall; see `SHOTS` in `layout.ts`.

## Props

`src/world/props.ts` builds one static `Group`; `src/world/propLayout.ts` owns the
pure maths (corkscrew sampling, ring float pose, railing spans) so it can be
tested without WebGL (`tests/props.test.ts`).

- `LAYOUT.slide` is the flume contract: `tower` (the tiled column the helix wraps,
  x/z), `platformY`, `topY`, `helixRadius`, `tubeRadius`, and the mouth anchor
  `end` (centre), `mouthRadius`, `mouthDirection` (unit axis out of the opening)
  and `waterlineY`. Water/foam and capture tools should read these instead of
  hard-coded points; `materials.redPlastic` is **not** used by the flume (two
  clones with their own shader hooks are).
- The flume is a corkscrew of open `TubeGeometry` (FrontSide) plus a slightly
  smaller BackSide liner whose UV.x drives a throat-darkening gradient, so the
  mouth is genuinely hollow. World-space stain/tide/scale/streak shading and a
  tileable orange-peel normal are injected with `onBeforeCompile` on the clones;
  `PropsSystem.causticTargets` exposes exactly those two materials for the water
  caustics pass.
- Rings are flattened toruses with printed vinyl textures, moulded seam tori and
  valve hardware; the float pose is `ringFloatPose` (deterministic, ±11 mm bob,
  waterline cuts the tube). Railings are split into spans with a bay at every
  ladder (`railingSpans`) and the ladder handrails fill the bay, so nothing
  intersects and every post lands on the deck.
- Chrome hardware (rails, ladders, struts, collars, clamps, bolts, platform rail)
  is merged into one mesh and the ring seams/valves merge per ring: the props
  pass costs one draw call per material group instead of ~160.

## Camera

`SHOTS` in `layout.ts` is the framing contract for the seven stills. The guided
take is a closed cycle through those seven poses plus a return key. It is
sampled by `createClosedCameraPath` (`src/app/cameraPath.ts`): cubic Hermite in
time; yaw/pitch orientation rather than an interpolated look-at point (so the
wrap takes the short way round and a target cannot swing through the eye);
monotone tangents at direction reversals to prevent overshoot into walls. The
loop is C1-continuous in position and orientation; `tests/camera.test.ts`
asserts the seam, the translation/pan rate caps, the flume clearance and that
every composition pose is visited exactly. `CINEMATIC_DURATION` is 56 s and the
whole path is driven by the scene clock, so `renderAt(t)` stays deterministic.

## Water

Current baseline: half-res planar reflection with oblique clipping, two scrolling
normal maps, Fresnel mix, sun specular, edge foam, fog. Transparent, no depth
write.

Target: real refraction/absorption of the underwater scene (scene color + depth),
depth-aware soft intersection, contact foam and ring wakes, caustics on submerged
surfaces, micro-roughness widening reflection blur with distance. Keep the
reflection camera mathematically correct when the main camera rolls (cinematic
roll is small but present).

## Lighting / bake

Current baseline: overcast sun with 4K shadows, skylight and window RectAreaLights,
weak fluorescent points, warm corridor point, a one-off IBL bake from the real
room via CubeCamera + PMREM, exponential fog, static shadow freeze after the
first frames.

Target: believable indirect bounce and contact darkening. Options in order of
preference:

1. A real static bake into lightmaps / irradiance probes for the architecture,
   shipped as generated data in the repo or generated at load with a cache.
2. A hybrid: baked AO / indirect on static meshes + screen-space contact shadows
   + analytic area lights.
3. Screen-space GI only, if it genuinely removes the flat black ceiling.

Whatever is claimed must be reproducibly generated and committed or regenerable
from committed code. “Baked” means the image carries static visibility/indirect
information that would otherwise cost per-frame rays.

## Performance

Target hardware: RTX 3060, Chrome, 1920×1080, ultra.

- 45–60 fps in shot mode at 1080p; no single frame over 33 ms after warm-up.
- draw calls < 700, triangles < 500k.
- Reflection RT at 0.6–0.8 scale; bloom half-res; shadows frozen after warm-up.
- All heavy generation happens before `__POOL_READY__`.
- A quality preset must still boot at 1280×720 on low.

## Capture / determinism

`pnpm shot -- --shot=... --time=...` starts a Vite dev server, launches headed
off-screen Chrome (hardware WebGL on `DISPLAY=:0`), waits for `__POOL_READY__`,
removes loader/HUD, calls `renderAt(t)`, waits two rAFs, screenshots.

Do not add non-deterministic ambient animation that ignores `time`. Do not rely
on `Math.random`. Use `Rng` from `core/rng.ts` with explicit seeds.

## Browser caveat

Headless Chrome on this host falls back to SwiftShader. Headed Chrome under
`DISPLAY=:0` gets the NVIDIA GL driver. `scripts/chrome-env.sh` supplies the NixOS
shared library path and the Playwright Chrome binary. Keep capture scripts
portable via `CHROME_BIN`.

## Known baseline limitations

- Tile texture repeats every 1 m and its broad stains are not seamless; POM is
  not wired yet; grout/normal contrast is too strong at distance.
- Water is mostly mirror + tint; no refraction, no caustics, no ring wakes.
- Ceiling/upper walls read as flat dark because the room has no baked bounce.
- Skylight/window emissives are too hot; bloom threshold needs a re-tune after
  materials settle.
- Flume curve and mouth are placeholders; the tower/wake/waterline staining need
  design work.
- Rings sit too low and read as lines at distance.
- The far arch/corridor is a single warm card, not a convincing depth.
- No TAA; MSAA 4x only. Thin rails shimmer during camera moves.
- `PostPipeline` is a custom chain; no DOF, motion blur or lens dirt yet.

## Verification

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

A browser smoke capture is expected as evidence from the finished branch:
`pnpm shot -- --shot=arrival --width=1280 --height=720 --time=2`.
