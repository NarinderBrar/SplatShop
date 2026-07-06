import { Constants } from "@babylonjs/core/Engines/constants";
import { MultiRenderTarget } from "@babylonjs/core/Materials/Textures/multiRenderTarget";
import type { Scene } from "@babylonjs/core/scene";

type SplatFrameTargetMode = "off" | "diagnostic" | "allocate";

type SplatFrameTargetAttachment = "color" | "motion" | "selection" | "revealage";

type SplatFrameTargetStats = {
  frameTargetsMode: SplatFrameTargetMode;
  frameTargetsSupported: boolean;
  frameTargetsAllocated: boolean;
  frameTargetsWidth: number;
  frameTargetsHeight: number;
  frameTargetsScale: number;
  frameTargetsAttachments: string;
  frameTargetsHasDepth: boolean;
  frameTargetsSamples: number;
  frameTargetsVersion: number;
  frameTargetsFallbackReason: string;
};

const ATTACHMENTS: SplatFrameTargetAttachment[] = ["color", "motion", "selection", "revealage"];

const getMode = (): SplatFrameTargetMode => {
  const value = new URLSearchParams(window.location.search).get("mrtTargets");
  if (value === "allocate" || value === "true") {
    return "allocate";
  }
  if (value === "diagnostic" || value === "debug") {
    return "diagnostic";
  }
  return "off";
};

const getScale = (): number => {
  const value = Number(new URLSearchParams(window.location.search).get("mrtTargetScale"));
  return Number.isFinite(value) && value > 0 ? Math.max(0.1, Math.min(1, value)) : 1;
};

const getSamples = (): number => {
  const value = Number(new URLSearchParams(window.location.search).get("mrtTargetSamples"));
  return Number.isFinite(value) && value > 0 ? Math.max(1, Math.min(4, Math.floor(value))) : 1;
};

class SplatFrameTargets {
  private readonly mode = getMode();
  private readonly scale = getScale();
  private readonly samples = getSamples();
  private target?: MultiRenderTarget;
  private width = 0;
  private height = 0;
  private version = 0;
  private fallbackReason = "";

  constructor(private readonly scene: Scene) {}

  update(): void {
    const engine = this.scene.getEngine();
    const width = Math.max(1, Math.floor(engine.getRenderWidth(true) * this.scale));
    const height = Math.max(1, Math.floor(engine.getRenderHeight(true) * this.scale));
    if (this.mode !== "allocate") {
      this.width = width;
      this.height = height;
      this.fallbackReason = this.mode === "off" ? "" : "diagnostic-only";
      return;
    }
    if (!engine.isWebGPU) {
      this.disposeTarget();
      this.width = width;
      this.height = height;
      this.fallbackReason = "webgpu-required";
      return;
    }
    if (this.target && this.width === width && this.height === height) {
      return;
    }

    this.disposeTarget();
    this.width = width;
    this.height = height;
    try {
      this.target = new MultiRenderTarget(
        "SplatFrameTargets",
        { width, height },
        ATTACHMENTS.length,
        this.scene,
        {
          generateMipMaps: false,
          generateDepthBuffer: true,
          generateDepthTexture: true,
          generateStencilBuffer: false,
          textureCount: ATTACHMENTS.length,
          types: [
            Constants.TEXTURETYPE_HALF_FLOAT,
            Constants.TEXTURETYPE_HALF_FLOAT,
            Constants.TEXTURETYPE_UNSIGNED_INTEGER,
            Constants.TEXTURETYPE_HALF_FLOAT,
          ],
          formats: [
            Constants.TEXTUREFORMAT_RGBA,
            Constants.TEXTUREFORMAT_RG,
            Constants.TEXTUREFORMAT_RED_INTEGER,
            Constants.TEXTUREFORMAT_RGBA,
          ],
          samplingModes: [
            Constants.TEXTURE_NEAREST_SAMPLINGMODE,
            Constants.TEXTURE_NEAREST_SAMPLINGMODE,
            Constants.TEXTURE_NEAREST_SAMPLINGMODE,
            Constants.TEXTURE_NEAREST_SAMPLINGMODE,
          ],
          drawOnlyOnFirstAttachmentByDefault: false,
          samples: this.samples,
          label: "SplatFrameTargets",
          depthTextureFormat: Constants.TEXTUREFORMAT_DEPTH32_FLOAT,
        },
        ATTACHMENTS.map((attachment) => `SplatFrameTargets.${attachment}`),
      );
      this.target.renderList = [];
      this.fallbackReason = this.target.isSupported ? "" : "mrt-unsupported";
      this.version++;
    } catch (error) {
      this.disposeTarget();
      this.fallbackReason = error instanceof Error ? error.message : "mrt-allocation-failed";
    }
  }

  dispose(): void {
    this.disposeTarget();
  }

  getStats(): SplatFrameTargetStats {
    return {
      frameTargetsMode: this.mode,
      frameTargetsSupported: this.mode !== "allocate" || this.target?.isSupported === true,
      frameTargetsAllocated: !!this.target && this.fallbackReason.length === 0,
      frameTargetsWidth: this.width,
      frameTargetsHeight: this.height,
      frameTargetsScale: this.scale,
      frameTargetsAttachments: ATTACHMENTS.join(","),
      frameTargetsHasDepth: !!this.target?.depthTexture,
      frameTargetsSamples: this.samples,
      frameTargetsVersion: this.version,
      frameTargetsFallbackReason: this.fallbackReason,
    };
  }

  private disposeTarget(): void {
    this.target?.dispose();
    this.target = undefined;
  }
}

const targetsByScene = new WeakMap<Scene, SplatFrameTargets>();

const getSplatFrameTargets = (scene: Scene): SplatFrameTargets => {
  const existing = targetsByScene.get(scene);
  if (existing) {
    return existing;
  }
  const targets = new SplatFrameTargets(scene);
  targetsByScene.set(scene, targets);
  return targets;
};

export { getSplatFrameTargets };
export type { SplatFrameTargetStats };
