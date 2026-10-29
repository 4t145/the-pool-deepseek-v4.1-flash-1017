import type { PerspectiveCamera, Scene, WebGLRenderer } from 'three';

export interface PoolStats {
  fps: number;
  frame: number;
  mode: string;
  shot: string;
  drawCalls: number;
  triangles: number;
}

/** The stable surface used by capture scripts and by workers inspecting the build. */
export interface PoolApi {
  renderAt(time: number): void;
  setShot(id: string): void;
  setCinematic(time?: number): void;
  setPaused(paused: boolean): void;
  setLetterbox(enabled: boolean): void;
  setHud(enabled: boolean): void;
  setExposure(value: number): void;
  setBloom(value: number): void;
  getStats(): PoolStats;
  camera: PerspectiveCamera;
  scene: Scene;
  renderer: WebGLRenderer;
  time(): number;
}
