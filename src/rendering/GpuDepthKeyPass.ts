import { StorageBuffer } from "@babylonjs/core/Buffers/storageBuffer";
import { ComputeShader } from "@babylonjs/core/Compute/computeShader";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader";
import type { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import type { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Scene } from "@babylonjs/core/scene";
import GpuDepthKeyPass_COMPUTE_SOURCE_raw from "./shaders/gpu-depth-key-pass.compute-source.wgsl?raw";

const WORKGROUP_SIZE = 256;

const COMPUTE_SOURCE = GpuDepthKeyPass_COMPUTE_SOURCE_raw.replaceAll("__COMPUTE_SOURCE_EXPR_0__", String(WORKGROUP_SIZE));

type GpuDepthKeyStats = {
  enabled: boolean;
  dispatched: boolean;
  lastDispatchMs: number;
  lastDispatchSplats: number;
};

type ComputeCapableEngine = WebGPUEngine & {
  createComputeContext?: () => unknown;
  createComputeEffect?: (...args: unknown[]) => unknown;
  computeDispatch?: (...args: unknown[]) => unknown;
};

const canCreateComputeShader = (scene: Scene): boolean => {
  const engine = scene.getEngine() as ComputeCapableEngine;
  return (
    engine.isWebGPU &&
    !!engine.getCaps().supportComputeShaders &&
    typeof engine.createComputeContext === "function" &&
    typeof engine.createComputeEffect === "function" &&
    typeof engine.computeDispatch === "function"
  );
};

class GpuDepthKeyPass {
  private readonly shader: ComputeShader;
  private readonly params: StorageBuffer;
  private readonly paramsData = new Float32Array(13);
  private lastDispatchMs = 0;
  private lastDispatchSplats = 0;

  constructor(
    scene: Scene,
    private readonly centerBuffer: StorageBuffer,
    private readonly depthKeyBuffer: StorageBuffer,
    private readonly splatCount: number,
    private readonly boundsMin: readonly [number, number, number],
    private readonly boundsMax: readonly [number, number, number],
    private readonly keyBits = 20,
    private readonly centerOffset = 0,
  ) {
    const engine = scene.getEngine() as WebGPUEngine;
    this.params = new StorageBuffer(engine, this.paramsData.byteLength, undefined, "GpuDepthKeyParams");
    this.shader = new ComputeShader(
      "GpuDepthKeyPass",
      engine,
      { computeSource: COMPUTE_SOURCE },
      {
        bindingsMapping: {
          centerBuffer: { group: 0, binding: 0 },
          depthKeyBuffer: { group: 0, binding: 1 },
          paramsBuffer: { group: 0, binding: 2 },
        },
      },
    );
    this.shader.setStorageBuffer("centerBuffer", this.centerBuffer);
    this.shader.setStorageBuffer("depthKeyBuffer", this.depthKeyBuffer);
    this.shader.setStorageBuffer("paramsBuffer", this.params);
  }

  dispose(): void {
    this.params.dispose();
  }

  dispatch(cameraPosition: Vector3, cameraForward: Vector3): boolean {
    const start = performance.now();
    const minDepth = this.projectBounds(cameraPosition, cameraForward, Math.min);
    const maxDepth = this.projectBounds(cameraPosition, cameraForward, Math.max);
    const invDepthRange = maxDepth - minDepth > 1e-6 ? 1 / (maxDepth - minDepth) : 0;

    this.paramsData[0] = cameraPosition.x;
    this.paramsData[1] = cameraPosition.y;
    this.paramsData[2] = cameraPosition.z;
    this.paramsData[3] = 0;
    this.paramsData[4] = cameraForward.x;
    this.paramsData[5] = cameraForward.y;
    this.paramsData[6] = cameraForward.z;
    this.paramsData[7] = 0;
    this.paramsData[8] = this.splatCount;
    this.paramsData[9] = minDepth;
    this.paramsData[10] = invDepthRange;
    this.paramsData[11] = 2 ** this.keyBits - 1;
    this.paramsData[12] = this.centerOffset;
    this.params.update(this.paramsData);

    const dispatched = this.shader.dispatch(Math.ceil(this.splatCount / WORKGROUP_SIZE));
    if (dispatched) {
      this.lastDispatchMs = performance.now() - start;
      this.lastDispatchSplats = this.splatCount;
    }
    return dispatched;
  }

  getStats(): GpuDepthKeyStats {
    return {
      enabled: true,
      dispatched: this.lastDispatchSplats > 0,
      lastDispatchMs: this.lastDispatchMs,
      lastDispatchSplats: this.lastDispatchSplats,
    };
  }

  private projectBounds(
    cameraPosition: Vector3,
    cameraForward: Vector3,
    reduce: (...values: number[]) => number,
  ): number {
    const values: number[] = [];
    for (const x of [this.boundsMin[0], this.boundsMax[0]]) {
      for (const y of [this.boundsMin[1], this.boundsMax[1]]) {
        for (const z of [this.boundsMin[2], this.boundsMax[2]]) {
          values.push(
            (x - cameraPosition.x) * cameraForward.x +
              (y - cameraPosition.y) * cameraForward.y +
              (z - cameraPosition.z) * cameraForward.z,
          );
        }
      }
    }
    return reduce(...values);
  }
}

export { GpuDepthKeyPass, canCreateComputeShader };
export type { GpuDepthKeyStats };
