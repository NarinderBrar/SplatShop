import { StorageBuffer } from "@babylonjs/core/Buffers/storageBuffer";
import { ComputeShader } from "@babylonjs/core/Compute/computeShader";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader";
import type { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import type { Matrix } from "@babylonjs/core/Maths/math.vector";
import type { Scene } from "@babylonjs/core/scene";

import type { ComputeTileStatsPass } from "./ComputeTileStatsPass";
import { canCreateComputeShader } from "./GpuDepthKeyPass";
import ComputeTileDepthRangePass_DEPTH_RANGE_SOURCE_raw from "./shaders/compute-tile-depth-range-pass.depth-range-source.wgsl?raw";

const WORKGROUP_SIZE = 64;
const MAX_TILES = 8192;
const PARAM_FLOAT_COUNT = 25;
const MAX_TILE_DEPTH_SAMPLES = 4096;

const DEPTH_RANGE_SOURCE = ComputeTileDepthRangePass_DEPTH_RANGE_SOURCE_raw.replaceAll("__DEPTH_RANGE_SOURCE_EXPR_0__", String(WORKGROUP_SIZE)).replaceAll("__DEPTH_RANGE_SOURCE_EXPR_1__", String(MAX_TILES)).replaceAll("__DEPTH_RANGE_SOURCE_EXPR_2__", String(MAX_TILE_DEPTH_SAMPLES)).replaceAll("__DEPTH_RANGE_SOURCE_EXPR_3__", String(MAX_TILE_DEPTH_SAMPLES));

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
    private readonly centerOffset = 0,
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
    this.paramsData[24] = this.centerOffset;
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
