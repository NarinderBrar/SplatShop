import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import type { Scene } from "@babylonjs/core/scene";

type ReverseDepthMode = "off" | "diagnostic" | "force";

type ReverseDepthStats = {
  reverseDepthRequested: ReverseDepthMode;
  reverseDepthActive: boolean;
  reverseDepthSupported: boolean;
  reverseDepthFallbackReason: string;
  reverseDepthClearValue: number;
  reverseDepthCompare: "less" | "greater";
  reverseDepthNear: number;
  reverseDepthFar: number;
  reverseDepthFarToNearRatio: number;
};

type ReverseDepthContext = {
  passName: string;
  depthWriteDisabled: boolean;
  usesComputeDepthRanges: boolean;
  usesHiZOcclusion?: boolean;
};

type ReverseDepthCapableEngine = AbstractEngine & {
  useReverseDepthBuffer: boolean;
};

const getReverseDepthMode = (): ReverseDepthMode => {
  const value = new URLSearchParams(window.location.search).get("reverseZ");
  if (value === "force") {
    return "force";
  }
  if (value === "true" || value === "diagnostic" || value === "debug") {
    return "diagnostic";
  }
  return "off";
};

const hasReverseDepthSupport = (engine: AbstractEngine): engine is ReverseDepthCapableEngine =>
  "useReverseDepthBuffer" in engine;

const getCameraDepthRange = (scene: Scene): Pick<
  ReverseDepthStats,
  "reverseDepthNear" | "reverseDepthFar" | "reverseDepthFarToNearRatio"
> => {
  const camera = scene.activeCamera;
  const near = Math.max(0, Number(camera?.minZ ?? 0));
  const far = Math.max(near, Number(camera?.maxZ ?? 0));
  return {
    reverseDepthNear: near,
    reverseDepthFar: far,
    reverseDepthFarToNearRatio: near > 0 ? far / near : 0,
  };
};

const describeReverseDepthBlockers = (context: ReverseDepthContext): string => {
  const blockers = [
    context.depthWriteDisabled ? "splat-depth-write-disabled" : "",
    context.usesComputeDepthRanges ? "compute-depth-ranges-use-view-depth" : "",
    context.usesHiZOcclusion ? "ssog-hiz-uses-view-depth-grid" : "",
  ].filter(Boolean);
  return blockers.length > 0 ? `${context.passName}: ${blockers.join(", ")}` : "";
};

const configureReverseDepth = (scene: Scene, context: ReverseDepthContext): ReverseDepthStats => {
  const engine = scene.getEngine();
  const requested = getReverseDepthMode();
  const supported = hasReverseDepthSupport(engine);
  const blockers = describeReverseDepthBlockers(context);

  if (supported && requested === "force") {
    engine.useReverseDepthBuffer = true;
  }

  const active = supported && engine.useReverseDepthBuffer === true;
  const fallbackReason = (() => {
    if (!supported) {
      return "engine-does-not-expose-reverse-depth";
    }
    if (requested === "off") {
      return "";
    }
    if (requested === "diagnostic") {
      return blockers ? `diagnostic-only; ${blockers}` : "diagnostic-only";
    }
    return blockers ? `forced; ${blockers}` : "";
  })();

  return {
    reverseDepthRequested: requested,
    reverseDepthActive: active,
    reverseDepthSupported: supported,
    reverseDepthFallbackReason: fallbackReason,
    reverseDepthClearValue: active ? 0 : 1,
    reverseDepthCompare: active ? "greater" : "less",
    ...getCameraDepthRange(scene),
  };
};

export { configureReverseDepth };
export type { ReverseDepthMode, ReverseDepthStats };
