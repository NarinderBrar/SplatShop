import { StorageBuffer } from "@babylonjs/core/Buffers/storageBuffer";
import { ComputeShader } from "@babylonjs/core/Compute/computeShader";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader";
import type { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import type { Scene } from "@babylonjs/core/scene";

import { canCreateComputeShader } from "./GpuDepthKeyPass";

const WORKGROUP_SIZE = 256;
const BUCKET_COUNT = 2048;

const PREFIX_SUM_SOURCE = `
@group(0) @binding(0) var<storage, read> bucketCounts: array<u32>;
@group(0) @binding(1) var<storage, read_write> bucketOffsets: array<u32>;
@group(0) @binding(2) var<storage, read> paramsBuffer: array<u32>;

var<workgroup> scanValues: array<u32, ${BUCKET_COUNT}>;
var<workgroup> nextValues: array<u32, ${BUCKET_COUNT}>;

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(local_invocation_id) localId: vec3u) {
  let threadIndex = localId.x;
  let bucketCount = paramsBuffer[0];

  var index = threadIndex;
  loop {
    if (index >= bucketCount) {
      break;
    }
    scanValues[index] = bucketCounts[index];
    index = index + ${WORKGROUP_SIZE}u;
  }
  workgroupBarrier();

  var offset = 1u;
  loop {
    if (offset >= bucketCount) {
      break;
    }

    index = threadIndex;
    loop {
      if (index >= bucketCount) {
        break;
      }

      var value = scanValues[index];
      if (index >= offset) {
        value = value + scanValues[index - offset];
      }
      nextValues[index] = value;
      index = index + ${WORKGROUP_SIZE}u;
    }
    workgroupBarrier();

    index = threadIndex;
    loop {
      if (index >= bucketCount) {
        break;
      }
      scanValues[index] = nextValues[index];
      index = index + ${WORKGROUP_SIZE}u;
    }
    workgroupBarrier();

    offset = offset << 1u;
  }

  index = threadIndex;
  loop {
    if (index >= bucketCount) {
      break;
    }
    if (index == 0u) {
      bucketOffsets[index] = 0u;
    } else {
      bucketOffsets[index] = scanValues[index - 1u];
    }
    index = index + ${WORKGROUP_SIZE}u;
  }
}
`;

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
