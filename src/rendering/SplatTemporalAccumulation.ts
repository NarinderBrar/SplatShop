import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Scene } from "@babylonjs/core/scene";

type SplatTemporalMode = "off" | "diagnostic" | "jitter";

type SplatTemporalStats = {
  temporalMode: SplatTemporalMode;
  temporalEnabled: boolean;
  temporalStable: boolean;
  temporalStableFrames: number;
  temporalSampleIndex: number;
  temporalMaxSamples: number;
  temporalJitterX: number;
  temporalJitterY: number;
  temporalJitterPixelsX: number;
  temporalJitterPixelsY: number;
  temporalResetCount: number;
  temporalResetReason: string;
};

const getMode = (): SplatTemporalMode => {
  const value = new URLSearchParams(window.location.search).get("temporalAccumulation");
  if (value === "jitter" || value === "true") {
    return "jitter";
  }
  if (value === "diagnostic" || value === "debug") {
    return "diagnostic";
  }
  return "off";
};

const getPositiveNumberParam = (name: string, fallback: number): number => {
  const value = Number(new URLSearchParams(window.location.search).get(name));
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const halton = (index: number, base: number): number => {
  let result = 0;
  let fraction = 1 / base;
  let current = index;
  while (current > 0) {
    result += fraction * (current % base);
    current = Math.floor(current / base);
    fraction /= base;
  }
  return result;
};

class SplatTemporalAccumulation {
  private readonly mode = getMode();
  private readonly stableFrameThreshold = Math.max(1, Math.floor(getPositiveNumberParam("temporalStableFrames", 8)));
  private readonly maxSamples = Math.max(1, Math.floor(getPositiveNumberParam("temporalSamples", 16)));
  private readonly moveEpsilonSq = getPositiveNumberParam("temporalMoveEpsilon", 0.0005) ** 2;
  private readonly angleDotThreshold = Math.cos((getPositiveNumberParam("temporalAngleDegrees", 0.08) * Math.PI) / 180);
  private lastCameraPosition = new Vector3(Number.POSITIVE_INFINITY, 0, 0);
  private lastCameraForward = new Vector3(0, 0, 0);
  private lastWidth = 0;
  private lastHeight = 0;
  private stableFrames = 0;
  private sampleIndex = 0;
  private resetCount = 0;
  private resetReason = "initial";
  private jitterX = 0;
  private jitterY = 0;

  constructor(private readonly scene: Scene) {}

  update(): void {
    const engine = this.scene.getEngine();
    const width = Math.max(1, engine.getRenderWidth(true));
    const height = Math.max(1, engine.getRenderHeight(true));
    const camera = this.scene.activeCamera;
    if (!camera || this.mode === "off") {
      this.reset("disabled");
      this.lastWidth = width;
      this.lastHeight = height;
      return;
    }

    const position = camera.globalPosition;
    const forward = camera.getDirection(Vector3.Forward());
    const initial = !Number.isFinite(this.lastCameraPosition.x);
    const resized = width !== this.lastWidth || height !== this.lastHeight;
    const moved = initial || Vector3.DistanceSquared(position, this.lastCameraPosition) > this.moveEpsilonSq;
    const turned = initial || Vector3.Dot(forward, this.lastCameraForward) < this.angleDotThreshold;
    if (resized || moved || turned) {
      this.reset(resized ? "viewport" : moved ? "camera-move" : "camera-turn");
    } else {
      this.stableFrames++;
      if (this.stableFrames >= this.stableFrameThreshold) {
        this.sampleIndex = (this.sampleIndex % this.maxSamples) + 1;
      }
    }

    this.lastWidth = width;
    this.lastHeight = height;
    this.lastCameraPosition.copyFrom(position);
    this.lastCameraForward.copyFrom(forward);
    const jitterSample = Math.max(1, this.sampleIndex);
    this.jitterX = this.mode === "jitter" ? halton(jitterSample, 2) - 0.5 : 0;
    this.jitterY = this.mode === "jitter" ? halton(jitterSample, 3) - 0.5 : 0;
  }

  getStats(): SplatTemporalStats {
    return {
      temporalMode: this.mode,
      temporalEnabled: this.mode !== "off",
      temporalStable: this.stableFrames >= this.stableFrameThreshold,
      temporalStableFrames: this.stableFrames,
      temporalSampleIndex: this.sampleIndex,
      temporalMaxSamples: this.maxSamples,
      temporalJitterX: this.jitterX,
      temporalJitterY: this.jitterY,
      temporalJitterPixelsX: this.jitterX,
      temporalJitterPixelsY: this.jitterY,
      temporalResetCount: this.resetCount,
      temporalResetReason: this.resetReason,
    };
  }

  private reset(reason: string): void {
    if (this.resetReason !== reason || this.stableFrames > 0 || this.sampleIndex > 0) {
      this.resetCount++;
    }
    this.resetReason = reason;
    this.stableFrames = 0;
    this.sampleIndex = 0;
    this.jitterX = 0;
    this.jitterY = 0;
  }
}

const temporalByScene = new WeakMap<Scene, SplatTemporalAccumulation>();

const getSplatTemporalAccumulation = (scene: Scene): SplatTemporalAccumulation => {
  const existing = temporalByScene.get(scene);
  if (existing) {
    return existing;
  }
  const temporal = new SplatTemporalAccumulation(scene);
  temporalByScene.set(scene, temporal);
  return temporal;
};

export { getSplatTemporalAccumulation };
export type { SplatTemporalStats };
