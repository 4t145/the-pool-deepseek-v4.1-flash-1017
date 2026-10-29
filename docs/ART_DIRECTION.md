# Art Direction — THE POOL

## 1. The room

An indoor municipal pool, closed for years, flooded to the walkway. The water is
still except for what the building does to it. Overcast daylight enters through a
long skylight slot and nine pairs of frosted windows. Nothing else moves except
three inflatable rings and a thin skin of ripples.

The space should feel **quiet, institutional, sun-bleached and slightly wrong** —
not gory, not a jumpscare, not neon cyberpunk. The wrongness is spatial: a
children's flume in a pool that has not had children in it for a long time.

Reference language (attached images are the brief, not assets):

- small white ceramic wall tile, dark grout, hand-set irregularity;
- deep green-black water with a razor-sharp reflection of the ceiling, broken by
  soft wind ripples;
- a huge red plastic flume or play structure half-drowned at the near end;
- red, yellow and blue inflatable rings floating like punctuation;
- flat overcast light, blown-out windows, weak fluorescent fill;
- chrome ladders and guardrails, painted enamel signs, teal tile bands;
- a warm amber opening at the far end, the only warm thing in the room.

## 2. Palette

| Role | Colour | Notes |
| --- | --- | --- |
| Tile body | `#e8e2d4` → `#cfc9bc` | warm bone, never pure white |
| Grout | `#6f6b60` | 2–3 mm, darker when wet |
| Algae / waterline | `#4e6b58`, `#2f4b43` | low saturation, vertical staining |
| Water deep | `#071817` | near-black green |
| Water shallow | `#143b33` | seen at grazing angles |
| Flume red | `#9c1d16` | glossy PVC, strong specular |
| Steel | `#c8cfce` | high metalness, low roughness |
| Window light | `#eef8ff` | clipped, cold |
| Far arch | `#ffb26b` | sodium/incandescent, low intensity, high atmosphere |

Grade: cool, slightly desaturated shadows; warm bone highlights; no Instagram
teal-orange. Contrast should come from light, not from a LUT.

## 3. Surfaces

### Tile

- Nominal tile: **125 mm square**, 2.5–3 mm grout, 1.5 mm chamfer.
- Glaze: near-zero roughness, clearcoat; the bevel catches a thin specular line.
- Irregularity: per-tile value ±4 %, slight tilt, occasional chipped corner,
  rare hairline crack. Never a visible repeating 8×8 stamp.
- Grime: dark grout, dirt accumulating at the chamfer, faint vertical drip
  streaks under windows, algae rising from the waterline, dry salt bloom above it.
- Underwater tile: darker, greener, lower contrast; caustic patterns play across
  it.
- Use parallax occlusion mapping (or equivalent) so grout has real depth at
  grazing angles. It must hold at 4K.

### Water

- Planar reflection is the primary reflection. It must be **geometrically
  correct**, follow the camera, and include the flume, rings, rails, lights.
- Add refraction of the underwater basin and submerged props with depth-based
  absorption (Beer–Lambert), not a flat alpha tint.
- Ripples: 2–3 scrolling normal layers at different scales plus analytic wakes
  around the three rings and the flume mouth. Amplitude low; water is nearly
  still.
- Fresnel: strong at grazing, dark body when looking down. No mirror-perfect
  surface: micro-roughness should blur the reflection slightly with distance.
- Caustics: projected on the basin floor, submerged steps, the flume below the
  waterline, and the lower tile band. Animated but slow. Subtle on walls above
  water.
- Foam/scum: thin line at coping, contact foam around floating rings and the
  flume mouth, a few drifting flecks. Never white cartoon foam.
- The reflection must be temporally stable: no shimmering at rest, no doubled
  edges.

### Plastics / metals

- Flume: thick rotationally moulded red PVC. Broad soft highlight, tiny orange-
  peel normal, waterline grime band, interior darker and wet. The mouth must read
  as hollow and deep, not a red cap.
- Rings: inflated vinyl, flattened torus, visible seam, valve, slight sheen and
  subsurface warmth where backlit. Stripes/paint should be printed, not plastic
  bands.
- Chrome: ladders, rails, trims. Roughness 0.06–0.12, slight edge wear, water
  droplets. Reflections should pick up windows and the skylight.
- Enamel signs: worn edges, chipped paint, readable but not crisp.

## 4. Light

- Key: overcast sky through the skylight, very soft but directional enough to
  draw long pale bars on the water. One warm sun break is allowed; no hard noon
  shadows.
- Bounce: the white tile room must self-illuminate. Baked indirect light is
  expected — lightmaps, irradiance probes, or a defensible equivalent. Ceiling
  and upper walls must not go black.
- Windows: clipped cold rectangles with a soft halo; no visible room behind.
- Fluorescents: weak, slightly green, one failing tube at the far end.
- Volumetric: visible but restrained shafts under the skylight, dust motes in the
  beam, fog that increases with depth. No thick smoke.
- Far arch: warm amber spill, a suggestion of another corridor, never a flat
  orange rectangle.
- Exposure: protect the window and skylight highlights; the tile in the light
  should sit around 0.72–0.85 display value, shadows no lower than 0.05 unless
  they contain detail.

## 5. Camera and shots

The camera is a patient observer, low over the water. Slow moves only. Focal
lengths 34–70 mm equivalent; no fisheye. Shots:

1. **Arrival** — low, centred, flume large at screen left, skylight leading to the
   far arch. The establishing frame; must work as a poster.
2. **The Flume** — three-quarter view of the red structure, mouth toward camera,
   waterline and reflections visible.
3. **Still Water** — close to the red ring; reflection, ripples, caustics, tile
   texture in the same frame.
4. **The Arch** — down the hall toward the warm opening, arcade silhouettes,
   shafts and haze.
5. **Ascension** — low angle up into the skylight, dust and flare, water in the
   bottom third.
6. **Skin** — macro of tile, grout, waterline stain, chrome trim. A material
   proof frame.
7. **Float** — high angle over the rings and the flume footprint.

The guided cinematic is one continuous take through these compositions, 40–60 s,
looping invisibly. Handheld drift is < 1 cm; no whip pans.

## 6. Post

- HDR, ACES (or AgX) tone mapping, exposure locked per shot.
- Bloom: threshold high enough that only windows, tubes and the skylight bloom;
  tile highlights must not glow.
- Subtle chromatic aberration at the edges only; no RGB split on the subject.
- Film grain: fine, monochrome, animated at 24 fps feel; stronger in shadows.
- Vignette: gentle, never a black tube.
- Letterbox optional (2.39:1) for the trailer; keep 16:9 clean for stills.
- Grade: protect skin-tone-free scene from drifting magenta; keep the red flume
  saturated but not neon.

## 7. What “finished” looks like

A 3840×2160 still of any shot should look intentional at 100 %: tile edges clean
but not CG-sharp, water reflection legible, no repeating pattern, no clipped
white without structure, no flat black ceiling, no stuck-on props, no visible
shadow-map stair-stepping or water shimmer. A 20 s 1080p clip should feel like a
trailer cut, not a tech demo.

## 8. Anti-goals

- No extra rooms, no story UI, no zombies, no floating text in the world.
- No downloaded asset packs, no AI-generated texture sheets.
- No heavy depth of field that hides the materials.
- No “ray tracing” claims without a real implementation.
- No HUD in capture stills; no debug axes.
