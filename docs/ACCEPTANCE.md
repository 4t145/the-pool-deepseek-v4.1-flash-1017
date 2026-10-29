# Acceptance — THE POOL

This is the finish line for the Swarm run. “Looks better” is not a criterion; each
item below must be demonstrable from the running build or a captured frame.

## A. Visual bar

1. **Tile system.** The wall/floor tile reads as glazed 125 mm ceramic with real
   grout depth (POM or equivalent), per-tile colour/tilt variation, chipped
   corners, grime at chamfers, vertical drip staining and an algae/waterline
   band. No obviously repeating 1 m texture patch in any of the seven shots. At
   3840×2160 the tile edges stay clean without looking like a wireframe.
2. **Water.** Planar reflections are geometrically correct and include the flume,
   rings, rails, windows and skylight. The surface shows refraction/absorption of
   submerged geometry, animated caustics on the basin/stairs/flume, thin contact
   foam and ring wakes, and stable low-amplitude ripples. No z-fighting, no
   doubled reflection edges, no visible RT resolution stair-step.
3. **Light.** The room has believable indirect bounce: ceiling and upper walls
   are not black; the skylight and windows are clipped but still contain detail;
   soft volumetric shafts and dust are visible in at least the arrival, arch and
   ascension shots. The far arch reads as warm depth. One failing fluorescent is
   allowed. No blown-out centre blob.
4. **Props.** The red flume is a deliberate design (corkscrew/double flume) with a
   readable hollow mouth, waterline staining, chrome supports and a credible
   splash/contact zone. Rings float at the surface with visible thickness, seams,
   valves and reflections. Ladders/railings meet the deck and water correctly.
5. **Composition.** All seven shots are framed per `docs/ART_DIRECTION.md`, free
   of clipping through walls/columns/flume; each has a clear foreground, middle
   ground and vanishing point. The arrival frame works as a poster. The guided
   take is 40–60 s, loops without a visible cut, and moves only slowly.
6. **Post.** ACES/AgX in the final pass only; bloom is contained to windows,
   skylight and tubes; tile highlights do not glow. Grain, vignette and edge
   chromatic aberration are subtle and optional letterbox is 2.39:1. No banding in
   the fog/ceiling gradients.

## B. Technical bar

1. `pnpm typecheck`, `pnpm test`, `pnpm build` pass in a clean checkout after
   `pnpm install --frozen-lockfile`.
2. Browser smoke capture succeeds in headed Chrome:
   `pnpm shot -- --shot=arrival --width=1280 --height=720 --time=2` produces a
   non-black image and the console has no uncaught errors.
3. `renderAt(t)` is deterministic: two captures of the same shot/time are
   pixel-identical apart from allowed grain (make grain deterministic for
   captures) and produce the same object transforms.
4. Ultra at 1920×1080 on RTX 3060 sustains ≥ 45 fps in shot mode and ≤ 700 draw
   calls / 500k triangles. Low preset boots at 1280×720.
5. No runtime network requests, no external asset URLs, no `Math.random` in the
   scene graph, no wall-clock-driven animation.
6. The `window.__pool` API and `LAYOUT` coordinate semantics remain intact.
7. New tests cover non-trivial math/systems introduced (water optics, bake
   sampling, camera path sampling, deterministic RNG, etc.).

## C. Deliverables

1. Working app + `pnpm dev`.
2. Seven capture stills at **1920×1080** minimum in `stills/`, plus at least one
   **3840×2160** hero still. No HUD, no loader, no debug geometry.
3. A **20–30 s, 1920×1080, 24 fps H.264 MP4** trailer in `stills/` (letterboxed,
   no UI), cut from the guided camera or the seven shots with slow transitions.
   Audio is optional but a subtle procedural room tone/water bed is welcome.
4. Updated `README.md` with controls, capture commands and a short “what this is”.
5. `docs/IMPLEMENTATION.md` recording the final pipeline, bake method, quality
   tiers, performance numbers and known limitations. Claims must match code.

## D. Stop conditions

- Do not add a second room, gameplay systems, enemies, story text, or a menu.
- Do not hide weak areas with heavy DOF, darkness, bloom or letterbox.
- Do not replace procedural assets with downloaded packs.
- Do not leave debug HUD, axes, helper lines, console spam or dead code paths.
- Do not regress the baseline API or the `arrival` framing while polishing.

## E. Evidence

A submission is complete only when it includes:

- passing verification output;
- at least one before/after capture pair for the arrival shot;
- a 10 s minimum screen recording or the MP4 trailer proving water motion and
  camera stability;
- FPS/draw-call numbers from the running app;
- a short list of what changed, what remains weak, and why.

If an item cannot be met, say so explicitly in `docs/IMPLEMENTATION.md`; do not
silently lower the bar.
