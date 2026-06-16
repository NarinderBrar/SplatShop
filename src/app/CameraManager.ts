import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { Vector3 } from "@babylonjs/core/Maths/math";
import type { Scene } from "@babylonjs/core/scene";

import type { SplatCloud } from "../splat/SplatCloud";

const DEFAULT_CAMERA_RADIUS_SCALE = 0.72;
const MIN_RADIUS_SCALE = 0.035;
const MIN_RADIUS_FALLBACK = 0.08;
const TARGET_SCROLL_STEP_SCALE = 0.035;

const getViewerUpVector = (): Vector3 => {
  const value = new URLSearchParams(window.location.search).get("up");
  return value === "y" || value === "positiveY" ? Vector3.Up() : Vector3.Down();
};

class CameraManager {
  readonly camera: ArcRotateCamera;

  private sceneRadius = 1;
  private readonly wheelListener: (event: WheelEvent) => void;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    scene: Scene,
  ) {
    this.camera = new ArcRotateCamera(
      "MainCamera",
      Math.PI * 0.25,
      Math.PI * 0.45,
      6,
      Vector3.Zero(),
      scene,
    );
    this.camera.upVector = getViewerUpVector();
    this.camera.attachControl(canvas, true);
    this.camera.minZ = 0.01;
    this.camera.wheelPrecision = 45;
    this.camera.lowerRadiusLimit = MIN_RADIUS_FALLBACK;

    this.wheelListener = (event) => this.handleWheel(event);
    canvas.addEventListener("wheel", this.wheelListener, { passive: false });
  }

  dispose(): void {
    this.canvas.removeEventListener("wheel", this.wheelListener);
  }

  frameCloud(splatCloud: SplatCloud): void {
    const framing = splatCloud.getCenterAndRadius();
    if (!framing) {
      return;
    }

    this.sceneRadius = Math.max(framing.radius, MIN_RADIUS_FALLBACK);
    this.camera.setTarget(framing.center);
    this.camera.radius = Math.max(this.sceneRadius * DEFAULT_CAMERA_RADIUS_SCALE, 0.35);
    this.camera.lowerRadiusLimit = Math.max(this.sceneRadius * MIN_RADIUS_SCALE, MIN_RADIUS_FALLBACK);
  }

  getViewProjectionArray(): Float32Array {
    return new Float32Array(this.camera.getTransformationMatrix().toArray());
  }

  private handleWheel(event: WheelEvent): void {
    if (event.deltaY >= 0) {
      return;
    }

    const lowerLimit = this.camera.lowerRadiusLimit ?? MIN_RADIUS_FALLBACK;
    if (this.camera.radius > lowerLimit * 1.12) {
      return;
    }

    const step = Math.max(this.sceneRadius * TARGET_SCROLL_STEP_SCALE, lowerLimit * 0.5);
    const forward = this.camera.getDirection(Vector3.Forward()).normalize();
    const target = this.camera.getTarget().addInPlace(forward.scale(step));
    this.camera.setTarget(target);
    this.camera.radius = lowerLimit;
    event.preventDefault();
  }
}

export { CameraManager };
