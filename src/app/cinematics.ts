import { Euler, MathUtils, PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { CINEMATIC_DURATION, CINEMATIC_KEYS, getShot, SHOTS, type CameraShot } from '../world/layout';
import { easeInOutQuint, clamp } from '../core/math';
import { createClosedCameraPath, type CameraPath } from './cameraPath';

export type CameraMode = 'cinematic' | 'shot' | 'free';

interface ShotState {
  position: Vector3;
  target: Vector3;
  fov: number;
  roll: number;
}

interface Transition {
  from: ShotState;
  to: ShotState;
  elapsed: number;
  duration: number;
}

/**
 * Roll for the guided take. The period matches the loop so the wrap does not
 * introduce a jump in the horizon; the amplitude is deliberately tiny (< 0.15°).
 */
const cinematicRoll = (time: number): number => Math.sin((time / CINEMATIC_DURATION) * Math.PI * 2) * 0.0025;

export class Cinematics {
  private readonly camera: PerspectiveCamera;
  private readonly path: CameraPath;
  private mode: CameraMode = 'cinematic';
  private transition: Transition | null = null;
  private current: ShotState;
  private cinematicTime = 0;
  private shot: CameraShot = SHOTS[0]!;
  private freeYaw = 0;
  private freePitch = 0;
  private freePosition = new Vector3();
  private keys = new Set<string>();
  private pointerLocked = false;
  private freeEnabled = false;
  private readonly canvas: HTMLCanvasElement;
  private readonly scratchEuler = new Euler(0, 0, 0, 'YXZ');
  private readonly scratchForward = new Vector3();
  private readonly scratchRight = new Vector3();

  constructor(camera: PerspectiveCamera, canvas: HTMLCanvasElement) {
    this.camera = camera;
    this.canvas = canvas;
    this.path = createClosedCameraPath(CINEMATIC_KEYS, CINEMATIC_DURATION);
    const shot = SHOTS[0]!;
    this.current = {
      position: new Vector3(...shot.position),
      target: new Vector3(...shot.target),
      fov: shot.fov,
      roll: 0,
    };
    this.apply(this.current);

    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('mousemove', this.onMouseMove);
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
    canvas.addEventListener('click', this.onCanvasClick);
  }

  get currentShot(): CameraShot {
    return this.shot;
  }

  get currentMode(): CameraMode {
    return this.mode;
  }

  setMode(mode: CameraMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.transition = null;
    if (mode === 'free') {
      this.enterFreeLook();
    } else {
      this.exitFreeLook();
    }
  }

  setShot(shotId: string, snap = false): void {
    const shot = getShot(shotId);
    if (!shot) return;
    this.shot = shot;
    this.mode = 'shot';
    this.exitFreeLook();
    const next: ShotState = {
      position: new Vector3(...shot.position),
      target: new Vector3(...shot.target),
      fov: shot.fov,
      roll: shot.roll ?? 0,
    };
    if (snap) {
      this.current = next;
      this.transition = null;
      this.apply(next);
      return;
    }
    this.transition = {
      from: {
        position: this.current.position.clone(),
        target: this.current.target.clone(),
        fov: this.current.fov,
        roll: this.current.roll,
      },
      to: next,
      elapsed: 0,
      duration: 1.35,
    };
  }

  setCinematic(time: number): void {
    this.mode = 'cinematic';
    this.transition = null;
    this.exitFreeLook();
    this.cinematicTime = time;
    this.sampleCinematic(time);
  }

  toggleFreeLook(): void {
    if (this.mode === 'free') {
      this.mode = 'shot';
      this.exitFreeLook();
      this.setShot(this.shot.id, false);
      return;
    }
    this.mode = 'free';
    this.transition = null;
    this.enterFreeLook();
  }

  nextShot(direction: number): void {
    const index = SHOTS.findIndex((shot) => shot.id === this.shot.id);
    const next = SHOTS[(index + direction + SHOTS.length) % SHOTS.length]!;
    this.setShot(next.id);
  }

  update(dt: number, elapsed: number): void {
    if (this.mode === 'free') {
      this.updateFreeLook(dt);
      return;
    }
    if (this.mode === 'cinematic') {
      this.cinematicTime = elapsed % CINEMATIC_DURATION;
      this.sampleCinematic(this.cinematicTime);
      return;
    }

    if (this.transition) {
      this.transition.elapsed += dt;
      const t = clamp(this.transition.elapsed / this.transition.duration, 0, 1);
      const eased = easeInOutQuint(t);
      const next: ShotState = {
        position: this.transition.from.position.clone().lerp(this.transition.to.position, eased),
        target: this.transition.from.target.clone().lerp(this.transition.to.target, eased),
        fov: MathUtils.lerp(this.transition.from.fov, this.transition.to.fov, eased),
        roll: MathUtils.lerp(this.transition.from.roll, this.transition.to.roll, eased),
      };
      this.current = next;
      this.apply(next, true);
      if (t >= 1) this.transition = null;
      return;
    }

    // A breath of handheld drift keeps the locked-off shot alive.
    const drift = new Vector3(
      Math.sin(elapsed * 0.21) * 0.008,
      Math.sin(elapsed * 0.27 + 1.1) * 0.007,
      Math.sin(elapsed * 0.17 + 2.4) * 0.008,
    );
    const position = this.current.position.clone().add(drift);
    this.apply(
      {
        position,
        target: this.current.target,
        fov: this.current.fov,
        roll: this.current.roll + Math.sin(elapsed * 0.13) * 0.0015,
      },
      false,
    );
  }

  private sampleCinematic(time: number): void {
    const pose = this.path.sample(time);
    this.current = {
      position: new Vector3(pose.position[0], pose.position[1], pose.position[2]),
      target: new Vector3(pose.target[0], pose.target[1], pose.target[2]),
      fov: pose.fov,
      roll: cinematicRoll(time),
    };
    this.apply(this.current, true);
  }

  private apply(state: ShotState, updateCurrent = false): void {
    if (updateCurrent) this.current = state;
    this.camera.position.copy(state.position);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(state.target);
    if (state.roll !== 0) this.camera.rotateZ(state.roll);
    if (this.camera.fov !== state.fov) {
      this.camera.fov = state.fov;
      this.camera.updateProjectionMatrix();
    }
  }

  private enterFreeLook(): void {
    if (this.freeEnabled) return;
    this.freeEnabled = true;
    this.freePosition.copy(this.camera.position);
    const euler = new Euler().setFromQuaternion(this.camera.quaternion, 'YXZ');
    this.freePitch = euler.x;
    this.freeYaw = euler.y;
    this.canvas.requestPointerLock?.();
  }

  private exitFreeLook(): void {
    if (!this.freeEnabled) return;
    this.freeEnabled = false;
    this.keys.clear();
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
  }

  private updateFreeLook(dt: number): void {
    const euler = this.scratchEuler.set(this.freePitch, this.freeYaw, 0, 'YXZ');
    this.camera.quaternion.setFromEuler(euler);
    this.camera.position.copy(this.freePosition);

    this.scratchForward.set(0, 0, -1).applyEuler(euler);
    this.scratchRight.set(1, 0, 0).applyEuler(euler);
    const speed = (this.keys.has('shiftleft') || this.keys.has('shiftright') ? 4.2 : 1.55) * dt;
    if (this.keys.has('keyw')) this.freePosition.addScaledVector(this.scratchForward, speed);
    if (this.keys.has('keys')) this.freePosition.addScaledVector(this.scratchForward, -speed);
    if (this.keys.has('keyd')) this.freePosition.addScaledVector(this.scratchRight, speed);
    if (this.keys.has('keya')) this.freePosition.addScaledVector(this.scratchRight, -speed);
    if (this.keys.has('keye') || this.keys.has('space')) this.freePosition.y += speed * 0.8;
    if (this.keys.has('keyq') || this.keys.has('controlleft')) this.freePosition.y -= speed * 0.8;

    this.freePosition.x = clamp(this.freePosition.x, -8.1, 8.1);
    this.freePosition.z = clamp(this.freePosition.z, -28.4, 28.4);
    this.freePosition.y = clamp(this.freePosition.y, 0.18, 8.35);
    this.camera.position.copy(this.freePosition);
    if (this.camera.fov !== 58) {
      this.camera.fov = 58;
      this.camera.updateProjectionMatrix();
    }
    this.applyFreeRoll();
  }

  private applyFreeRoll(): void {
    this.camera.rotation.set(this.freePitch, this.freeYaw, 0, 'YXZ');
  }

  private onKeyDown = (event: KeyboardEvent): void => {
    const code = event.code.toLowerCase();
    if (code === 'space') {
      event.preventDefault();
      if (this.mode !== 'free') this.setCinematic(this.cinematicTime || 0);
      return;
    }
    if (code === 'keyf') {
      this.toggleFreeLook();
      return;
    }
    if (this.mode === 'free') this.keys.add(code);
    if (/^digit[1-7]$/.test(code)) {
      const index = Number(code.slice(5)) - 1;
      const shot = SHOTS[index];
      if (shot) this.setShot(shot.id);
    }
    if (code === 'arrowright') this.nextShot(1);
    if (code === 'arrowleft') this.nextShot(-1);
  };

  private onKeyUp = (event: KeyboardEvent): void => {
    this.keys.delete(event.code.toLowerCase());
  };

  private onMouseMove = (event: MouseEvent): void => {
    if (!this.pointerLocked || this.mode !== 'free') return;
    const sensitivity = 0.0019;
    this.freeYaw -= event.movementX * sensitivity;
    this.freePitch = clamp(this.freePitch - event.movementY * sensitivity, -1.45, 1.45);
  };

  private onPointerLockChange = (): void => {
    this.pointerLocked = document.pointerLockElement === this.canvas;
    if (!this.pointerLocked && this.mode === 'free') this.exitFreeLook();
  };

  private onCanvasClick = (): void => {
    if (this.mode === 'free' && !this.pointerLocked) this.canvas.requestPointerLock?.();
    if (this.mode !== 'free' && !this.pointerLocked) {
      // Clicking the image is a quick way back into the guided take.
      this.setCinematic(this.cinematicTime);
    }
  };

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('mousemove', this.onMouseMove);
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
    this.canvas.removeEventListener('click', this.onCanvasClick);
  }
}
