# Implementation — THE POOL

This document records how the committed scene is built, why the numbers in the
frames are what they are, and what is still weak. It describes the code at the
head of the run; when a claim needs a number, the number was measured on the
RTX 3060 target with the commands in [§14](#14-capture-and-deliverables-bench).

## 1. What this is

One flooded municipal pool hall, closed for years, rendered in real time in a
browser with WebGL2/three.js r186. A single continuous scene, one camera, one
space. Everything visible is generated procedurally at load time: tile, grime,
water, vinyl prints, signage, geometry, the direct lights, a static indirect
light bake and the camera path. There are no downloaded assets, no runtime
network requests and no second room.

The presentation target is a trailer/PV still: a 3840×2160 frame should look
intentional at 100 %, and a slow camera move should not shimmer or stair-step.
That is why the project spends its budget on materials, water, a real light bake
and a filmic post chain rather than on geometry.

## 2. Scene contract

`src/world/layout.ts` is the single source of truth and the stable contract
between systems.

- Axes: +X right when looking toward **−Z**; the hall runs along Z and cameras
  normally look toward **+Z** (the far arch at z = +29), so screen-left is +X.
- Water surface `y = 0`; deck `y = 0.35`; basin floor `y = -3.2`; ceiling
  `y = 8.6`; water spans `x ∈ [-7.2, 7.2]`, `z ∈ [-27.5, 27.5]`; hall
  `x ∈ [-8.4, 8.4]`, `z ∈ [-29, 29]`.
- Tile UVs are world-space in metres: **1 UV unit = 1 m = 8 tiles**, applied by
  `applyWorldUVs`, so the tiling continues across every mesh in the building.
- `SHOTS` (seven camera poses) and `CINEMATIC_KEYS` (the guided take) live here
  too; `LAYOUT` dimensions are not moved by the camera or prop lanes.
- `window.__pool` is the capture contract: `renderAt(t)`, `setShot`,
  `setCinematic`, `setPaused`, `setLetterbox`, `setHud`, `setExposure`,
  `setBloom`, `getStats`, plus `camera`, `scene`, `renderer`, `time()`.
  `window.__POOL_READY__` flips only after the bake and two warm frames.

All animation is a function of the scene clock (`renderAt(t)` / `setCinematic(t)`),
never of the wall clock, and no visual system calls `Math.random`; procedural
systems use the seeded `Rng`/`hash2` in `src/core/rng.ts`.

## 3. Boot sequence

`App.init()` builds the scene in dependency order, yielding to the browser
between stages so the loader can paint:

1. **Renderer** — WebGL2, `NoToneMapping`, sRGB output, PCF shadows (the App
   requests `PCFSoftShadowMap`, but three r186 removed that implementation and
   falls back to PCF; the penumbra comes from `sun.shadow.radius`),
   `preserveDrawingBuffer` for capture. Antialiasing is done in the HDR target,
   not the default framebuffer.
2. **Tile set** — `createTileTextures` generates the 125 mm ceramic set
   (albedo, normal, roughness, height, AO, grime) at 2048² (1024² below
   `materialDetail ≥ 0.9`). `tiles: 8`, `worldSize: 1` → 125 mm per tile.
3. **Signage + materials** — enamel signs (`createSignTexture`), the shared PBR
   library, and the glazed-tile shader hooks (`applyTileShading`).
4. **Underwater caustics** — the procedural caustic patcher is created and
   applied to the basin/stair/flume materials before geometry is built, so the
   same lighting, refraction prepass and planar reflection all see it.
5. **Architecture** — shell, skylight well and aperture, frosted windows,
   columns, transverse arch screen, warm service corridor, far stairs,
   fluorescent fixtures, notices; then the room-detail pass (coping grate, deck
   joints, lane markings, bulkhead lamps, ceiling services, grilles, hatch,
   waterline band).
6. **Props** — the corkscrew flume (tiled column, platform, funnel, closed PVC
   helix, hollow liner/lip, chrome A-frames), three printed vinyl rings, merged
   ladders and guardrails. Exposes `causticTargets` for the flume material.
7. **Caustics wiring** — after props exist, the two flume materials are added to
   the caustic patcher.
8. **Lighting** — sun + area lights + fluorescent points + warm corridor light,
   then two bakes before the water exists:
   - **IBL bake**: a `CubeCamera` captures the real lit room into a PMREM
     environment (specular response for chrome/water/wet tile);
   - **probe-grid bake**: a BVH of the built room is ray traced into a 3D
     irradiance probe volume (nine SH coefficients; occlusion is implicit in
     the radiance field plus the 0.3 m contact accent — there is no separate AO
     channel). See §8.
   Then the volumetric shaft cards + dust cloud are built. Shadows freeze after
   frame 3.
9. **Water** — reflection and refraction render targets, water normals and the
   water material signed into the scene at `y = 0`.
10. **Camera + post** — `Cinematics` (closed-loop camera path) and the
    `PostPipeline` (HDR target, emissive mask, bloom pyramid, display
    transform).
11. `renderer.compile`, two full frames (shadow map + reflection settle), then
    `__POOL_READY__ = true` and the UI is handed over.

Any bake failure degrades gracefully (IBL-only lighting) and logs a warning
instead of blocking the scene.

## 4. Frame pipeline

```
Cinematics.update(dt, t)                  // shots / closed-loop take / free look
Props.update(t)                           // ring float pose (deterministic bob)
Lighting.update(t)                        // failing-tube flicker, dust drift
Caustics.update(t)                        // one shared time uniform
Water.update(t, camera)                   // normals, wakes, absorption constants
Water.renderRefraction(scene, camera)     // opaque scene without water -> half-res HDR
Water.renderReflection(scene, camera)     // mirrored camera + oblique clip -> HDR
renderer.info.reset()
PostPipeline.render(scene, camera, t)
   scene -> half-float MSAA HDR target
   emissive-mask pass (layer 1) -> half-res mask -> bright pass -> bloom pyramid
   final composite (ACES/AgX, sRGB, grade, vignette, CA, grain, dither, letterbox)
   -> canvas
```

The scene renders with `NoToneMapping` into a linear HDR target; the final pass
owns the only display transform and the only sRGB encode. The water reflection is
a real mirror camera with an oblique near plane (mathematically correct under
roll); it is disabled while rendering itself and re-enabled immediately after.

## 5. Static fabric

`src/world/architecture.ts` builds the building fabric in world space with
planar world UVs so the 125 mm tile grid runs continuously across walls, floor,
copings, columns, stairs and the arch screen. Highlights:

- Long skylight slot with a deep well and frosted bay panels; nine pairs of
  frosted windows with frames, mullions, transoms and sills.
- Ten columns per side, a transverse three-arch screen at `z = 18.4`, a far
  wall with the warm arch (z = 29) and a tiled service corridor behind it, far
  stairs descending into the water, fluorescent fixtures, and enamel notices.
- **Room-detail pass (`architectureDetail.ts` + pure `roomDetailLayout.ts`)**:
  coping overflow slot with a 0.12 m-pitch brushed-steel grate and dark recess
  plate, deck control joints on the column rhythm, painted lane markings on the
  basin floor and underwater end walls, dark-teal waterline tile band with a
  mottled algae strip, caged bulkhead lamps on every window pier (three still lit
  per side), twin galvanised ceiling pipe runs split around the arch screen with
  hangers between ribs and sprinkler drops, wall conduit, high-level ventilation
  grilles, a recessed ceiling access hatch and four worn enamel notices. All
  merged per material: **15 draw meshes** for the whole pass; placement lives as
  pure data with nine unit tests (no window/column collisions, services avoid the
  arch screen, lane lines inside the water).
- Mesh count is kept low by merging static detail; nothing in this layer moves,
  so it is valid probe-bake geometry.

## 6. Tile — glazed ceramic

`src/core/tileMath.ts`, `src/world/textures.ts`, `src/world/tileMaterial.ts`.

Physical constants (single source, mirrored in the shader and the texture
generator):

| Property | Value |
| --- | --- |
| Tile pitch | 125 mm |
| Grout joint | 3 mm |
| Chamfer | 1.5 mm |
| Glaze roll | 6.5 mm |
| Glaze relief | 2.2 mm |
| Algae band | 0.3 m default, tuned 0.18–0.45 m per surface |

- The texture set is generated at runtime for a single 125 mm tile (albedo,
  normal, roughness, AO and the POM height field); the shader tiles them with
  `world UV × 8` (1 UV unit = 1 m = 8 tiles), and per-tile variation is
  procedural because the maps themselves only contain the profile of one tile.
  All five maps are produced together so the bevel/highlight line and the height
  field agree.
- The tile shader (`applyTileShading`) is registered on every ceramic material
  through the shared shader-hook chain. It does **parallax occlusion mapping**
  on the grout/chamfer height field (12 raymarch steps at 2048², 8 at 1024²),
  derives **per-tile colour/tilt and rare chipped corners from the integer world
  tile coordinates** so they are not repeated by the texture, and samples a
  seamless low-frequency **grime field** in world metres for drip staining,
  blotching and the algae/waterline band (greener and wider on submerged
  surfaces, dry drip bands above the waterline).
- Details fade by screen-space footprint at distance, so a 4K far wall does not
  moire; the clearcoat highlight follows the rolled glaze normal instead of the
  flat geometry normal.
- **Specular antialiasing** (owner rev-1 correction): bevel/chip detail fades
  past ~0.02–0.12 tile/pixel, the per-tile tilt fades with camera distance and is
  gone past 14 m (at range it fragmented a window reflection into isolated
  tile-sized glints), a distance specular-roughness floor widens the base and
  clearcoat lobes (0.05→0.30 and 0.065→0.28 between 5 m and 26 m), and per-tile
  clearcoat variation fades past 16 m. POM is additionally gated on grazing
  incidence (`smoothstep(0.16, 0.42, N·V)`) because at a few degrees the ray-march
  hit can jump between pixels and break a sub-pixel grout line into dashes. The
  lane band above the water uses the same glazed tile shader (own waterline at
  y = 0.13) instead of a flat painted stripe.

## 7. Water

`src/world/water.ts` + the CPU reference in `src/core/waterOptics.ts`.

- **Planar reflection**: a mirror camera with an oblique near plane renders the
  room (without water) into a half-float target at
  `quality.reflectionScale × drawing buffer` (0.8× at ultra). The surface
  samples it projectively with a nine-tap cross whose radius grows with camera
  distance (micro-roughness) and whose floor is 0.95 texels of the reflection
  target, so thin geometry cannot alias into dashed highlights; the kernel is
  temporally stable (no jitter) and the mirror is slightly soft far away.
  Fresnel blends body and reflection at 0.62 strength, and the reflection is
  pulled 26 % toward the deep body colour so a still pool does not read as a
  perfect dielectric mirror.
- **Body colour**: Beer–Lambert absorption is (1.7, 0.9, 1.0) m⁻¹ with a dark
  in-scatter term, which is what makes the deep water read green-black while the
  white room and skylight still mirror at grazing angles; the basin floor is
  only faintly visible near the shallow edges.
- **Refraction**: a second opaque-scene copy (without water) is drawn at
  `max(0.3, 0.85 × reflectionScale)` with a **wider-FOV camera** (1.9× the main
  FOV, clamped to 118°) and a **global clip plane at y = 0.004**, so Snell-bent
  near-field rays that leave the main frustum still have geometry and
  above-water props cannot leak in as bright silhouettes. The water shader
  refracts the view ray through the surface normal (η = 1/1.333), intersects the
  basin AABB analytically for the hit point and path length (no depth texture, so
  no depth-edge stair-stepping through ripples), projects the hit with the wide
  camera's view-projection, and applies **Beer–Lambert transmittance**
  `exp(-σ · path)` plus an in-scatter colour before mixing with the reflection.
  Snell's law, Schlick Fresnel, the basin-exit solve, transmittance and the wake
  functions are the CPU reference in `waterOptics.ts`, unit-tested.
- **Surface**: three scrolling normal layers at different scales and speeds plus
  analytic wakes from the three rings and the flume mouth (centres from
  `LAYOUT`, wake slope is the analytic derivative of the height profile in
  `waterOptics`). Amplitude is deliberately low; the pool is nearly still.
- **Foam**: a thin coping/scum band from the basin-edge distance, contact rings
  around the floating rings and the flume mouth, and a few drifting flecks; noise
  driven, never pure white.
- **Caustics**: an analytic three-wave lattice evaluated in world space from the
  scene clock (no texture/repeat), mirrored by `causticLattice` in
  `waterOptics.ts`. It is patched into the submerged materials (basin tile, the
  submerged stairs/coping, the lane band, the flume PVC and liner) through the
  shared shader-hook chain and fades with depth and around `y ≈ 0`, so dry
  surfaces never receive it; the water shader also re-adds the sharp full-res
  caustic lines inside the absorbed water column (0.22 strength, depth-masked
  from full at ≤0.8 m path to 0.12 at 3.2 m). Material caustic strengths are
  0.55 / 0.35 / 0.30 / 0.25 / 0.20 on the basin, stairs/coping, lane band,
  flume PVC and liner, so the web is a faint feature rather than an all-over
  tropical lattice.
- The water surface writes no depth and is drawn opaque after the opaque scene;
  the reflection and refraction sources are rendered with the water mesh hidden
  and the fog/grade are applied once in the water shader and the final pass.

## 8. Lighting and the static bake

`src/world/lighting.ts`, `src/world/lightBake.ts`, `src/core/bakeMath.ts`,
`src/world/volumetrics.ts`, `src/world/lightTextures.ts`.

**Direct**: an oblique overcast sun (4096² map at ultra, 2048 at lower tiers; PCF
filtering with `sun.shadow.radius = 8` for the penumbra, bias -0.0006 and
normalBias 0.035, frozen after warm-up), a low skylight `RectAreaLight` (0.70)
and eight weak window area
lights (0.30, four per side) kept low because their specular sheen is all that
is wanted after the bake, six fluorescent point lights (the far one flickers
deterministically from the scene clock), a residual hemisphere fill at 0.10 and
a warm corridor lamp inside the 8.4 m corridor. The frost and dirt modulation
maps on the window and skylight panes keep their clipped highlights structured;
each pane carries `userData.emissiveMean`, the mean of its modulation map, so
the bake uses the pane's real mean radiance rather than its peak. Fog is
exponential (`0x46575a`, density 0.0105) — darker and cooler than the first
pass so the warm arch separates from the cold room.

**IBL**: before water exists, a `CubeCamera` (256² at ultra) captures the real
room and is PMREM-filtered into `scene.environment`. It supplies specular and a
small residual diffuse. One gotcha is recorded because it silently changed the
look: **three r186 overrides `material.envMapIntensity` from
`scene.environmentIntensity` whenever `material.envMap` is null and
`scene.environment` is set** (`WebGLRenderer.setProgram` re-uploads the uniform
on every refresh). The lighting pass therefore pins `scene.environment` onto
every standard/physical material before setting the intensity explicitly: a
base of 0.68 times a class factor — metals 1.0 (0.68), clearcoat dielectrics 0.8
(0.544), matte dielectrics 0.42 (0.286). Without the pin the attenuation is a
no-op and IBL diffuse double-counts with the probe grid (caught in-page: every
material gets `envMap` and the effective intensity set is exactly these three
values; the A/B is ~3 % darker mean display with shadowed walls
losing most of their flat IBL fill).

**Probe-grid bake** (`src/world/lightBake.ts`, `src/core/bakeMath.ts`) — a real,
regenerable static bake with no per-frame rays:

1. Every opaque mesh in the built scene (367 merged meshes, ~97k triangles at
   bake time: architecture, room detail and props) is merged into one non-indexed
   world-space mesh carrying per-triangle albedo, emission and emitter kind,
   with a `three-mesh-bvh` BVH.
2. A probe grid covers the hall (`x ∈ [-8.4, 8.4]`, `y ∈ [0.2, 8.5]`,
   `z ∈ [-29, 29]`): 18×9×36 probes at ultra (15×8×30 at low). Each probe
   shoots 48 stratified Hammersley directions (35 at low), rotated by a
   deterministic per-probe hash. Hits on emissive panes (skylight, frosted
   windows, bulkhead lamps, corridor glow) accumulate radiance into nine SH
   coefficients; surface hits record albedo, sun-shadow visibility and
   fluorescent direct light.
3. Two Jacobi bounce passes (three at high/ultra) propagate radiance between
   probes using the recorded hits, giving indirect bounce and implicit corner
   occlusion without new rays. A 0.3 m contact accent (40 % at ultra) adds
   near-surface darkening.
4. The nine SH coefficients per probe are packed into the 7-slice RGBA16F
   `Data3DTexture` atlas that three.js' built-in light-probe-grid shader samples;
   adding the probe volume to the scene gives every standard/physical material
   the baked indirect diffuse with **no material patching**, so it cannot clash
   with the tile POM, caustics or prop hooks. L2 SH cannot represent sharp
   indirect detail, and three bounces truncate the interreflection tail, which is
   why the far corners settle around 0.02 irradiance rather than going black.
5. Determinism: no `Math.random`, no wall clock; Hammersley directions plus a
   per-probe hash make two bakes produce identical coefficients. Cost at ultra
   on the final geometry: 5832 probes, 279,936 primary + 122,581 shadow rays,
   96.7k triangles / 367 merged meshes, ~1.1 s at load, zero per-frame cost;
   the low tier bakes 3600 probes, 126,000 + 53,769 rays, two bounces, ~0.56 s.

**Volumetrics**: two draw calls total — merged additive shaft cards seated under
the skylight and tilted to the actual sun ray (`atan2(12.5, 27)`), two warm haze
layers in the corridor behind the arch, plus 760 dust motes animated in-shader
from the scene clock. The cards depth-test against the opaque scene, fade when
seen edge-on and never write depth; there is no per-frame CPU cost.

One defect found during acceptance is worth recording: the shaft shader
originally evaluated `pow(vUv.y, 0.8)` on a border-interpolated UV that can sit
an ulp outside [0,1], which is NaN in GLSL. A NaN radiance in an additive blend
lands as black after the display transform, producing the hard 1 px dashed/solid
strokes that crossed wall, coping and water at once. It was fixed by clamping
every `pow` base and the final radiance, guarding the edge-on `normalize` with a
divided vector and clamping the dust point size (internal reference `0eb3036b`,
volumetrics only, shafts and dust intensity unchanged). This is separate from
the water reflection kernel cleanup (9 taps, blur 0.95–2.1, `uTexel` from the
half-scale reflection target), which removed a reflection-side dash class.

## 9. Props

`src/world/props.ts` + pure `propLayout.ts`.

- **Flume**: a tiled column and red boarding platform rise out of the basin; a
  closed corkscrew PVC helix wraps it and dives to a half-submerged mouth aimed
  at the arrival camera. The mouth is a real open end: outer PVC surface plus a
  darker inner liner (back-side) that fades to black over ~0.7 m so the throat
  reads hollow, with a rolled lip and rim. The PVC material carries a
  world-space waterline stain shader (wet band, tide mark, run-off streaks,
  algae and a mineral scale line) and a tileable orange-peel normal; the two
  flume materials are exposed as `causticTargets` so the caustic patcher can
  reach them. The tower rises from the basin floor with a red boarding platform,
  funnel and guard rail; welded chrome collars, struts and clamps are merged
  into the single chrome batch. The flume shot is reframed to include the whole
  hero structure (mouth through platform crown); the arrival shot still crops
  the crown by design. Merging the props chrome took the props system from ~159
  to ~15 draw calls.
- **Rings**: inflated vinyl torus flattened 0.58, thicker than the baseline.
  The mould seam is printed into the vinyl texture (a soft dark band at the
  torus UV seam and a faint line at the inner equator); the 5 mm geometric seam
  tori were removed after the owner rev-1 pass because they aliased into a dark
  dotted line on the rims at 1080p. Valve hardware and cap are separate merged
  geometry. The print is a generated vinyl texture (printed bands, scuffs, seam
  darkening), not a separate plastic material band. Each ring has a
  deterministic float pose (bob, yaw, tilt) and sits so the waterline cuts the
  tube; reflections come from the water system.
- **Ladders/rails**: railing spans are cadenced around the ladder bays and
  terminate on the deck with flanges; ladder rails enter the water and stop ~1 m
  below, grab handles rise over the coping and land on deck flange plates. All
  chrome is merged per system into a small number of draw calls.

## 10. Camera and cinematics

`src/app/cinematics.ts`, `src/app/cameraPath.ts`, `src/world/layout.ts`.

- Seven `SHOTS` (arrival, flume, ring, arch, skylight, tile, float) reframed to
  the art-direction intent: low over the water, flume as a three-quarter mass
  with its mouth toward camera and the whole hero structure (mouth, tower base,
  platform, funnel crown) inside frame, ring at the surface with its full outer
  rim inside the central frame, arch in perspective with the blue ring in the
  middle ground, ascension low with water in the bottom third, a 34° 3/4 wall
  study where white glaze + grout fill the top half and the wainscot, waterline
  band, coping and dark water carry the bottom third, and a high float over the
  basin.
- The guided take is a **closed C1 camera loop**: keys are the seven shot poses
  plus one high return key; `cameraPath.ts` evaluates a cyclic cubic Hermite
  curve through them, with orientation interpolated as yaw/pitch (so the wrap
  takes the short way and cannot swing through the eye) and monotone tangents
  that flatten at reversals. Measured loop seam: position 4.9e-7 m, velocity
  1.9e-6 m/s; max translation 1.87 m/s, max pan 14.24°/s, minimum flume
  clearance 1.06 m, return key at 53 s. The beats are arrival 0 s, flume 5 s,
  ring 18 s, arch 24 s, tile 32.5 s, skylight 41 s, float 49.5 s, wrap 56 s;
  every beat hits its shot pose exactly, so the stills and the guided take share
  the same compositions. `CINEMATIC_DURATION` is 56 s, inside the 40–60 s bar,
  and `setCinematic(t)` wraps deterministically.
- Free look is a separate mode (WASD/QE/Shift, pointer lock) that does not feed
  back into the guided path. Shot changes use a 1.35 s eased transition; in
  capture mode `renderAt(t)` snaps and holds.
- `window.__pool` exposes no new camera API; the capture bench drives
  `setShot`/`setCinematic` only.

## 11. Post and display transform

`src/render/PostPipeline.ts` + CPU reference `src/core/post.ts` (+ tests).

- **One display transform**: the final pass applies exposure, then ACES (or AgX,
  the default) and then the exact sRGB OETF exactly once. The scene target stays
  linear HDR; no material applies gamma and three.js tone mapping is off.
- **Contained bloom**: instead of thresholding the whole scene, a half-resolution
  **emissive mask pass** renders only meshes whose material opts in
  (`toneMapped === false`, or `userData.bloom === true`; opt out with
  `userData.bloom = false`). Window panes, the skylight, fluorescent tubes and
  the warm corridor glow are on that list; tile specular, chrome and water
  highlights cannot bloom by construction. The mask feeds a C1 soft-knee bright
  pass (`BLOOM_THRESHOLD` 1.5, `BLOOM_KNEE` 0.35, clamp 24), a half-resolution
  bloom pyramid and an additive upsample; the chain gain is `BLOOM_GAIN` 0.55
  times the App's API strength (0.34), i.e. about 0.19.
- **Final composite**: edge-only chromatic aberration, bloom add, exposure, then
  **AgX** (three.js r186/Filament port; ACES is available through the same
  uniform), exactly one sRGB OETF, a contained display-space grade (contrast
  1.15, saturation 1.11, a slight cool-shadow / warm-highlight split), a gentle
  vignette (0.24), monochrome triangular grain (`GRAIN_AMOUNT` 0.017) quantised
  to **24 fps** and keyed on pixel + frame, triangular dither (±0.5 LSB) so
  gradients do not band, and optional exact 2.39:1 bars (138 px top/bottom at
  1920×1080). No second gamma or tone map exists anywhere in the chain; exposure
  is the App's 1.20 and is locked per shot.
- **Letterbox** is used by the trailer only; stills stay 16:9. `src/core/post.ts`
  mirrors the curves in CPU code (ACES, AgX, sRGB, bright pass, grain, dither,
  letterbox, mask classification) and the tests pin the single-transform,
  highlight-containment and determinism properties.

## 12. Quality tiers

`src/app/quality.ts`; the tiers are selected with `?quality=`.

| | low | medium | high | ultra |
| --- | --- | --- | --- | --- |
| render scale | 0.6 | 0.8 | 1.0 | 1.0 |
| max pixel ratio | 1 | 1 | 1.5 | 2 |
| shadow map | 1024² | 2048² | 2048² | 4096² |
| reflection scale | 0.3 | 0.45 | 0.6 | 0.8 |
| MSAA samples | 0 | 2 | 4 | 4 |
| anisotropy | 4 | 8 | 16 | 16 |
| bloom levels | 4 | 5 | 6 | 6 |
| material detail | 0.55 | 0.75 | 0.9 | 1 |

`materialDetail` drives the tile texture size (1024 vs 2048), POM step count
(8 vs 12) and the lighting bake quality (probe grid dimensions, samples per
probe, bounce count, contact-occlusion accent). Low still boots and renders at
1280×720; the water prepass and reflection targets scale with the preset.

## 13. Determinism

- All animation is driven by the scene clock (`renderAt(t)`, `setCinematic(t)`,
  `setShot` + `t`), never by `performance.now()` for the image. The render loop
  uses wall time only to advance the clock when not paused.
- No visual system calls `Math.random`; procedural textures, dust, bake samples
  and prop variation use seeded `Rng`/`hash2`/Hammersley sequences.
- Grain is quantised to 24 fps and hashed from `(pixel, frame)`, so two captures
  of the same scene time are byte-identical.
- The probe bake is static and seeded, the sun shadow map is frozen after
  warm-up, and the failing-tube flicker is a function of scene time.
- `pnpm determinism` launches two fresh browsers, captures the same shot and a
  cinematic time (with object transforms), and fails if the images differ.

## 14. Capture and deliverables bench

`scripts/` (shared `lib/bench.mjs`, `lib/trailer-plan.mjs`):

| Command | Output |
| --- | --- |
| `pnpm stills` | seven 1920×1080 stills + one 3840×2160 hero → `stills/`, `manifest.json` |
| `pnpm trailer` | 1920×1080, 24 fps, 2.39:1 H.264 → `stills/trailer.mp4`, `trailer.json` |
| `pnpm shot` | one ad-hoc still → `shots/` (gitignored) |
| `pnpm determinism` | two-run byte comparison + transform check |
| `pnpm perf` | fps p50/p95/max, draw calls, triangles, low-preset boot |

The bench runs headed Chrome on `DISPLAY=:0` (hardware WebGL), waits for
`__POOL_READY__`, removes the loader/HUD, calls `renderAt(t)` and waits two
`requestAnimationFrame`s. It brings the off-screen window to the front (an
unfocused window throttles rAF to ~1 Hz on this machine) and reads pixels from
the WebGL drawing buffer, which is pixel-identical to a CDP screenshot and much
faster. Per-shot scene times are chosen so the water motion is mid-beat
(`SHOT_TIMES` in `lib/bench.mjs`). The manifest stores each frame's scene time,
size, renderer stats and SHA-256; the trailer plan steps the guided camera at
exactly 24 fps, burns the 2.39 bars, cuts windows together with 0.6 s
cross-dissolves and verifies the encoded file with `ffprobe`.

## 15. Measured performance

Measurement commands: `pnpm perf` and `pnpm stills` on the RTX 3060 host, headed
Chrome 156 on `DISPLAY=:0`, 1920×1080, ultra, on the integrated head with the
volumetrics NaN fix (`0eb3036b`), the final post grade and the reframed shots
merged. Numbers move by a few percent with host load; the distribution below is
from the quiet run used for the committed stills.

Frames were timed in shot mode at the arrival pose (the heaviest), 553 frames
after warm-up, with the browser focused:

| Metric | Measured |
| --- | --- |
| average / p50 / p95 / max frame time | 9.1 / 8.9 / 11.5 / 21.7 ms |
| average fps | 109.8 |
| frames over 22.2 ms (45 fps) after warm-up | 0 |
| draw calls / triangles | 355 / 96,054 |
| load to `__POOL_READY__` (ultra, includes IBL + probe bake) | ≈5.0 s |
| bake cost | 279,936 primary + 122,581 shadow rays, 96.7k tris, ~1.1 s |

Per-shot draw calls and triangles at 1920×1080 (from the stills manifest):

| Shot | Calls | Triangles |
| --- | --- | --- |
| arrival | 355 | 96.1k |
| flume | 223 | 94.4k |
| ring | 103 | 57.2k |
| arch | 172 | 53.1k |
| skylight | 284 | 63.9k |
| tile | 53 | 45.4k |
| float | 342 | 96.0k |
| hero 3840×2160 (arrival) | 355 | 96.1k |

The low preset boots at 1280×720 with `renderScale` 0.6 (768×432 drawing
buffer), 351 calls and 96.0k triangles, and its bake uses 3600 probes, 15×8×30,
N=35, two bounces. The budget in the acceptance criteria is 45 fps at 1080p
ultra, ≤700 draw calls and ≤500k triangles; the measured worst frame here was
21.7 ms and the call/triangle counts are dominated by props, not by particles.
The machine is a shared capture host, so a run during heavy parallel work can
report lower numbers (the earlier same-head runs ranged ~99–117 fps); the
warm-up-excluded distribution above is from a quiet run and every frame in it
met the bar.

## 16. Known limitations

These are real and deliberately not hidden with darkness, blur or letterbox:

- **No TAA.** The scene target is MSAA 4× (2× on medium, none on low). Thin
  rails, ladder rungs and the flume lip can shimmer slightly during the fastest
  camera transit; camera speed is capped at 1.78 m/s and the guide keeps its
  calm windows. There is no chrome roughness/AA floor in the shipped materials
  (that experiment was measured on the rail dashes and reverted because it did
  not change them).
- **Water is a screen-space/planar hybrid.** Reflection and refraction are
  reduced-resolution HDR targets (0.8×/0.68× at ultra); the reflection is
  slightly softened at distance by design. The refraction path solves the basin
  exit analytically, so there is no true per-pixel underwater depth and no object
  caught half-way through the surface. At some grazing angles the reflected
  ceiling grid reads like a tiled floor until the camera moves; that pattern is
  the reflection, not the basin (verified by isolating the refraction and
  reflection terms). The far doorway glow is deliberately kept below clipping
  (1.85 peak), so the warm read lives in the band above it rather than the
  doorway itself.
- **Wakes are analytic.** Ring and mouth wakes are summed sine/decay rings, not
  a fluid simulation; ripples do not interact with each other or with props.
- **Caustics are an analytic lattice**, not photon-mapped. They read correctly
  on submerged surfaces and fade at the waterline, but they are a stylisation.
- **Tile detail fades with distance.** The bevel/chip/tilt layers fade by
  screen-space footprint so 4K far walls do not moire; beyond ~10 m the wall
  reads flatter than a hand-set wall under raking light. The plaster/deck grime
  field repeats every ~4–7 m (large, sheared, low contrast) and POM costs ~4
  extra texture fetches per pixel on near tile at ultra.
- **The light bake is static.** Moving rings and the bobbing flume lip do not
  throw moving shadows or occlusion; the probe volume only knows the room at
  bake time. Three bounces truncate the interreflection tail (far corners settle
  near 0.02 irradiance, close to black against the lit walls), L2 SH cannot carry
  sharp indirect detail, and the 0.3 m contact accent is an approximation rather
  than contact shadows.
- **Shadows are a single directional map**, frozen after warm-up, with PCF
  filtering (`sun.shadow.radius = 8` is the penumbra control: three r186 removed
  `PCFSoftShadowMap`, so the App's request falls back to PCF); no cascades or
  screen-space shadows.
- **Volumetrics are additive cards + points**, not a depth-aware raymarch. A
  shaft cannot be occluded by an object placed inside it (there are none in the
  shot set); the shafts read weakly when looking straight up the aperture and the
  760 dust motes can sparkle slightly at 1080p.
- **Props are authored props, not a simulation.** The flume's platform crown sits
  above the arrival/flume frame top by design and only reads in float and the
  guided take; the flume's submerged lower third depends on the water refraction
  to read; rings cannot be merged into one draw call because each carries its own
  print; the staining is shader-driven and was tuned against the tile exposure.
- **Framing is tuned, not automatic.** Shot poses were authored against
  `LAYOUT` anchors and the final props/water; the `tile` macro only pays off with
  the POM/glaze detail, and the flume shot depends on the redesigned mouth
  staying where `LAYOUT.slide.end` says it is.
- **Distant glazed walls fade to a smooth tile sheen past ~14 m** — the
  hand-set tilt is a near/mid-range cue only — and the thin chrome rail
  highlight can alias into single-pixel specular breaks at 1080p; that is the
  no-TAA limitation above, not a material bug (the water reflection kernel was
  widened to stop its own dash class).
- **No depth of field, motion blur, lens dirt or true lens distortion.** Post is
  ACES/AgX + contained bloom + grade + vignette + edge CA + grain.
- **The room is a finished set, not a game.** Free look exists for inspection;
  there are no interactions, no audio and no second space. The near-wall doorway
  is a dark card on purpose.
- **Load time includes two bakes** (IBL cube capture and the probe-grid ray
  trace). On the target machine the app reaches `__POOL_READY__` in the time
  reported in §15; a slower GPU/CPU will extend the loader phase, not the
  steady-state frame cost.

## 17. Evidence

Committed evidence for this run lives under `docs/evidence/` (before/after pairs
from the post, camera and bench lanes) and `stills/` (final stills, 4K hero,
trailer, manifest and trailer plan). `pnpm determinism` and `pnpm perf` regenerate the numbers quoted above;
`pnpm stills` and `pnpm trailer` regenerate the images and video
deterministically.
