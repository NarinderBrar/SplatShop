import { Engine } from "@babylonjs/core/Engines/engine";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";

import { getSplatShaderQualityProfile } from "./qualityProfiles";
import { installWebGpuErrorDedupe } from "./RenderDiagnostics";

type EngineResult = {
  engine: Engine | WebGPUEngine;
  mode: "WebGPU" | "WebGL";
};

async function createWebGpuDeviceDescriptor(): Promise<GPUDeviceDescriptor | undefined> {
  try {
    const adapter = await navigator.gpu?.requestAdapter();
    const maxStorageBuffersPerShaderStage = adapter?.limits.maxStorageBuffersPerShaderStage ?? 0;

    if (maxStorageBuffersPerShaderStage >= 16) {
      return {
        requiredLimits: {
          maxStorageBuffersPerShaderStage: 16,
        },
      };
    }
  } catch {
    // Babylon can still attempt WebGPU initialization with the default limits.
  }

  return undefined;
}

export async function createEngine(canvas: HTMLCanvasElement): Promise<EngineResult> {
  const applyQualityPixelRatioCap = (engine: Engine | WebGPUEngine): void => {
    const maxDevicePixelRatio = getSplatShaderQualityProfile().maxDevicePixelRatio;
    const targetDevicePixelRatio = Math.min(window.devicePixelRatio || 1, maxDevicePixelRatio);
    engine.setHardwareScalingLevel(1 / Math.max(1, targetDevicePixelRatio));
  };

  if (await WebGPUEngine.IsSupportedAsync) {
    const deviceDescriptor = await createWebGpuDeviceDescriptor();
    const engine = new WebGPUEngine(canvas, {
      adaptToDeviceRatio: true,
      antialias: false,
      ...(deviceDescriptor ? { deviceDescriptor } : {}),
    });

    await engine.initAsync();
    applyQualityPixelRatioCap(engine);
    installWebGpuErrorDedupe(engine);
    return { engine, mode: "WebGPU" };
  }

  const engine = new Engine(canvas, false, {
    adaptToDeviceRatio: true,
    antialias: false,
    preserveDrawingBuffer: false,
    stencil: true,
  });
  applyQualityPixelRatioCap(engine);

  return { engine, mode: "WebGL" };
}
