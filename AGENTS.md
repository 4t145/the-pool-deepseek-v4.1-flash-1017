# Working Agreement — THE POOL

The human's brief: one scene, maximum fidelity, trailer/PV-grade presentation.
Water, glazed tile reflections and baked lighting are explicitly called out. The
look and acceptance bar live in `docs/ART_DIRECTION.md` and
`docs/ACCEPTANCE.md`. Read both before changing anything visible.

## How this run works

- This is a Swarm run of independent peers in isolated worktrees. Discover work
  from the goal, the current images, and the acceptance criteria; claim it on the
  Swarm board; negotiate interfaces with affected peers. There is no manager task
  list to follow.
- The baseline is deliberately vertical but rough. “It builds” is not done.
  Compare every change against a capture, not against memory.
- Keep changes reviewable. One coherent improvement per branch/merge is easier
  to integrate than a sweeping rewrite that touches ten systems.
- The shared bench is `pnpm shot …`. Use it before and after. Capture at
  1280×720 for iteration, 1920×1080 for review, 3840×2160 only for final stills.
- Report what you actually ran, what you saw in the capture, and what is still
  weak. Never claim a frame you did not open.

## Non-negotiables

1. **One scene, no scope creep.** No second room, no gameplay, no menus, no
   story UI, no downloaded assets.
2. **Determinism.** All animation is driven by the scene clock. Use `Rng`; no
   `Math.random`, no `Date.now` in visual systems. `renderAt(t)` must be stable.
3. **Contracts.** Preserve `window.__pool` and the `LAYOUT` coordinate semantics.
   If dimensions or anchors must move, update every consumer and say so.
4. **Single display transform.** The scene renders linear HDR; `PostPipeline`
   owns ACES + sRGB. Do not tone-map twice or add gamma in materials.
5. **Capture-grade UI hygiene.** No helpers, axes, debug text, loader or HUD in
   final stills. Hide or remove them in capture mode.
6. **Verification.** `pnpm typecheck`, `pnpm test`, `pnpm build` must pass. Add
   tests for new math/systems. A browser smoke capture is required evidence for
   visual work.
7. **Performance.** 1080p ultra ≥ 45 fps on the RTX 3060 target, draw calls
   < 700, triangles < 500k. Measure, do not assume.

## Technical map

- `src/world/architecture.ts` — static building fabric. Changing the shell can
  invalidate every other system; coordinate before editing.
- `src/world/textures.ts` / `materials.ts` — tile, signs, vinyl, PBR library.
- `src/world/water.ts` — reflection, refraction, foam, caustics.
- `src/world/lighting.ts` — sun, area lights, IBL, fog; bake hooks.
- `src/world/props.ts` — flume, rings, ladders, rails.
- `src/render/PostPipeline.ts` — HDR targets, bloom, grade, letterbox, capture
  grain.
- `src/app/cinematics.ts` — shots, guided path, free look.
- `src/app/App.ts` — orchestration. Keep edits minimal and integration-shaped.
- `scripts/shot.mjs` — deterministic capture; extend it for trailer frames if
  needed, keep the CLI backward-compatible.

## Known sharp edges

- Chrome must run headed on `DISPLAY=:0` for hardware WebGL; headless is
  SwiftShader. Use `scripts/run-browser.sh` / `pnpm shot`.
- The scene target is MSAA HalfFloat; check `EXT_color_buffer_float` behavior on
  low tiers.
- Tile UVs are in metres. Keep 1 UV unit = 1 metre or the whole building’s tile
  scale changes.
- The water reflection camera uses oblique clipping; test with camera roll and
  with the camera very close to the surface.
- The IBL bake runs before water exists and freezes shadows after warm-up. If you
  add moving shadow casters, revisit the freeze.

## Definition of done for a merge

- Code builds and tests pass.
- A capture (before/after) demonstrates the intended improvement and no visible
  regression in the other six shots.
- Performance numbers unchanged or better, or the cost is justified in the
  report.
- Relevant docs updated (`docs/IMPLEMENTATION.md`, README) when behavior or
  controls change.
