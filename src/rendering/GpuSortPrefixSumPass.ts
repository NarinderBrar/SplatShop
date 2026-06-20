import { StorageBuffer } from "@babylonjs/core/Buffers/storageBuffer";
import { ComputeShader } from "@babylonjs/core/Compute/computeShader";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader";
import type { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import type { Scene } from "@babylonjs/core/scene";

import { canCreateComputeShader } from "./GpuDepthKeyPass";
import GpuSortPrefixSumPass_PREFIX_SUM_SOURCE_raw from "./shaders/gpu-sort-prefix-sum-pass.prefix-sum-source.wgsl?raw";

const WORKGROUP_SIZE = 256;
const BUCKET_COUNT = 2048;

const PREFIX_SUM_SOURCE = GpuSortPrefixSumPass_PREFIX_SUM_SOURCE_raw.replaceAll("__PREFIX_SUM_SOURCE_EXPR_0__", String(BUCKET_COUNT)).replaceAll("__PREFIX_SUM_SOURCE_EXPR_1__", String(BUCKET_COUNT)).replaceAll("__PREFIX_SUM_SOURCE_EXPR_2__", String(WORKGROUP_SIZE)).replaceAll("__PREFIX_SUM_SOURCE_EXPR_3__", String(WORKGROUP_SIZE)).replaceAll("__PREFIX_SUM_SOURCE_EXPR_4__", String(WORKGROUP_SIZE)).replaceAll("__PREFIX_SUM_SOURCE_EXPR_5__", String(WORKGROUP_SIZE)).replaceAll("__PREFIX_SUM_SOURCE_EXPR_6__", String(WORKGROUP_SIZE));

type GpuSortPrefixSumStats = {
  enabled: boolean;
  dispatched: boolean;
  lastDispatchMs: number;
  bucketCount: number;
};

class GpuSortPrefixSumPass {
  private readonly shader: ComputeShader;
  private readonly params: StorageBuffer;
  private readonly paramsData = new Uint32Array(4);
  private lastDispatchMs = 0;
  private dispatched = false;

  constructor(
    scene: Scene,
    private readonly bucketCounts: StorageBuffer,
    private readonly bucketOffsets: StorageBuffer,
    private readonly bucketCount = BUCKET_COUNT,
  ) {
    const engine = scene.getEngine() as WebGPUEngine;
    this.params = new StorageBuffer(engine, this.paramsData.byteLength, undefined, "GpuSortPrefixSumParams");
    this.shader = new ComputeShader(
      "GpuSortPrefixSum",
      engine,
      { computeSource: PREFIX_SUM_SOURCE },
      {
        bindingsMapping: {
          bucketCounts: { group: 0, binding: 0 },
          bucketOffsets: { group: 0, binding: 1 },
          paramsBuffer: { group: 0, binding: 2 },
        },
      },
    );
    this.shader.setStorageBuffer("bucketCounts", this.bucketCounts);
    this.shader.setStorageBuffer("bucketOffsets", this.bucketOffsets);
    this.shader.setStorageBuffer("paramsBuffer", this.params);
  }

  static isSupported(scene: Scene): boolean {
    return canCreateComputeShader(scene);
  }

  dispose(): void {
    this.params.dispose();
  }

  dispatch(): boolean {
    const start = performance.now();
    this.paramsData[0] = this.bucketCount;
    this.paramsData[1] = 0;
    this.paramsData[2] = 0;
    this.paramsData[3] = 0;
    this.params.update(this.paramsData);

    const dispatched = this.shader.dispatch(1);
    if (dispatched) {
      this.lastDispatchMs = performance.now() - start;
      this.dispatched = true;
    }
    return dispatched;
  }

  getStats(): GpuSortPrefixSumStats {
    return {
      enabled: true,
      dispatched: this.dispatched,
      lastDispatchMs: this.lastDispatchMs,
      bucketCount: this.bucketCount,
    };
  }
}

export { GpuSortPrefixSumPass };
export type { GpuSortPrefixSumStats };
