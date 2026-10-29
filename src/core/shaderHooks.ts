import type { Material, WebGLRenderer } from 'three';
import type { WebGLProgramParametersWithUniforms } from 'three';

/**
 * `material.onBeforeCompile` is a single-slot callback, but several systems in
 * THE POOL need to patch built-in materials (baked probe lighting, caustics,
 * tile parallax). Assigning it twice silently drops the earlier patch. This is
 * the one shared convention: every system registers a named hook through
 * `addShaderHook`, which
 *
 *  - chains whatever `onBeforeCompile` the material already had (so three's
 *    built-in behaviour and any later registrant both run);
 *  - keeps one entry per key, so re-registering the same key is idempotent;
 *  - composes `customProgramCacheKey` so two materials that are patched
 *    differently never share a program;
 *  - marks the material dirty so the program is rebuilt on the next frame.
 *
 * The hook key must encode anything that changes the generated GLSL (for the
 * tile shader: underwater / parallax on-off / chips). It is also the program
 * cache key contribution, so keep it short and stable.
 */
export type ShaderHook = (shader: WebGLProgramParametersWithUniforms) => void;

interface HookEntry {
  key: string;
  hook: ShaderHook;
}

interface HookStore {
  entries: HookEntry[];
  installed: boolean;
}

const stores = new WeakMap<Material, HookStore>();

const storeFor = (material: Material): HookStore => {
  let store = stores.get(material);
  if (!store) {
    store = { entries: [], installed: false };
    stores.set(material, store);
  }
  return store;
};

const cacheKeyFor = (store: HookStore): string => store.entries.map((entry) => entry.key).join('|');

export function addShaderHook(material: Material, key: string, hook: ShaderHook): void {
  if (!key) throw new Error('addShaderHook: key must not be empty');
  const store = storeFor(material);
  const existing = store.entries.findIndex((entry) => entry.key === key);
  if (existing >= 0) store.entries[existing] = { key, hook };
  else store.entries.push({ key, hook });

  if (!store.installed) {
    store.installed = true;
    // Capture the handler that was on the material *before* we installed the
    // dispatcher: three's prototype no-op, or a peer hook registered earlier.
    const previous = material.onBeforeCompile.bind(material);
    const previousKey = material.customProgramCacheKey.bind(material);
    material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms, renderer: WebGLRenderer) => {
      previous(shader, renderer);
      for (const entry of store.entries) entry.hook(shader);
    };
    material.customProgramCacheKey = () => `${previousKey()}|hooks:${cacheKeyFor(store)}`;
  }
  // The program cache key can change on every registration; force a rebuild.
  material.needsUpdate = true;
}

/** Number of hooks registered on a material (diagnostics / tests). */
export function shaderHookCount(material: Material): number {
  return stores.get(material)?.entries.length ?? 0;
}
