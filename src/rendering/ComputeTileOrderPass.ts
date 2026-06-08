import { StorageBuffer } from "@babylonjs/core/Buffers/storageBuffer";
import { ComputeShader } from "@babylonjs/core/Compute/computeShader";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader";
import type { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import type { Matrix } from "@babylonjs/core/Maths/math.vector";
import type { Scene } from "@babylonjs/core/scene";

import type { ComputeTileStatsPass } from "./ComputeTileStatsPass";
import { canCreateComputeShader } from "./GpuDepthKeyPass";

const WORKGROUP_SIZE = 256;
const PREFIX_WORKGROUP_SIZE = 64;
const DEFAULT_BUCKET_COUNT = 16;
const DEFAULT_RASTER_PREVIEW_BUCKET_COUNT = 32;
const MAX_BUCKET_COUNT = 64;
const MAX_TILES = 8192;
const PARAM_FLOAT_COUNT = 28;

const getRasterPreviewQuality = (): "fast" | "balanced" | "quality" => {
  const value = new URLSearchParams(window.location.search).get("computeTileRasterQuality");
  return value === "fast" || value === "quality" ? value : "balanced";
};

const getDefaultRasterPreviewBucketCount = (): number => {
  const quality = getRasterPreviewQuality();
  if (quality === "fast") {
    return 24;
  }
  if (quality === "quality") {
    return 64;
  }
  return DEFAULT_RASTER_PREVIEW_BUCKET_COUNT;
};

const getBucketCount = (): number => {
  const value = Number(new URLSearchParams(window.location.search).get("computeTileOrderBuckets"));
  if (!Number.isFinite(value) || value <= 0) {
    return new URLSearchParams(window.location.search).get("computeTileRasterPreview") === "true"
      ? getDefaultRasterPreviewBucketCount()
      : DEFAULT_BUCKET_COUNT;
  }
  return Math.min(MAX_BUCKET_COUNT, Math.max(2, Math.floor(value)));
};

const CLEAR_SOURCE = `
@group(0) @binding(0) var<storage, read_write> bucketCounters: array<u32>;
@group(0) @binding(1) var<storage, read_write> bucketOffsets: array<u32>;
@group(0) @binding(2) var<storage, read> paramsBuffer: array<f32>;

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) globalId: vec3u) {
  let index = globalId.x;
  let total = u32(paramsBuffer[24]) * u32(paramsBuffer[25]);
  if (index >= total) {
    return;
  }
  bucketCounters[index] = 0u;
  bucketOffsets[index] = 0u;
}
`;

const CLEAR_COUNTERS_SOURCE = `
@group(0) @binding(0) var<storage, read_write> bucketCounters: array<u32>;
@group(0) @binding(1) var<storage, read> paramsBuffer: array<f32>;

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) globalId: vec3u) {
  let index = globalId.x;
  let total = u32(paramsBuffer[24]) * u32(paramsBuffer[25]);
  if (index >= total) {
    return;
  }
  bucketCounters[index] = 0u;
}
`;

const HISTOGRAM_SOURCE = `
@group(0) @binding(0) var<storage, read> centerBuffer: array<vec4f>;
@group(0) @binding(1) var<storage, read_write> bucketCounters: array<atomic<u32>>;
@group(0) @binding(2) var<storage, read> paramsBuffer: array<f32>;

fn transformCenter(center: vec3f) -> vec4f {
  return vec4f(
    paramsBuffer[0] * center.x + paramsBuffer[4] * center.y + paramsBuffer[8] * center.z + paramsBuffer[12],
    paramsBuffer[1] * center.x + paramsBuffer[5] * center.y + paramsBuffer[9] * center.z + paramsBuffer[13],
    paramsBuffer[2] * center.x + paramsBuffer[6] * center.y + paramsBuffer[10] * center.z + paramsBuffer[14],
    paramsBuffer[3] * center.x + paramsBuffer[7] * center.y + paramsBuffer[11] * center.z + paramsBuffer[15]
  );
}

fn tileAndBucket(index: u32) -> vec2u {
  let clip = transformCenter(centerBuffer[index].xyz);
  if (clip.w <= 0.000001) {
    return vec2u(4294967295u);
  }
  let ndc = clip.xy / clip.w;
  if (ndc.x < -1.0 || ndc.x > 1.0 || ndc.y < -1.0 || ndc.y > 1.0) {
    return vec2u(4294967295u);
  }

  let viewport = vec2f(paramsBuffer[16], paramsBuffer[17]);
  let tileSize = paramsBuffer[18];
  let tileCols = u32(paramsBuffer[19]);
  let tileRows = u32(paramsBuffer[20]);
  let tileCount = u32(paramsBuffer[24]);
  let bucketCount = u32(paramsBuffer[25]);
  let minDepth = paramsBuffer[26];
  let maxDepth = max(minDepth + 0.000001, paramsBuffer[27]);
  let pixel = (ndc * vec2f(0.5, -0.5) + vec2f(0.5)) * viewport;
  let tileX = min(tileCols - 1u, u32(clamp(floor(pixel.x / tileSize), 0.0, f32(tileCols - 1u))));
  let tileY = min(tileRows - 1u, u32(clamp(floor(pixel.y / tileSize), 0.0, f32(tileRows - 1u))));
  let tileIndex = tileY * tileCols + tileX;
  if (tileIndex >= tileCount || tileIndex >= ${MAX_TILES}u) {
    return vec2u(4294967295u);
  }

  let t = clamp((clip.w - minDepth) / (maxDepth - minDepth), 0.0, 0.999999);
  let bucket = min(bucketCount - 1u, u32(floor(t * f32(bucketCount))));
  return vec2u(tileIndex, bucket);
}

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) globalId: vec3u) {
  let index = globalId.x;
  let splatCount = u32(paramsBuffer[21]);
  if (index >= splatCount) {
    return;
  }
  let tb = tileAndBucket(index);
  if (tb.x == 4294967295u) {
    return;
  }
  let bucketCount = u32(paramsBuffer[25]);
  atomicAdd(&bucketCounters[tb.x * bucketCount + tb.y], 1u);
}
`;

const PREFIX_SOURCE = `
@group(0) @binding(0) var<storage, read> bucketCounters: array<u32>;
@group(0) @binding(1) var<storage, read_write> bucketOffsets: array<u32>;
@group(0) @binding(2) var<storage, read> tileOffsets: array<u32>;
@group(0) @binding(3) var<storage, read> paramsBuffer: array<f32>;

@compute @workgroup_size(${PREFIX_WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) globalId: vec3u) {
  let tileIndex = globalId.x;
  let tileCount = u32(paramsBuffer[24]);
  let bucketCount = u32(paramsBuffer[25]);
  if (tileIndex >= tileCount) {
    return;
  }

  var cursor = tileOffsets[tileIndex];
  for (var bucket = bucketCount; bucket > 0u; bucket = bucket - 1u) {
    let bucketIndex = bucket - 1u;
    let index = tileIndex * bucketCount + bucketIndex;
    bucketOffsets[index] = cursor;
    cursor = cursor + bucketCounters[index];
  }
}
`;

const getScatterSource = (remapToPacked: boolean): string => `
@group(0) @binding(0) var<storage, read> centerBuffer: array<vec4f>;
@group(0) @binding(1) var<storage, read> bucketOffsets: array<u32>;
@group(0) @binding(2) var<storage, read_write> bucketCounters: array<atomic<u32>>;
@group(0) @binding(3) var<storage, read_write> orderedTileSplatList: array<u32>;
@group(0) @binding(4) var<storage, read> paramsBuffer: array<f32>;
${remapToPacked ? "@group(0) @binding(5) var<storage, read> ordinalToPackedBuffer: array<u32>;" : ""}

fn transformCenter(center: vec3f) -> vec4f {
  return vec4f(
    paramsBuffer[0] * center.x + paramsBuffer[4] * center.y + paramsBuffer[8] * center.z + paramsBuffer[12],
    paramsBuffer[1] * center.x + paramsBuffer[5] * center.y + paramsBuffer[9] * center.z + paramsBuffer[13],
    paramsBuffer[2] * center.x + paramsBuffer[6] * center.y + paramsBuffer[10] * center.z + paramsBuffer[14],
    paramsBuffer[3] * center.x + paramsBuffer[7] * center.y + paramsBuffer[11] * center.z + paramsBuffer[15]
  );
}

fn tileAndBucket(index: u32) -> vec2u {
  let clip = transformCenter(centerBuffer[index].xyz);
  if (clip.w <= 0.000001) {
    return vec2u(4294967295u);
  }
  let ndc = clip.xy / clip.w;
  if (ndc.x < -1.0 || ndc.x > 1.0 || ndc.y < -1.0 || ndc.y > 1.0) {
    return vec2u(4294967295u);
  }

  let viewport = vec2f(paramsBuffer[16], paramsBuffer[17]);
  let tileSize = paramsBuffer[18];
  let tileCols = u32(paramsBuffer[19]);
  let tileRows = u32(paramsBuffer[20]);
  let tileCount = u32(paramsBuffer[24]);
  let bucketCount = u32(paramsBuffer[25]);
  let minDepth = paramsBuffer[26];
  let maxDepth = max(minDepth + 0.000001, paramsBuffer[27]);
  let pixel = (ndc * vec2f(0.5, -0.5) + vec2f(0.5)) * viewport;
  let tileX = min(tileCols - 1u, u32(clamp(floor(pixel.x / tileSize), 0.0, f32(tileCols - 1u))));
  let tileY = min(tileRows - 1u, u32(clamp(floor(pixel.y / tileSize), 0.0, f32(tileRows - 1u))));
  let tileIndex = tileY * tileCols + tileX;
  if (tileIndex >= tileCount || tileIndex >= ${MAX_TILES}u) {
    return vec2u(4294967295u);
  }

  let t = clamp((clip.w - minDepth) / (maxDepth - minDepth), 0.0, 0.999999);
  let bucket = min(bucketCount - 1u, u32(floor(t * f32(bucketCount))));
  return vec2u(tileIndex, bucket);
}

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) globalId: vec3u) {
  let index = globalId.x;
  let splatCount = u32(paramsBuffer[21]);
  if (index >= splatCount) {
    return;
  }
  let tb = tileAndBucket(index);
  if (tb.x == 4294967295u) {
    return;
  }
  let bucketCount = u32(paramsBuffer[25]);
  let bucketIndex = tb.x * bucketCount + tb.y;
  let local = atomicAdd(&bucketCounters[bucketIndex], 1u);
  let dst = bucketOffsets[bucketIndex] + local;
  if (dst < splatCount) {
    orderedTileSplatList[dst] = ${remapToPacked ? "ordinalToPackedBuffer[index]" : "index"};
  }
}
`;

type ComputeTileOrderStats = {
  enabled: boolean;
  dispatched: boolean;
  bucketCount: number;
  tileCount: number;
  orderedSplats: number;
  lastDispatchMs: number;
};

const isEnabled = (): boolean =>
  new URLSearchParams(window.location.search).get("computeTileOrder") === "depth-bucket" ||
  new URLSearchParams(window.location.search).get("computeTileRasterPreview") === "true";

class ComputeTileOrderPass {
  private readonly clearShader: ComputeShader;
  private readonly clearCountersShader: ComputeShader;
  private readonly histogramShader: ComputeShader;
  private readonly prefixShader: ComputeShader;
  private readonly scatterShader: ComputeShader;
  private readonly bucketCounters: StorageBuffer;
  private readonly bucketOffsets: StorageBuffer;
  private readonly orderedTileSplatList: StorageBuffer;
  private readonly params: StorageBuffer;
  private readonly paramsData = new Float32Array(PARAM_FLOAT_COUNT);
  private readonly bucketCount = getBucketCount();
  private stats: ComputeTileOrderStats = {
    enabled: true,
    dispatched: false,
    bucketCount: this.bucketCount,
    tileCount: 0,
    orderedSplats: 0,
    lastDispatchMs: 0,
  };

  constructor(
    scene: Scene,
    private readonly centerBuffer: StorageBuffer,
    private readonly tileStatsPass: ComputeTileStatsPass,
    private readonly splatCount: number,
    private readonly ordinalToPackedBuffer?: StorageBuffer,
  ) {
    const engine = scene.getEngine() as WebGPUEngine;
    const bucketValueCount = MAX_TILES * this.bucketCount;
    this.bucketCounters = new StorageBuffer(engine, bucketValueCount * 4, undefined, "ComputeTileOrderCounters");
    this.bucketCounters.update(new Uint32Array(bucketValueCount));
    this.bucketOffsets = new StorageBuffer(engine, bucketValueCount * 4, undefined, "ComputeTileOrderOffsets");
    this.bucketOffsets.update(new Uint32Array(bucketValueCount));
    this.orderedTileSplatList = new StorageBuffer(
      engine,
      Math.max(1, this.splatCount) * 4,
      undefined,
      "ComputeTileOrderedSplatList",
    );
    this.orderedTileSplatList.update(new Uint32Array(Math.max(1, this.splatCount)));
    this.params = new StorageBuffer(engine, this.paramsData.byteLength, undefined, "ComputeTileOrderParams");

    this.clearShader = new ComputeShader("ComputeTileOrderClear", engine, { computeSource: CLEAR_SOURCE }, {
      bindingsMapping: {
        bucketCounters: { group: 0, binding: 0 },
        bucketOffsets: { group: 0, binding: 1 },
        paramsBuffer: { group: 0, binding: 2 },
      },
    });
    this.clearShader.setStorageBuffer("bucketCounters", this.bucketCounters);
    this.clearShader.setStorageBuffer("bucketOffsets", this.bucketOffsets);
    this.clearShader.setStorageBuffer("paramsBuffer", this.params);

    this.clearCountersShader = new ComputeShader(
      "ComputeTileOrderClearCounters",
      engine,
      { computeSource: CLEAR_COUNTERS_SOURCE },
      {
        bindingsMapping: {
          bucketCounters: { group: 0, binding: 0 },
          paramsBuffer: { group: 0, binding: 1 },
        },
      },
    );
    this.clearCountersShader.setStorageBuffer("bucketCounters", this.bucketCounters);
    this.clearCountersShader.setStorageBuffer("paramsBuffer", this.params);

    this.histogramShader = new ComputeShader("ComputeTileOrderHistogram", engine, { computeSource: HISTOGRAM_SOURCE }, {
      bindingsMapping: {
        centerBuffer: { group: 0, binding: 0 },
        bucketCounters: { group: 0, binding: 1 },
        paramsBuffer: { group: 0, binding: 2 },
      },
    });
    this.histogramShader.setStorageBuffer("centerBuffer", this.centerBuffer);
    this.histogramShader.setStorageBuffer("bucketCounters", this.bucketCounters);
    this.histogramShader.setStorageBuffer("paramsBuffer", this.params);

    this.prefixShader = new ComputeShader("ComputeTileOrderPrefix", engine, { computeSource: PREFIX_SOURCE }, {
      bindingsMapping: {
        bucketCounters: { group: 0, binding: 0 },
        bucketOffsets: { group: 0, binding: 1 },
        tileOffsets: { group: 0, binding: 2 },
        paramsBuffer: { group: 0, binding: 3 },
      },
    });
    this.prefixShader.setStorageBuffer("bucketCounters", this.bucketCounters);
    this.prefixShader.setStorageBuffer("bucketOffsets", this.bucketOffsets);
    this.prefixShader.setStorageBuffer("tileOffsets", this.tileStatsPass.getTileOffsetsBuffer());
    this.prefixShader.setStorageBuffer("paramsBuffer", this.params);

    this.scatterShader = new ComputeShader(
      "ComputeTileOrderScatter",
      engine,
      { computeSource: getScatterSource(!!this.ordinalToPackedBuffer) },
      {
      bindingsMapping: {
        centerBuffer: { group: 0, binding: 0 },
        bucketOffsets: { group: 0, binding: 1 },
        bucketCounters: { group: 0, binding: 2 },
        orderedTileSplatList: { group: 0, binding: 3 },
        paramsBuffer: { group: 0, binding: 4 },
        ...(this.ordinalToPackedBuffer
          ? { ordinalToPackedBuffer: { group: 0, binding: 5 } }
          : {}),
      },
      },
    );
    this.scatterShader.setStorageBuffer("centerBuffer", this.centerBuffer);
    this.scatterShader.setStorageBuffer("bucketOffsets", this.bucketOffsets);
    this.scatterShader.setStorageBuffer("bucketCounters", this.bucketCounters);
    this.scatterShader.setStorageBuffer("orderedTileSplatList", this.orderedTileSplatList);
    this.scatterShader.setStorageBuffer("paramsBuffer", this.params);
    if (this.ordinalToPackedBuffer) {
      this.scatterShader.setStorageBuffer("ordinalToPackedBuffer", this.ordinalToPackedBuffer);
    }
  }

  static isEnabled(): boolean {
    return isEnabled();
  }

  static isSupported(scene: Scene): boolean {
    return canCreateComputeShader(scene);
  }

  dispose(): void {
    this.bucketCounters.dispose();
    this.bucketOffsets.dispose();
    this.orderedTileSplatList.dispose();
    this.params.dispose();
  }

  dispatch(
    transform: Matrix,
    viewportWidth: number,
    viewportHeight: number,
    splatCount = this.splatCount,
    minDepth = 0,
    maxDepth = 1,
  ): boolean {
    const tileStats = this.tileStatsPass.getStats();
    if (!tileStats.tileOffsetsDispatched || tileStats.tileCount <= 0) {
      return false;
    }

    const start = performance.now();
    const matrix = transform.toArray();
    for (let i = 0; i < 16; i++) {
      this.paramsData[i] = matrix[i];
    }
    this.paramsData[16] = viewportWidth;
    this.paramsData[17] = viewportHeight;
    this.paramsData[18] = tileStats.tileSize;
    this.paramsData[19] = tileStats.tileCols;
    this.paramsData[20] = tileStats.tileRows;
    this.paramsData[21] = Math.min(this.splatCount, Math.max(0, Math.floor(splatCount)));
    this.paramsData[24] = tileStats.tileCount;
    this.paramsData[25] = this.bucketCount;
    this.paramsData[26] = Number.isFinite(minDepth) ? minDepth : 0;
    this.paramsData[27] = Number.isFinite(maxDepth) && maxDepth > minDepth ? maxDepth : minDepth + 1;
    this.params.update(this.paramsData);

    const bucketValueCount = tileStats.tileCount * this.bucketCount;
    const cleared = this.clearShader.dispatch(Math.ceil(bucketValueCount / WORKGROUP_SIZE));
    const histogrammed =
      cleared && this.histogramShader.dispatch(Math.ceil(this.paramsData[21] / WORKGROUP_SIZE));
    const prefixed =
      histogrammed && this.prefixShader.dispatch(Math.ceil(tileStats.tileCount / PREFIX_WORKGROUP_SIZE));
    const clearedAgain =
      prefixed && this.clearCountersShader.dispatch(Math.ceil(bucketValueCount / WORKGROUP_SIZE));
    const scattered =
      clearedAgain && this.scatterShader.dispatch(Math.ceil(this.paramsData[21] / WORKGROUP_SIZE));

    if (scattered) {
      this.stats = {
        enabled: true,
        dispatched: true,
        bucketCount: this.bucketCount,
        tileCount: tileStats.tileCount,
        orderedSplats: tileStats.visibleSplats,
        lastDispatchMs: performance.now() - start,
      };
    }
    return scattered;
  }

  getStats(): ComputeTileOrderStats {
    return this.stats;
  }

  getOrderedTileSplatListBuffer(): StorageBuffer {
    return this.orderedTileSplatList;
  }
}

export { ComputeTileOrderPass };
export type { ComputeTileOrderStats };
