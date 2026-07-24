import { StorageBuffer } from "@babylonjs/core/Buffers/storageBuffer";
import { ComputeShader } from "@babylonjs/core/Compute/computeShader";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader";
import type { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import type { Matrix } from "@babylonjs/core/Maths/math.vector";
import type { Scene } from "@babylonjs/core/scene";

import type { ComputeTileStatsPass } from "./ComputeTileStatsPass";
import { canCreateComputeShader } from "./GpuDepthKeyPass";
import ComputeTileOrderPass_CLEAR_SOURCE_raw from "./shaders/compute-tile-order-pass.clear-source.wgsl?raw";
import ComputeTileOrderPass_CLEAR_COUNTERS_SOURCE_raw from "./shaders/compute-tile-order-pass.clear-counters-source.wgsl?raw";
import ComputeTileOrderPass_HISTOGRAM_SOURCE_raw from "./shaders/compute-tile-order-pass.histogram-source.wgsl?raw";
import ComputeTileOrderPass_PREFIX_SOURCE_raw from "./shaders/compute-tile-order-pass.prefix-source.wgsl?raw";
import ComputeTileOrderPass_SCATTER_SOURCE_raw from "./shaders/compute-tile-order-pass.scatter-source.wgsl?raw";

const WORKGROUP_SIZE = 256;
const PREFIX_WORKGROUP_SIZE = 64;
const DEFAULT_BUCKET_COUNT = 16;
const DEFAULT_RASTER_PREVIEW_BUCKET_COUNT = 64;
const MAX_BUCKET_COUNT = 256;
const MAX_TILES = 8192;
const PARAM_FLOAT_COUNT = 29;

const getRasterPreviewQuality = (): "fast" | "balanced" | "quality" => {
  const value = new URLSearchParams(window.location.search).get("computeTileRasterQuality");
  return value === "fast" || value === "quality" ? value : "balanced";
};

const isRasterPreviewRequested = (params = new URLSearchParams(window.location.search)): boolean =>
  params.get("computeTileRasterPreview") === "true" || params.get("renderer") === "compute";

const getDefaultRasterPreviewBucketCount = (): number => {
  const quality = getRasterPreviewQuality();
  if (quality === "fast") {
    return 24;
  }
  if (quality === "quality") {
    return 128;
  }
  return DEFAULT_RASTER_PREVIEW_BUCKET_COUNT;
};

const getBucketCount = (): number => {
  const value = Number(new URLSearchParams(window.location.search).get("computeTileOrderBuckets"));
  if (!Number.isFinite(value) || value <= 0) {
    return isRasterPreviewRequested()
      ? getDefaultRasterPreviewBucketCount()
      : DEFAULT_BUCKET_COUNT;
  }
  return Math.min(MAX_BUCKET_COUNT, Math.max(2, Math.floor(value)));
};

const CLEAR_SOURCE = ComputeTileOrderPass_CLEAR_SOURCE_raw.replaceAll("__CLEAR_SOURCE_EXPR_0__", String(WORKGROUP_SIZE));

const CLEAR_COUNTERS_SOURCE = ComputeTileOrderPass_CLEAR_COUNTERS_SOURCE_raw.replaceAll("__CLEAR_COUNTERS_SOURCE_EXPR_0__", String(WORKGROUP_SIZE));

const HISTOGRAM_SOURCE = ComputeTileOrderPass_HISTOGRAM_SOURCE_raw.replaceAll("__HISTOGRAM_SOURCE_EXPR_0__", String(MAX_TILES)).replaceAll("__HISTOGRAM_SOURCE_EXPR_1__", String(WORKGROUP_SIZE));

const PREFIX_SOURCE = ComputeTileOrderPass_PREFIX_SOURCE_raw.replaceAll("__PREFIX_SOURCE_EXPR_0__", String(PREFIX_WORKGROUP_SIZE));

const getScatterSource = (remapToPacked: boolean): string => ComputeTileOrderPass_SCATTER_SOURCE_raw.replaceAll("__TEMPLATE_EXPR_0__", String(remapToPacked ? "@group(0) @binding(7) var<storage, read> ordinalToPackedBuffer: array<u32>;" : "")).replaceAll("__TEMPLATE_EXPR_1__", String(MAX_TILES)).replaceAll("__TEMPLATE_EXPR_2__", String(WORKGROUP_SIZE)).replaceAll("__TEMPLATE_EXPR_3__", String(remapToPacked ? "ordinalToPackedBuffer[splatIndex]" : "splatIndex"));

type ComputeTileOrderStats = {
  enabled: boolean;
  dispatched: boolean;
  bucketCount: number;
  tileCount: number;
  trackedTileCount: number;
  orderedSplats: number;
  truncatedSplats: number;
  overflowSplats: number;
  overflowTiles: number;
  lastDispatchMs: number;
};

const isEnabled = (): boolean =>
  new URLSearchParams(window.location.search).get("computeTileOrder") === "depth-bucket" ||
  isRasterPreviewRequested();

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
    trackedTileCount: 0,
    orderedSplats: 0,
    truncatedSplats: 0,
    overflowSplats: 0,
    overflowTiles: 0,
    lastDispatchMs: 0,
  };

  constructor(
    scene: Scene,
    private readonly centerBuffer: StorageBuffer,
    private readonly tileStatsPass: ComputeTileStatsPass,
    _splatCount: number,
    private readonly ordinalToPackedBuffer?: StorageBuffer,
    private readonly centerOffset = 0,
  ) {
    const engine = scene.getEngine() as WebGPUEngine;
    const tileListCapacity = this.tileStatsPass.getStats().tileListCapacity;
    const bucketValueCount = MAX_TILES * this.bucketCount;
    this.bucketCounters = new StorageBuffer(engine, bucketValueCount * 4, undefined, "ComputeTileOrderCounters");
    this.bucketCounters.update(new Uint32Array(bucketValueCount));
    this.bucketOffsets = new StorageBuffer(engine, bucketValueCount * 4, undefined, "ComputeTileOrderOffsets");
    this.bucketOffsets.update(new Uint32Array(bucketValueCount));
    this.orderedTileSplatList = new StorageBuffer(
      engine,
      Math.max(1, tileListCapacity) * 4,
      undefined,
      "ComputeTileOrderedSplatList",
    );
    this.orderedTileSplatList.update(new Uint32Array(Math.max(1, tileListCapacity)));
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
        tileOffsets: { group: 0, binding: 2 },
        tileSplatList: { group: 0, binding: 3 },
        paramsBuffer: { group: 0, binding: 4 },
      },
    });
    this.histogramShader.setStorageBuffer("centerBuffer", this.centerBuffer);
    this.histogramShader.setStorageBuffer("bucketCounters", this.bucketCounters);
    this.histogramShader.setStorageBuffer("tileOffsets", this.tileStatsPass.getTileOffsetsBuffer());
    this.histogramShader.setStorageBuffer("tileSplatList", this.tileStatsPass.getTileSplatListBuffer());
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
        tileOffsets: { group: 0, binding: 4 },
        tileSplatList: { group: 0, binding: 5 },
        paramsBuffer: { group: 0, binding: 6 },
        ...(this.ordinalToPackedBuffer
          ? { ordinalToPackedBuffer: { group: 0, binding: 7 } }
          : {}),
      },
      },
    );
    this.scatterShader.setStorageBuffer("centerBuffer", this.centerBuffer);
    this.scatterShader.setStorageBuffer("bucketOffsets", this.bucketOffsets);
    this.scatterShader.setStorageBuffer("bucketCounters", this.bucketCounters);
    this.scatterShader.setStorageBuffer("orderedTileSplatList", this.orderedTileSplatList);
    this.scatterShader.setStorageBuffer("tileOffsets", this.tileStatsPass.getTileOffsetsBuffer());
    this.scatterShader.setStorageBuffer("tileSplatList", this.tileStatsPass.getTileSplatListBuffer());
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
    _splatCount = 0,
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
    this.paramsData[21] = tileStats.tileListCapacity;
    this.paramsData[24] = tileStats.tileCount;
    this.paramsData[25] = this.bucketCount;
    this.paramsData[26] = Number.isFinite(minDepth) ? minDepth : 0;
    this.paramsData[27] = Number.isFinite(maxDepth) && maxDepth > minDepth ? maxDepth : minDepth + 1;
    this.paramsData[28] = this.centerOffset;
    this.params.update(this.paramsData);

    const bucketValueCount = tileStats.tileCount * this.bucketCount;
    const cleared = this.clearShader.dispatch(Math.ceil(bucketValueCount / WORKGROUP_SIZE));
    const histogrammed =
      cleared && this.histogramShader.dispatch(Math.ceil(tileStats.tileListCapacity / WORKGROUP_SIZE));
    const prefixed =
      histogrammed && this.prefixShader.dispatch(Math.ceil(tileStats.tileCount / PREFIX_WORKGROUP_SIZE));
    const clearedAgain =
      prefixed && this.clearCountersShader.dispatch(Math.ceil(bucketValueCount / WORKGROUP_SIZE));
    const scattered =
      clearedAgain && this.scatterShader.dispatch(Math.ceil(tileStats.tileListCapacity / WORKGROUP_SIZE));

    if (scattered) {
      const trackedTileCount = Math.min(tileStats.tileCount, MAX_TILES);
      const orderedSplats = Math.min(tileStats.tileListEntries, this.paramsData[21]);
      const truncatedSplats = Math.max(0, tileStats.tileListEntries - orderedSplats) + tileStats.overflowSplats;
      this.stats = {
        enabled: true,
        dispatched: true,
        bucketCount: this.bucketCount,
        tileCount: tileStats.tileCount,
        trackedTileCount,
        orderedSplats,
        truncatedSplats,
        overflowSplats: tileStats.overflowSplats,
        overflowTiles: Math.max(0, tileStats.tileCount - trackedTileCount),
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
