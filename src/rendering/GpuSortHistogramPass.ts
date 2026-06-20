import { StorageBuffer } from "@babylonjs/core/Buffers/storageBuffer";
import { ComputeShader } from "@babylonjs/core/Compute/computeShader";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader";
import type { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import type { Scene } from "@babylonjs/core/scene";

import { canCreateComputeShader } from "./GpuDepthKeyPass";
import GpuSortHistogramPass_CLEAR_SOURCE_raw from "./shaders/gpu-sort-histogram-pass.clear-source.wgsl?raw";
import GpuSortHistogramPass_HISTOGRAM_SOURCE_raw from "./shaders/gpu-sort-histogram-pass.histogram-source.wgsl?raw";

const WORKGROUP_SIZE = 256;
const DEFAULT_BUCKET_COUNT = 2048;

const CLEAR_SOURCE = GpuSortHistogramPass_CLEAR_SOURCE_raw.replaceAll("__CLEAR_SOURCE_EXPR_0__", String(WORKGROUP_SIZE));

const HISTOGRAM_SOURCE = GpuSortHistogramPass_HISTOGRAM_SOURCE_raw.replaceAll("__HISTOGRAM_SOURCE_EXPR_0__", String(WORKGROUP_SIZE));

type GpuSortHistogramStats = {
  enabled: boolean;
  dispatched: boolean;
  lastDispatchMs: number;
  lastDispatchSplats: number;
  bucketCount: number;
};

class GpuSortHistogramPass {
  private readonly clearShader: ComputeShader;
  private readonly histogramShader: ComputeShader;
  private readonly params: StorageBuffer;
  private readonly paramsData = new Uint32Array(4);
  private lastDispatchMs = 0;
  private lastDispatchSplats = 0;

  constructor(
    scene: Scene,
    private readonly depthKeyBuffer: StorageBuffer,
    private readonly bucketCounts: StorageBuffer,
    private readonly splatCount: number,
    private readonly bucketCount = DEFAULT_BUCKET_COUNT,
    private readonly keyBits = 20,
  ) {
    const engine = scene.getEngine() as WebGPUEngine;
    this.params = new StorageBuffer(engine, this.paramsData.byteLength, undefined, "GpuSortHistogramParams");
    this.clearShader = new ComputeShader(
      "GpuSortHistogramClear",
      engine,
      { computeSource: CLEAR_SOURCE },
      {
        bindingsMapping: {
          bucketCounts: { group: 0, binding: 0 },
          paramsBuffer: { group: 0, binding: 1 },
        },
      },
    );
    this.histogramShader = new ComputeShader(
      "GpuSortHistogramBuild",
      engine,
      { computeSource: HISTOGRAM_SOURCE },
      {
        bindingsMapping: {
          depthKeyBuffer: { group: 0, binding: 0 },
          bucketCounts: { group: 0, binding: 1 },
          paramsBuffer: { group: 0, binding: 2 },
        },
      },
    );

    this.clearShader.setStorageBuffer("bucketCounts", this.bucketCounts);
    this.clearShader.setStorageBuffer("paramsBuffer", this.params);
    this.histogramShader.setStorageBuffer("depthKeyBuffer", this.depthKeyBuffer);
    this.histogramShader.setStorageBuffer("bucketCounts", this.bucketCounts);
    this.histogramShader.setStorageBuffer("paramsBuffer", this.params);
  }

  static isSupported(scene: Scene): boolean {
    return canCreateComputeShader(scene);
  }

  dispose(): void {
    this.params.dispose();
  }

  dispatch(): boolean {
    const start = performance.now();
    this.paramsData[0] = this.splatCount;
    this.paramsData[1] = this.bucketCount;
    this.paramsData[2] = Math.max(0, this.keyBits - Math.ceil(Math.log2(this.bucketCount)));
    this.paramsData[3] = 0;
    this.params.update(this.paramsData);

    const cleared = this.clearShader.dispatch(Math.ceil(this.bucketCount / WORKGROUP_SIZE));
    const counted = this.histogramShader.dispatch(Math.ceil(this.splatCount / WORKGROUP_SIZE));
    if (cleared && counted) {
      this.lastDispatchMs = performance.now() - start;
      this.lastDispatchSplats = this.splatCount;
    }
    return cleared && counted;
  }

  getStats(): GpuSortHistogramStats {
    return {
      enabled: true,
      dispatched: this.lastDispatchSplats > 0,
      lastDispatchMs: this.lastDispatchMs,
      lastDispatchSplats: this.lastDispatchSplats,
      bucketCount: this.bucketCount,
    };
  }
}

export { GpuSortHistogramPass };
export type { GpuSortHistogramStats };
