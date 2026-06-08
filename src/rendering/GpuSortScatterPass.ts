import { StorageBuffer } from "@babylonjs/core/Buffers/storageBuffer";
import { ComputeShader } from "@babylonjs/core/Compute/computeShader";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader";
import type { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import type { Scene } from "@babylonjs/core/scene";

import { canCreateComputeShader } from "./GpuDepthKeyPass";

const WORKGROUP_SIZE = 256;
const BUCKET_COUNT = 2048;

const SCATTER_SOURCE = `
@group(0) @binding(0) var<storage, read> depthKeyBuffer: array<u32>;
@group(0) @binding(1) var<storage, read_write> bucketOffsets: array<atomic<u32>>;
@group(0) @binding(2) var<storage, read_write> outputIndices: array<u32>;
@group(0) @binding(3) var<storage, read> paramsBuffer: array<u32>;

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) globalId: vec3u) {
  let splatIndex = globalId.x;
  let splatCount = paramsBuffer[0];
  if (splatIndex >= splatCount) {
    return;
  }

  let bucketCount = paramsBuffer[1];
  let bucketShift = paramsBuffer[2];
  let bucket = min(depthKeyBuffer[splatIndex] >> bucketShift, bucketCount - 1u);
  let dst = atomicAdd(&bucketOffsets[bucket], 1u);
  outputIndices[dst] = splatIndex;
}
`;

type GpuSortScatterStats = {
  enabled: boolean;
  dispatched: boolean;
  lastDispatchMs: number;
  lastDispatchSplats: number;
  bucketCount: number;
};

class GpuSortScatterPass {
  private readonly shader: ComputeShader;
  private readonly params: StorageBuffer;
  private readonly paramsData = new Uint32Array(4);
  private lastDispatchMs = 0;
  private lastDispatchSplats = 0;

  constructor(
    scene: Scene,
    private readonly depthKeyBuffer: StorageBuffer,
    private readonly bucketOffsets: StorageBuffer,
    private readonly outputIndices: StorageBuffer,
    private readonly splatCount: number,
    private readonly bucketCount = BUCKET_COUNT,
  ) {
    const engine = scene.getEngine() as WebGPUEngine;
    this.params = new StorageBuffer(engine, this.paramsData.byteLength, undefined, "GpuSortScatterParams");
    this.shader = new ComputeShader(
      "GpuSortScatter",
      engine,
      { computeSource: SCATTER_SOURCE },
      {
        bindingsMapping: {
          depthKeyBuffer: { group: 0, binding: 0 },
          bucketOffsets: { group: 0, binding: 1 },
          outputIndices: { group: 0, binding: 2 },
          paramsBuffer: { group: 0, binding: 3 },
        },
      },
    );
    this.shader.setStorageBuffer("depthKeyBuffer", this.depthKeyBuffer);
    this.shader.setStorageBuffer("bucketOffsets", this.bucketOffsets);
    this.shader.setStorageBuffer("outputIndices", this.outputIndices);
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
    this.paramsData[0] = this.splatCount;
    this.paramsData[1] = this.bucketCount;
    this.paramsData[2] = Math.max(0, 32 - Math.ceil(Math.log2(this.bucketCount)));
    this.paramsData[3] = 0;
    this.params.update(this.paramsData);

    const dispatched = this.shader.dispatch(Math.ceil(this.splatCount / WORKGROUP_SIZE));
    if (dispatched) {
      this.lastDispatchMs = performance.now() - start;
      this.lastDispatchSplats = this.splatCount;
    }
    return dispatched;
  }

  getStats(): GpuSortScatterStats {
    return {
      enabled: true,
      dispatched: this.lastDispatchSplats > 0,
      lastDispatchMs: this.lastDispatchMs,
      lastDispatchSplats: this.lastDispatchSplats,
      bucketCount: this.bucketCount,
    };
  }
}

export { GpuSortScatterPass };
export type { GpuSortScatterStats };
