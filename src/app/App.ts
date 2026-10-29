import {
  Color,
  NoToneMapping,
  PCFSoftShadowMap,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Vector2,
  WebGLRenderer,
} from 'three';
import type { AppSettings } from './settings';
import { QUALITY } from './quality';
import { Cinematics } from './cinematics';
import { buildArchitecture } from '../world/architecture';
import { buildProps } from '../world/props';
import { buildLighting } from '../world/lighting';
import { buildWater } from '../world/water';
import { createMaterials } from '../world/materials';
import {
  createSignTexture,
  createTileTextures,
  createWaterNormalTexture,
  yieldToPaint,
  type TileTextureSet,
} from '../world/textures';
import { PostPipeline } from '../render/PostPipeline';

import type { PoolApi } from '../types/api';

const loadEl = (id: string): HTMLElement | null => document.getElementById(id);

export class App {
  readonly settings: AppSettings;
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  readonly canvas: HTMLCanvasElement;

  private post: PostPipeline | null = null;
  private cinematics: Cinematics | null = null;
  private water: ReturnType<typeof buildWater> | null = null;
  private lighting: ReturnType<typeof buildLighting> | null = null;
  private props: ReturnType<typeof buildProps> | null = null;
  private tiles: TileTextureSet | null = null;

  private elapsed = 0;
  private paused = false;
  private lastFrameTime = 0;
  private fpsAccumulator = 0;
  private fpsFrames = 0;
  private fps = 0;
  private frameCount = 0;
  private lastStatsUpdate = 0;
  private raf = 0;
  private readonly drawSize = new Vector2();
  private frozenShadows = false;

  constructor(settings: AppSettings) {
    this.settings = settings;
    this.canvas = document.getElementById('c') as HTMLCanvasElement;
    if (!this.canvas) throw new Error('Missing #c canvas');

    this.renderer = new WebGLRenderer({
      canvas: this.canvas,
      antialias: false,
      alpha: false,
      stencil: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: true,
    });
    this.renderer.setClearColor(new Color(0x060b0c), 1);
    this.renderer.toneMapping = NoToneMapping;
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFSoftShadowMap;
    this.renderer.info.autoReset = false;

    this.camera = new PerspectiveCamera(52, window.innerWidth / window.innerHeight, 0.05, 140);
    this.camera.position.set(0.35, 1.12, -25.4);
    this.camera.lookAt(0.1, 1.24, -4);
  }

  async init(): Promise<void> {
    const quality = QUALITY[this.settings.quality];
    this.setLoading('PREPARING THE ROOM', 0.04);
    await yieldToPaint();

    this.resize();

    this.setLoading('FIRING THE TILE', 0.12);
    const maxAniso = Math.min(this.renderer.capabilities.getMaxAnisotropy(), quality.anisotropy);
    this.tiles = createTileTextures(this.renderer, {
      size: quality.materialDetail >= 0.9 ? 2048 : 1024,
      tiles: 8,
      worldSize: 1,
      seed: this.settings.seed,
      anisotropy: maxAniso,
    });
    await yieldToPaint();

    this.setLoading('PAINTING THE NOTICES', 0.42);
    const signNoDiving = createSignTexture(['NO DIVING', 'NO LIFEGUARD ON DUTY'], {
      width: 1024,
      height: 512,
      background: '#1d3a3d',
      ink: '#ece6d6',
    });
    const signDepth = createSignTexture(['DEEP WATER', '3.0 M'], {
      width: 768,
      height: 384,
      background: '#203b3e',
      ink: '#e9e3d2',
    });
    const materials = createMaterials({
      tiles: this.tiles,
      renderer: this.renderer,
      signNoDiving,
      signDepth,
    });
    await yieldToPaint();

    this.setLoading('BUILDING THE BASIN', 0.52);
    buildArchitecture(this.scene, materials);
    await yieldToPaint();

    this.setLoading('INSTALLING THE FLUME', 0.64);
    this.props = buildProps(this.scene, materials);
    await yieldToPaint();

    this.setLoading('BAKING THE OVERCAST', 0.72);
    this.lighting = buildLighting({
      scene: this.scene,
      renderer: this.renderer,
      quality: quality.materialDetail,
    });
    await yieldToPaint();

    this.setLoading('FILLING THE POOL', 0.86);
    const waterNormal = createWaterNormalTexture(this.renderer, 512, 820);
    this.water = buildWater(this.scene, this.renderer, this.camera, waterNormal, quality.reflectionScale);
    this.water.resize(this.renderer.domElement.width, this.renderer.domElement.height, quality.reflectionScale);

    this.setLoading('SETTING THE CAMERA', 0.94);
    this.cinematics = new Cinematics(this.camera, this.canvas);
    this.post = new PostPipeline(this.renderer, quality, {
      letterbox: this.settings.letterbox,
      exposure: 1.25,
      bloom: 0.34,
    });
    this.post.setSize(this.renderer.domElement.width, this.renderer.domElement.height);

    if (this.settings.shotId) {
      this.cinematics.setShot(this.settings.shotId, true);
      this.elapsed = this.settings.fixedTime ?? 0;
      this.paused = true;
    } else {
      this.elapsed = this.settings.fixedTime ?? 0;
      this.cinematics.setCinematic(this.elapsed);
      this.paused = this.settings.fixedTime !== null;
    }

    if (this.settings.showHud) document.body.classList.remove('hud-off');
    else document.body.classList.add('hud-off');

    this.renderer.compile(this.scene, this.camera);
    // Two frames: one to populate the static shadow map, one to settle the
    // reflection / resolve chain before capture clients are allowed in.
    this.renderFrame(0, this.elapsed);
    this.renderFrame(0, this.elapsed);
    this.setLoading('READY', 1);
    this.hideLoader();
    this.frameCount = 2;
    this.lastFrameTime = performance.now();
    this.exposeApi();
    this.installUiListeners();
    this.updateStats(performance.now());
    this.loop();
    window.__POOL_READY__ = true;
    window.__POOL_FRAME__ = this.frameCount;
  }

  private loop = (): void => {
    this.raf = requestAnimationFrame(this.loop);
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.lastFrameTime) / 1000);
    this.lastFrameTime = now;
    if (!this.paused) this.elapsed += dt;
    this.renderFrame(this.paused ? 0 : dt, this.elapsed);
    this.fpsAccumulator += dt;
    this.fpsFrames += 1;
    if (this.fpsAccumulator >= 0.5) {
      this.fps = this.fpsFrames / this.fpsAccumulator;
      this.fpsAccumulator = 0;
      this.fpsFrames = 0;
      this.updateStats(now);
    }
  };

  renderAt(time: number): void {
    this.elapsed = time;
    this.paused = true;
    this.renderFrame(0, time);
    this.lastFrameTime = performance.now();
  }

  private renderFrame(dt: number, time: number): void {
    if (!this.post || !this.cinematics || !this.water || !this.lighting || !this.props) return;
    this.cinematics.update(dt, time);
    this.props.update(time);
    this.lighting.update(time);
    this.water.update(time, this.camera);
    this.water.renderReflection(this.renderer, this.scene, this.camera);
    this.renderer.info.reset();
    this.post.render(this.scene, this.camera, time);
    this.frameCount++;
    window.__POOL_FRAME__ = this.frameCount;
    if (!this.frozenShadows && this.frameCount > 3) {
      this.frozenShadows = true;
      this.lighting.freezeShadows();
    }
  }

  private resize(): void {
    const quality = QUALITY[this.settings.quality];
    const scale = this.settings.renderScaleOverride ?? quality.renderScale;
    const ratio = Math.min(window.devicePixelRatio || 1, quality.maxPixelRatio) * scale;
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.getDrawingBufferSize(this.drawSize);
    this.post?.setSize(this.drawSize.x, this.drawSize.y);
    this.water?.resize(this.drawSize.x, this.drawSize.y, quality.reflectionScale);
  }

  private updateStats(now: number): void {
    if (now - this.lastStatsUpdate < 350) return;
    this.lastStatsUpdate = now;
    const stats = loadEl('stats');
    if (!stats || !this.renderer) return;
    const info = this.renderer.info.render;
    stats.textContent = `${this.fps.toFixed(0)} FPS  ·  ${this.settings.quality.toUpperCase()}  ·  ${info.calls} CALLS  ·  ${(info.triangles / 1000).toFixed(0)}K TRI`;
    const shotName = loadEl('shot-name');
    const shotIndex = loadEl('shot-index');
    const shot = this.cinematics?.currentShot;
    if (shot) {
      if (shotName) shotName.textContent = shot.label.toUpperCase();
      if (shotIndex) shotIndex.textContent = String(shot.index).padStart(2, '0');
    }
  }

  private setLoading(status: string, progress: number): void {
    const fill = loadEl('loader-fill');
    const label = loadEl('loader-status');
    if (fill) fill.style.width = `${Math.round(progress * 100)}%`;
    if (label) label.textContent = status;
  }

  private hideLoader(): void {
    const loader = loadEl('loader');
    if (loader) {
      loader.classList.add('done');
      if (this.settings.capture) loader.remove();
      else window.setTimeout(() => loader.remove(), 1600);
    }
  }

  private installUiListeners(): void {
    window.addEventListener('resize', () => this.resize());
    window.addEventListener('keydown', (event) => {
      if (event.code === 'KeyH') {
        const hidden = document.body.classList.toggle('hud-off');
        this.settings.showHud = !hidden;
      }
      if (event.code === 'KeyL') {
        const enabled = !this.post?.isLetterboxEnabled();
        this.post?.setLetterbox(enabled);
      }
      if (event.code === 'Escape') {
        this.cinematics?.setMode('shot');
      }
    });
  }

  setHud(enabled: boolean): void {
    this.settings.showHud = enabled;
    document.body.classList.toggle('hud-off', !enabled);
  }

  setLetterbox(enabled: boolean): void {
    this.settings.letterbox = enabled;
    this.post?.setLetterbox(enabled);
  }

  setShot(id: string): void {
    this.cinematics?.setShot(id, true);
    this.updateStats(performance.now());
  }

  setCinematic(time = 0): void {
    this.cinematics?.setCinematic(time);
    this.elapsed = time;
    this.paused = false;
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    this.lastFrameTime = performance.now();
  }

  setExposure(value: number): void {
    this.post?.setExposure(value);
  }

  setBloom(value: number): void {
    this.post?.setBloom(value);
  }

  private exposeApi(): void {
    const api: PoolApi = {
      renderAt: (time: number) => this.renderAt(time),
      setShot: (id: string) => this.setShot(id),
      setCinematic: (time = 0) => this.setCinematic(time),
      setPaused: (paused: boolean) => this.setPaused(paused),
      setLetterbox: (enabled: boolean) => this.setLetterbox(enabled),
      setHud: (enabled: boolean) => this.setHud(enabled),
      setExposure: (value: number) => this.setExposure(value),
      setBloom: (value: number) => this.setBloom(value),
      getStats: () => ({
        fps: this.fps,
        frame: this.frameCount,
        mode: this.cinematics?.currentMode ?? 'init',
        shot: this.cinematics?.currentShot.id ?? '',
        drawCalls: this.renderer.info.render.calls,
        triangles: this.renderer.info.render.triangles,
      }),
      camera: this.camera,
      scene: this.scene,
      renderer: this.renderer,
      time: () => this.elapsed,
    };
    window.__pool = api;
  }
}
