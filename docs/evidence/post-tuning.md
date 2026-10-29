# Post tuning evidence — owner rev-1 correction

Measured on the integrated head after w1 lighting (fog/IBL correction), w4 tile,
w2 props, w5 camera reframe and w3 water repair were accepted. The post tuning
commit is the one this file lands with; the scene code is unchanged by it.

Hardware: RTX 3060, headed Chrome on DISPLAY=:0, WebGL2, 1920×1080 ultra for the
seven stills (355 draw calls, 96.1k triangles on arrival).

## Final post constants (`src/core/post.ts`, `src/render/PostPipeline.ts`)

| Stage | Value |
| --- | --- |
| Display transform | AgX (three.js r186/Filament port); ACES selectable via the same uniform |
| Exposure | 1.20 (App → `PostPipeline`) |
| sRGB encode | exact piecewise OETF, applied once |
| Grade | saturation 1.11, contrast 1.15, cool-shadow / warm-highlight split |
| Bloom source | half-res emissive-mask pass (layer 1; `toneMapped === false` or `userData.bloom === true`) |
| Bloom threshold / knee / chain gain | 1.5 / 0.35 / 0.55 (App 0.34 → effective ≈ 0.19) |
| Grain | 0.017 monochrome triangular, quantised to 24 fps, pixel+frame seeded |
| Dither | triangular, ±0.5 LSB |
| CA | edge-only, zero at frame centre, ≤2 px at 1920×1080 corners |
| Vignette | 0.24 |
| Letterbox | optional 2.39:1 |

## Measured display statistics (final PNGs, sRGB display luminance 0–1)

| shot | mean | p50 | p95 | p99 | clipped |
| --- | --- | --- | --- | --- | --- |
| arrival | 0.331 | 0.306 | 0.741 | 0.960 | 0.01 % |
| flume | 0.390 | 0.429 | 0.818 | 0.894 | 0.04 % |
| ring | 0.223 | 0.164 | 0.599 | 0.731 | 0 % |
| arch | 0.401 | 0.456 | 0.757 | 0.909 | 0.01 % |
| skylight | 0.497 | 0.529 | 0.928 | 0.992 | 0.29 % |
| tile | 0.268 | 0.197 | 0.621 | 0.649 | 0 % |
| float | 0.329 | 0.330 | 0.655 | 0.822 | 0.01 % |

Neutral warm-tile pixels only (excludes water, windows, teal bands, flume):
arrival p50 0.518 / p90 0.769 · arch 0.555 / 0.781 · skylight 0.561 / 0.857 ·
tile 0.570 / 0.661 · float 0.523 / 0.634. Lit glaze sits in the
ART_DIRECTION 0.72–0.85 band; the deep blacks in the frames are the water body.

## Letterbox

`pnpm shot -- --shot=arrival --letterbox --width=1920 --height=1080 --time=2.4`:
top bar 138 px, bottom bar 138 px, visible image 1920×804 → aspect 2.388 (target
2.39). Stills without `--letterbox` are clean 16:9.

## Verification

- `pnpm typecheck`, `pnpm test` (102 tests), `pnpm build` pass.
- `pnpm determinism`: shot-arrival-1080p and cinematic-1080p both
  `identical=true idempotent=true transforms=true`
  (shot sha256 `b66edbe02fabdc52…`, cinematic `c62c362cc5e6f9f9…` on this head).
- `pnpm perf -- --shot=arrival --seconds=6 --skip-low`: 116.8 fps avg,
  p50 7.9 ms, p95 13.7 ms, 355 draw calls, 96,054 triangles, one frame over
  22.2 ms after warm-up.
- Capture bench: no console errors or page errors on any of the seven stills;
  the old `/favicon.ico` 404 is gone.
- 4K sanity (3840×2160 arrival): no banding in the fog/ceiling gradations,
  grout holds at 1:1, skylight keeps bay/mullion structure, grain+dither subtle
  (`post-4k-skylight-crop.png`).

## Files

- `post-before-arrival-720.png` — baseline post (commit 2cb5a88).
- `post-after-arrival-720.png`, `post-after-tile-720.png`,
  `post-after-arch-720.png` — final tuning on the integrated head.
- `post-letterbox-arrival-1920.png` — 2.39:1 proof.
- `post-4k-skylight-crop.png` — 1:1 4K highlight/dither check.
