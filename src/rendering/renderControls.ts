import type { Scene } from "@babylonjs/core/scene";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader";

type SortMode = "auto" | "continuous" | "static";
type GpuSortMode = "off" | "shadow" | "active" | "coarse";
type GpuSortVisibleMode = "cpu" | "auto" | "radix" | "coarse";
type RequestedRendererMode = "auto" | "cpu" | "gpu" | "compute";
type EffectiveRendererMode = "cpu" | "gpu" | "compute";

type RendererBackend = {
  requested: RequestedRendererMode;
  effective: EffectiveRendererMode;
  fallbackReason: string;
};

const getQueryParams = (): URLSearchParams => new URLSearchParams(window.location.search);

const getPositiveNumberParam = (name: string, fallback: number): number => {
  const value = Number(getQueryParams().get(name));
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const getSortMode = (): SortMode => {
  const value = getQueryParams().get("sort");
  return value === "continuous" || value === "static" ? value : "auto";
};

const getRequestedRendererMode = (): RequestedRendererMode => {
  const value = getQueryParams().get("renderer");
  return value === "cpu" || value === "gpu" || value === "compute" ? value : "auto";
};

const getGpuSortMode = (): GpuSortMode => {
  const params = getQueryParams();
  const value = params.get("gpuSort");
  if (value === "off" || value === "active" || value === "coarse") {
    return value;
  }

  const requested = getRequestedRendererMode();
  return requested === "gpu" || requested === "compute" ? "active" : "shadow";
};

const getGpuSortVisibleMode = (): GpuSortVisibleMode => {
  const params = getQueryParams();
  const value = params.get("gpuSortVisible");
  if (value === "auto" || value === "radix" || value === "coarse") {
    return value;
  }
  const requested = getRequestedRendererMode();
  if (params.get("gpuSort") === "active" || requested === "gpu" || requested === "compute") {
    return "auto";
  }
  return "cpu";
};

const resolveRendererBackend = (scene: Scene): RendererBackend => {
  const requested = getRequestedRendererMode();
  const engine = scene.getEngine() as typeof scene extends Scene
    ? ReturnType<Scene["getEngine"]> & {
        createComputeContext?: () => unknown;
        createComputeEffect?: (...args: unknown[]) => unknown;
        computeDispatch?: (...args: unknown[]) => unknown;
      }
    : never;
  const supportsCompute =
    engine.isWebGPU &&
    !!engine.getCaps().supportComputeShaders &&
    typeof engine.createComputeContext === "function" &&
    typeof engine.createComputeEffect === "function" &&
    typeof engine.computeDispatch === "function";

  if (requested === "cpu") {
    return { requested, effective: "cpu", fallbackReason: "" };
  }

  if (requested === "auto") {
    return {
      requested,
      effective: "cpu",
      fallbackReason: supportsCompute ? "auto-kept-cpu-until-gpu-validation" : "webgpu-compute-unavailable",
    };
  }

  if (!supportsCompute) {
    return {
      requested,
      effective: "cpu",
      fallbackReason: "webgpu-compute-unavailable",
    };
  }

  return {
    requested,
    effective: requested === "compute" ? "compute" : "gpu",
    fallbackReason: requested === "compute" ? "compute-raster-scaffold" : "",
  };
};

const getSortIntervalFrames = (): number => Math.max(1, Math.floor(getPositiveNumberParam("sortInterval", 6)));

const getGpuSortIntervalFrames = (): number => Math.max(1, Math.floor(getPositiveNumberParam("gpuSortInterval", 30)));

const getSortMoveEpsilonSq = (): number => {
  const epsilon = getPositiveNumberParam("sortMoveEpsilon", 0.01);
  return epsilon * epsilon;
};

const getSortForwardDotThreshold = (): number => {
  const degrees = getPositiveNumberParam("sortAngleDegrees", 0.25);
  return Math.cos((degrees * Math.PI) / 180);
};

export {
  getPositiveNumberParam,
  getGpuSortMode,
  getGpuSortVisibleMode,
  getRequestedRendererMode,
  getGpuSortIntervalFrames,
  getSortForwardDotThreshold,
  getSortIntervalFrames,
  getSortMode,
  getSortMoveEpsilonSq,
  resolveRendererBackend,
};
export type { EffectiveRendererMode, RendererBackend, RequestedRendererMode, SortMode };
export type { GpuSortMode, GpuSortVisibleMode };
