import { StorageBuffer } from "@babylonjs/core/Buffers/storageBuffer";
import { ComputeShader } from "@babylonjs/core/Compute/computeShader";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader";
import type { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import type { Matrix } from "@babylonjs/core/Maths/math.vector";
import type { Scene } from "@babylonjs/core/scene";

import type { ComputeTileStatsPass } from "./ComputeTileStatsPass";
import { canCreateComputeShader } from "./GpuDepthKeyPass";

const WORKGROUP_SIZE = 64;
const MAX_TILES = 8192;
const PARAM_FLOAT_COUNT = 24;
const MAX_TILE_DEPTH_SAMPLES = 4096;

const DEPTH_RANGE_SOURCE = `
@group(0) @binding(0) var<storage, read> centerBuffer: array<vec4f>;
@group(0) @binding(1) var<storage, read> tileOffsets: array<u32>;
@group(0) @binding(2) var<storage, read> tileSplatList: array<u32>;
@group(0) @binding(3) var<storage, read_write> depthRanges: array<vec4f>;
@group(0) @binding(4) var<storage, read> paramsBuffer: array<f32>;

fn transformCenter(center: vec3f) -> vec4f {
  return vec4f(
    paramsBuffer[0] * center.x + paramsBuffer[4] * center.y + paramsBuffer[8] * center.z + paramsBuffer[12],
    paramsBuffer[1] * center.x + paramsBuffer[5] * center.y + paramsBuffer[9] * center.z + paramsBuffer[13],
    paramsBuffer[2] * center.x + paramsBuffer[6] * center.y + paramsBuffer[10] * center.z + paramsBuffer[14],
    paramsBuffer[3] * center.x + paramsBuffer[7] * center.y + paramsBuffer[11] * center.z + paramsBuffer[15]
  );
}

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) globalId: vec3u) {
  let tileIndex = globalId.x;
  let splatCount = u32(paramsBuffer[21]);
  let tileCount = u32(paramsBuffer[23]);
  if (tileIndex >= tileCount || tileIndex >= ${MAX_TILES}u) {
    return;
  }

  let start = tileOffsets[tileIndex];
  let end = tileOffsets[tileIndex + 1u];
  if (end <= start) {
    depthRanges[tileIndex] = vec4f(0.0);
    return;
  }

  let listCount = end - start;
  let sampleStep = max(1u, (listCount + ${MAX_TILE_DEPTH_SAMPLES}u - 1u) / ${MAX_TILE_DEPTH_SAMPLES}u);
  var minDepth = 3.4028234663852886e38;
  var maxDepth = -3.4028234663852886e38;
  var sumDepth = 0.0;
  var validCount = 0u;
  for (var item = start; item < end; item = item + sampleStep) {
    let splatIndex = tileSplatList[item];
    if (splatIndex >= splatCount) {
      continue;
    }
    let clip = transformCenter(centerBuffer[splatIndex].xyz);
    if (clip.w <= 0.000001) {
      continue;
    }
    minDepth = min(minDepth, clip.w);
    maxDepth = max(maxDepth, clip.w);
    sumDepth = sumDepth + clip.w;
    validCount = validCount + 1u;
  }

  if (validCount == 0u) {
    depthRanges[tileIndex] = vec4f(0.0);
    return;
  }
  depthRanges[tileIndex] = vec4f(minDepth, maxDepth, sumDepth / f32(validCount), f32(validCount));
}
`;

type ComputeTileDepthRangeStats = {
  enabled: boolean;
  dispatched: boolean;
  tileCount: number;
  depthTiles: number;
  minDepth: number;
  maxDepth: number;
  maxDepthSpan: number;
  avgDepthSpan: number;
  depthSpans?: Float32Array;
  lastDispatchMs: number;
};

const isEnabled = (): boolean => {
  const params = new URLSearchParams(window.location.search);
  return (
    params.get("computeTileDepth") === "true" ||
    params.get("computeTileDepthOverlay") === "true" ||
    params.get("computeTileWorkQueue") === "true" ||
    params.get("computeTilePreview") === "true" ||
    params.get("computeTileSplatPreview") === "true" ||
    params.get("computeTileRasterPreview") === "true"
  );
};

class ComputeTileDepthRangePass {
  private readonly shader: ComputeShader;
  private readonly depthRanges: StorageBuffer;
  private readonly params: StorageBuffer;
  private readonly paramsData = new Float32Array(PARAM_FLOAT_COUNT);
  private readPending = false;
  private stats: ComputeTileDepthRangeStats = {
    enabled: true,
    dispatched: false,
    tileCount: 0,
    depthTiles: 0,
    minDepth: 0,
    maxDepth: 0,
    maxDepthSpan: 0,
    avgDepthSpan: 0,
    lastDispatchMs: 0,
  };

  constructor(
    scene: Scene,
    private readonly centerBuffer: StorageBuffer,
    private readonly tileStatsPass: ComputeTileStatsPass,
    private readonly splatCount: number,
  ) {
    const engine = scene.getEngine() as WebGPUEngine;
    const depthRangeData = new Float32Array(MAX_TILES * 4);
    this.depthRanges = new StorageBuffer(engine, depthRangeData.byteLength, undefined, "ComputeTileDepthRanges");
    this.depthRanges.update(depthRangeData);
    this.params = new StorageBuffer(engine, this.paramsData.byteLength, undefined, "ComputeTileDepthRangeParams");
    this.shader = new ComputeShader(
      "ComputeTileDepthRange",
      engine,
      { computeSource: DEPTH_RANGE_SOURCE },
      {
        bindingsMapping: {
          centerBuffer: { group: 0, binding: 0 },
          tileOffsets: { group: 0, binding: 1 },
          tileSplatList: { group: 0, binding: 2 },
          depthRanges: { group: 0, binding: 3 },
          paramsBuffer: { group: 0, binding: 4 },
        },
      },
    );
    this.shader.setStorageBuffer("centerBuffer", this.centerBuffer);
    this.shader.setStorageBuffer("tileOffsets", this.tileStatsPass.getTileOffsetsBuffer());
    this.shader.setStorageBuffer("tileSplatList", this.tileStatsPass.getTileSplatListBuffer());
    this.shader.setStorageBuffer("depthRanges", this.depthRanges);
    this.shader.setStorageBuffer("paramsBuffer", this.params);
  }

  static isEnabled(): boolean {
    return isEnabled();
  }

  static isSupported(scene: Scene): boolean {
    return canCreateComputeShader(scene);
  }

  dispose(): void {
    this.depthRanges.dispose();
    this.params.dispose();
  }

  dispatch(transform: Matrix, splatCount = this.splatCount): boolean {
    const tileStats = this.tileStatsPass.getStats();
    if (!tileStats.tileListScatterDispatched || tileStats.tileCount <= 0) {
      return false;
    }

    const start = performance.now();
    const matrix = transform.toArray();
    for (let i = 0; i < 16; i++) {
      this.paramsData[i] = matrix[i];
    }
    this.paramsData[21] = Math.min(this.splatCount, Math.max(0, Math.floor(splatCount)));
    this.paramsData[23] = tileStats.tileCount;
    this.params.update(this.paramsData);

    const dispatched = this.shader.dispatch(Math.ceil(tileStats.tileCount / WORKGROUP_SIZE));
    if (dispatched) {
      this.stats = {
        ...this.stats,
        dispatched: true,
        tileCount: tileStats.tileCount,
        lastDispatchMs: performance.now() - start,
      };
      this.scheduleReadback(tileStats.tileCount);
    }
    return dispatched;
  }

  getStats(): ComputeTileDepthRangeStats {
    return this.stats;
  }

  getDepthRangesBuffer(): StorageBuffer {
    return this.depthRanges;
  }

  private scheduleReadback(tileCount: number): void {
    if (this.readPending) {
      return;
    }
    this.readPending = true;
    void this.depthRanges
      .read(0, MAX_TILES * 4 * 4)
      .then((depthView) => {
        const ranges = new Float32Array(depthView.buffer, depthView.byteOffset, depthView.byteLength / 4);
        const spans = new Float32Array(tileCount);
        let depthTiles = 0;
        let minDepth = Number.POSITIVE_INFINITY;
        let maxDepth = 0;
        let maxDepthSpan = 0;
        let sumDepthSpan = 0;
        for (let tile = 0; tile < tileCount; tile++) {
          const base = tile * 4;
          const count = ranges[base + 3];
          if (count <= 0) {
            continue;
          }
          const tileMin = ranges[base + 0];
          const tileMax = ranges[base + 1];
          const span = Math.max(0, tileMax - tileMin);
          spans[tile] = span;
          depthTiles++;
          minDepth = Math.min(minDepth, tileMin);
          maxDepth = Math.max(maxDepth, tileMax);
          maxDepthSpan = Math.max(maxDepthSpan, span);
          sumDepthSpan += span;
        }
        this.stats = {
          ...this.stats,
          depthTiles,
          minDepth: Number.isFinite(minDepth) ? minDepth : 0,
          maxDepth,
          maxDepthSpan,
          avgDepthSpan: depthTiles > 0 ? sumDepthSpan / depthTiles : 0,
          depthSpans: spans,
        };
      })
      .catch(() => {
        this.stats = {
          ...this.stats,
          depthTiles: 0,
          minDepth: 0,
          maxDepth: 0,
          maxDepthSpan: 0,
          avgDepthSpan: 0,
        };
      })
      .finally(() => {
        this.readPending = false;
      });
  }
}

export { ComputeTileDepthRangePass };
export type { ComputeTileDepthRangeStats };
