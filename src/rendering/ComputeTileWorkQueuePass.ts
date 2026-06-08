import { StorageBuffer } from "@babylonjs/core/Buffers/storageBuffer";
import { ComputeShader } from "@babylonjs/core/Compute/computeShader";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader";
import type { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Scene } from "@babylonjs/core/scene";

import type { ComputeTileDepthRangePass } from "./ComputeTileDepthRangePass";
import type { ComputeTileStatsPass } from "./ComputeTileStatsPass";
import { canCreateComputeShader } from "./GpuDepthKeyPass";

const WORKGROUP_SIZE = 128;
const MAX_TILES = 8192;
const MAX_WORK_ITEMS = 65536;
const METADATA_COUNT = 4;
const DEFAULT_DEPTH_BAND_COUNT = 32;
const MAX_DEPTH_BAND_COUNT = 64;
const DEFAULT_RASTER_SPLATS_PER_WORK_ITEM = 128;
const MAX_RASTER_SPLATS_PER_WORK_ITEM = 512;
const DEFAULT_RASTER_WORK_ITEM_BUDGET = 4096;
const DEFAULT_RASTER_WORK_ITEM_BUDGET_CAP = 16384;
const DEPTH_BAND_QUANTIZATION = 1024;
const MOTION_COVERAGE_HOLD_FRAMES = 6;
const MOTION_COVERAGE_MOVE_EPSILON_SQ = 0.0025;
const MOTION_COVERAGE_FORWARD_DOT = 0.9995;

const getRasterPreviewQuality = (): "fast" | "balanced" | "quality" => {
  const value = new URLSearchParams(window.location.search).get("computeTileRasterQuality");
  return value === "fast" || value === "quality" ? value : "balanced";
};

const getDefaultSplatsPerWorkItem = (): number => {
  const quality = getRasterPreviewQuality();
  if (quality === "fast") {
    return 192;
  }
  if (quality === "quality") {
    return 64;
  }
  return DEFAULT_RASTER_SPLATS_PER_WORK_ITEM;
};

const getDefaultWorkItemBudgetCap = (): number => {
  const quality = getRasterPreviewQuality();
  if (quality === "fast") {
    return 8192;
  }
  if (quality === "quality") {
    return 32768;
  }
  return DEFAULT_RASTER_WORK_ITEM_BUDGET_CAP;
};

const getDefaultRasterCoverageTarget = (): number => {
  const quality = getRasterPreviewQuality();
  if (quality === "fast") {
    return 0.75;
  }
  if (quality === "quality") {
    return 1.0;
  }
  return 0.9;
};

const getDefaultDepthBandCount = (): number => {
  const quality = getRasterPreviewQuality();
  if (quality === "fast") {
    return 16;
  }
  if (quality === "quality") {
    return 64;
  }
  return DEFAULT_DEPTH_BAND_COUNT;
};

function getDepthBandCount(): number {
  const value = Number(new URLSearchParams(window.location.search).get("computeTileWorkQueueDepthBands"));
  if (!Number.isFinite(value) || value <= 0) {
    return getDefaultDepthBandCount();
  }
  return Math.min(MAX_DEPTH_BAND_COUNT, Math.max(2, Math.floor(value)));
}

const DEPTH_BAND_COUNT = getDepthBandCount();

const CLEAR_SOURCE = `
@group(0) @binding(0) var<storage, read_write> metadata: array<u32>;
@group(0) @binding(1) var<storage, read_write> depthBandCounters: array<u32>;
@group(0) @binding(2) var<storage, read_write> depthBandOffsets: array<u32>;

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) globalId: vec3u) {
  let index = globalId.x;
  if (index >= ${METADATA_COUNT}u) {
  } else {
    metadata[index] = 0u;
  }
  if (index < ${DEPTH_BAND_COUNT}u) {
    depthBandCounters[index] = 0u;
    depthBandOffsets[index] = 0u;
  }
}
`;

const COMPACT_SOURCE = `
@group(0) @binding(0) var<storage, read> tileCounters: array<u32>;
@group(0) @binding(1) var<storage, read> tileOffsets: array<u32>;
@group(0) @binding(2) var<storage, read> depthRanges: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> workQueue: array<vec4u>;
@group(0) @binding(4) var<storage, read_write> workDepthRanges: array<vec4f>;
@group(0) @binding(5) var<storage, read_write> metadata: array<atomic<u32>>;
@group(0) @binding(6) var<storage, read> paramsBuffer: array<u32>;

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) globalId: vec3u) {
  let tileIndex = globalId.x;
  let tileCount = paramsBuffer[0];
  if (tileIndex >= tileCount || tileIndex >= ${MAX_TILES}u) {
    return;
  }

  let splatCount = tileCounters[tileIndex];
  let depth = depthRanges[tileIndex];
  if (splatCount == 0u || depth.w <= 0.0) {
    return;
  }

  let maxBatchSplats = paramsBuffer[1];
  let batchSize = select(splatCount, min(splatCount, maxBatchSplats), maxBatchSplats > 0u);
  let maxWorkItems = paramsBuffer[2];
  let batchCount = (splatCount + batchSize - 1u) / batchSize;
  let tileOffset = tileOffsets[tileIndex];
  for (var batch = 0u; batch < batchCount; batch = batch + 1u) {
    let batchOffset = batch * batchSize;
    let batchSplats = min(batchSize, splatCount - batchOffset);
    let slot = atomicAdd(&metadata[0], 1u);
    if (slot >= maxWorkItems || slot >= ${MAX_WORK_ITEMS}u) {
      atomicAdd(&metadata[3], 1u);
      continue;
    }

    workQueue[slot] = vec4u(tileIndex, tileOffset + batchOffset, batchSplats, 0u);
    workDepthRanges[slot] = depth;
    atomicAdd(&metadata[1], batchSplats);
    atomicMax(&metadata[2], batchSplats);
  }
}
`;

const DEPTH_BAND_COUNT_SOURCE = `
@group(0) @binding(0) var<storage, read> tileCounters: array<u32>;
@group(0) @binding(1) var<storage, read> depthRanges: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> depthBandCounters: array<atomic<u32>>;
@group(0) @binding(3) var<storage, read> paramsBuffer: array<u32>;

fn depthBand(depth: f32, minDepthQ: u32, depthBandRangeQ: u32) -> u32 {
  let minDepth = f32(minDepthQ) / ${DEPTH_BAND_QUANTIZATION}.0;
  let depthBandRange = max(1.0 / ${DEPTH_BAND_QUANTIZATION}.0, f32(depthBandRangeQ) / ${DEPTH_BAND_QUANTIZATION}.0);
  let t = clamp((depth - minDepth) / depthBandRange, 0.0, 0.999999);
  let bucket = min(${DEPTH_BAND_COUNT - 1}u, u32(floor(t * ${DEPTH_BAND_COUNT}.0)));
  return ${DEPTH_BAND_COUNT - 1}u - bucket;
}

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) globalId: vec3u) {
  let tileIndex = globalId.x;
  let tileCount = paramsBuffer[0];
  if (tileIndex >= tileCount || tileIndex >= ${MAX_TILES}u) {
    return;
  }

  let splatCount = tileCounters[tileIndex];
  let depth = depthRanges[tileIndex];
  if (splatCount == 0u || depth.w <= 0.0) {
    return;
  }

  let maxBatchSplats = paramsBuffer[1];
  let batchSize = select(splatCount, min(splatCount, maxBatchSplats), maxBatchSplats > 0u);
  let batchCount = (splatCount + batchSize - 1u) / batchSize;
  atomicAdd(&depthBandCounters[depthBand(depth.z, paramsBuffer[4], max(1u, paramsBuffer[5]))], batchCount);
}
`;

const DEPTH_BAND_PREFIX_SOURCE = `
@group(0) @binding(0) var<storage, read> depthBandCounters: array<u32>;
@group(0) @binding(1) var<storage, read_write> depthBandOffsets: array<u32>;
@group(0) @binding(2) var<storage, read_write> metadata: array<u32>;
@group(0) @binding(3) var<storage, read> paramsBuffer: array<u32>;

@compute @workgroup_size(1)
fn main() {
  let maxWorkItems = min(paramsBuffer[2], ${MAX_WORK_ITEMS}u);
  var cursor = 0u;
  for (var band = 0u; band < ${DEPTH_BAND_COUNT}u; band = band + 1u) {
    depthBandOffsets[band] = min(cursor, maxWorkItems);
    cursor = cursor + depthBandCounters[band];
  }
  metadata[0] = min(cursor, maxWorkItems);
  if (cursor > maxWorkItems) {
    metadata[3] = cursor - maxWorkItems;
  }
}
`;

const DEPTH_BAND_RESET_COUNTERS_SOURCE = `
@group(0) @binding(0) var<storage, read_write> depthBandCounters: array<u32>;

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) globalId: vec3u) {
  let index = globalId.x;
  if (index < ${DEPTH_BAND_COUNT}u) {
    depthBandCounters[index] = 0u;
  }
}
`;

const DEPTH_BAND_SCATTER_SOURCE = `
@group(0) @binding(0) var<storage, read> tileCounters: array<u32>;
@group(0) @binding(1) var<storage, read> tileOffsets: array<u32>;
@group(0) @binding(2) var<storage, read> depthRanges: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> workQueue: array<vec4u>;
@group(0) @binding(4) var<storage, read_write> metadata: array<atomic<u32>>;
@group(0) @binding(5) var<storage, read> paramsBuffer: array<u32>;
@group(0) @binding(6) var<storage, read_write> depthBandCounters: array<atomic<u32>>;
@group(0) @binding(7) var<storage, read> depthBandOffsets: array<u32>;

fn depthBand(depth: f32, minDepthQ: u32, depthBandRangeQ: u32) -> u32 {
  let minDepth = f32(minDepthQ) / ${DEPTH_BAND_QUANTIZATION}.0;
  let depthBandRange = max(1.0 / ${DEPTH_BAND_QUANTIZATION}.0, f32(depthBandRangeQ) / ${DEPTH_BAND_QUANTIZATION}.0);
  let t = clamp((depth - minDepth) / depthBandRange, 0.0, 0.999999);
  let bucket = min(${DEPTH_BAND_COUNT - 1}u, u32(floor(t * ${DEPTH_BAND_COUNT}.0)));
  return ${DEPTH_BAND_COUNT - 1}u - bucket;
}

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) globalId: vec3u) {
  let tileIndex = globalId.x;
  let tileCount = paramsBuffer[0];
  if (tileIndex >= tileCount || tileIndex >= ${MAX_TILES}u) {
    return;
  }

  let splatCount = tileCounters[tileIndex];
  let depth = depthRanges[tileIndex];
  if (splatCount == 0u || depth.w <= 0.0) {
    return;
  }

  let maxBatchSplats = paramsBuffer[1];
  let batchSize = select(splatCount, min(splatCount, maxBatchSplats), maxBatchSplats > 0u);
  let maxWorkItems = min(paramsBuffer[2], ${MAX_WORK_ITEMS}u);
  let band = depthBand(depth.z, paramsBuffer[4], max(1u, paramsBuffer[5]));
  let batchCount = (splatCount + batchSize - 1u) / batchSize;
  let tileOffset = tileOffsets[tileIndex];
  for (var batch = 0u; batch < batchCount; batch = batch + 1u) {
    let batchOffset = batch * batchSize;
    let batchSplats = min(batchSize, splatCount - batchOffset);
    let slot = depthBandOffsets[band] + atomicAdd(&depthBandCounters[band], 1u);
    if (slot >= maxWorkItems) {
      continue;
    }

    workQueue[slot] = vec4u(tileIndex, tileOffset + batchOffset, batchSplats, 0u);
    atomicAdd(&metadata[1], batchSplats);
    atomicMax(&metadata[2], batchSplats);
  }
}
`;

const DEPTH_BAND_STABLE_SOURCE = `
@group(0) @binding(0) var<storage, read> tileCounters: array<u32>;
@group(0) @binding(1) var<storage, read> tileOffsets: array<u32>;
@group(0) @binding(2) var<storage, read> depthRanges: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> workQueue: array<vec4u>;
@group(0) @binding(4) var<storage, read_write> metadata: array<u32>;
@group(0) @binding(5) var<storage, read> paramsBuffer: array<u32>;

fn depthBand(depth: f32, minDepthQ: u32, depthBandRangeQ: u32) -> u32 {
  let minDepth = f32(minDepthQ) / ${DEPTH_BAND_QUANTIZATION}.0;
  let depthBandRange = max(1.0 / ${DEPTH_BAND_QUANTIZATION}.0, f32(depthBandRangeQ) / ${DEPTH_BAND_QUANTIZATION}.0);
  let t = clamp((depth - minDepth) / depthBandRange, 0.0, 0.999999);
  let bucket = min(${DEPTH_BAND_COUNT - 1}u, u32(floor(t * ${DEPTH_BAND_COUNT}.0)));
  return ${DEPTH_BAND_COUNT - 1}u - bucket;
}

@compute @workgroup_size(1)
fn main() {
  let tileCount = min(paramsBuffer[0], ${MAX_TILES}u);
  let maxBatchSplats = paramsBuffer[1];
  let maxWorkItems = min(paramsBuffer[2], ${MAX_WORK_ITEMS}u);
  var slot = 0u;
  var queuedSplats = 0u;
  var maxTileSplats = 0u;
  var overflow = 0u;

  for (var band = 0u; band < ${DEPTH_BAND_COUNT}u; band = band + 1u) {
    for (var tileIndex = 0u; tileIndex < tileCount; tileIndex = tileIndex + 1u) {
      let splatCount = tileCounters[tileIndex];
      let depth = depthRanges[tileIndex];
      if (splatCount == 0u || depth.w <= 0.0) {
        continue;
      }
      if (depthBand(depth.z, paramsBuffer[4], max(1u, paramsBuffer[5])) != band) {
        continue;
      }

      let batchSize = select(splatCount, min(splatCount, maxBatchSplats), maxBatchSplats > 0u);
      let batchCount = (splatCount + batchSize - 1u) / batchSize;
      let tileOffset = tileOffsets[tileIndex];
      for (var batch = 0u; batch < batchCount; batch = batch + 1u) {
        let batchOffset = batch * batchSize;
        let batchSplats = min(batchSize, splatCount - batchOffset);
        if (slot >= maxWorkItems) {
          overflow = overflow + 1u;
          continue;
        }

        workQueue[slot] = vec4u(tileIndex, tileOffset + batchOffset, batchSplats, band);
        slot = slot + 1u;
        queuedSplats = queuedSplats + batchSplats;
        maxTileSplats = max(maxTileSplats, batchSplats);
      }
    }
  }

  metadata[0] = slot;
  metadata[1] = queuedSplats;
  metadata[2] = maxTileSplats;
  metadata[3] = overflow;
}
`;

type ComputeTileWorkQueueStats = {
  enabled: boolean;
  dispatched: boolean;
  orderMode: "compact" | "depth-band";
  depthBandCount: number;
  stableOrder: boolean;
  maxSplatsPerWorkItem: number;
  workItemBudget: number;
  workItemBudgetCap: number;
  coverageTarget: number;
  explicitWorkItemBudget: boolean;
  workTiles: number;
  queuedSplats: number;
  maxTileSplats: number;
  avgTileSplats: number;
  overflowTiles: number;
  lastDispatchMs: number;
};

const isEnabled = (): boolean =>
  new URLSearchParams(window.location.search).get("computeTileWorkQueue") === "true" ||
  new URLSearchParams(window.location.search).get("computeTilePreview") === "true" ||
  new URLSearchParams(window.location.search).get("computeTileSplatPreview") === "true" ||
  new URLSearchParams(window.location.search).get("computeTileRasterPreview") === "true";

const isAutoBatchedRasterPreview = (params: URLSearchParams): boolean =>
  params.get("computeTileRasterPreview") === "true" &&
  params.get("computeTileWorkQueueOrder") === "depth-band" &&
  params.get("computeTileRasterBatch") !== "false";

const getMaxSplatsPerWorkItem = (): number => {
  const params = new URLSearchParams(window.location.search);
  if (params.get("computeTileRasterBatch") !== "true" && !isAutoBatchedRasterPreview(params)) {
    return 0;
  }
  const value = Number(params.get("computeTileRasterMaxSplatsPerTile"));
  if (!Number.isFinite(value) || value <= 0) {
    return getDefaultSplatsPerWorkItem();
  }
  return Math.min(MAX_RASTER_SPLATS_PER_WORK_ITEM, Math.max(1, Math.floor(value)));
};

const getWorkItemBudget = (): number => {
  const params = new URLSearchParams(window.location.search);
  const depthBanded = params.get("computeTileWorkQueueOrder") === "depth-band";
  if (params.get("computeTileRasterBatch") !== "true" && !depthBanded) {
    return MAX_TILES;
  }
  const value = Number(params.get("computeTileRasterWorkItems"));
  if (!Number.isFinite(value) || value <= 0) {
    return depthBanded ? DEFAULT_RASTER_WORK_ITEM_BUDGET : DEFAULT_RASTER_WORK_ITEM_BUDGET;
  }
  return Math.min(MAX_WORK_ITEMS, Math.max(1, Math.floor(value)));
};

const getAdaptiveWorkItemBudgetCap = (): number => {
  const value = Number(new URLSearchParams(window.location.search).get("computeTileRasterWorkItemCap"));
  if (!Number.isFinite(value) || value <= 0) {
    return getDefaultWorkItemBudgetCap();
  }
  return Math.min(MAX_WORK_ITEMS, Math.max(1, Math.floor(value)));
};

const getRasterCoverageTarget = (): number => {
  const value = Number(new URLSearchParams(window.location.search).get("computeTileRasterCoverageTarget"));
  if (!Number.isFinite(value) || value <= 0) {
    return getDefaultRasterCoverageTarget();
  }
  return Math.min(1.0, Math.max(0.05, value));
};

const hasExplicitRasterCoverageTarget = (): boolean => {
  const value = Number(new URLSearchParams(window.location.search).get("computeTileRasterCoverageTarget"));
  return Number.isFinite(value) && value > 0;
};

const getDefaultMotionCoverageTarget = (): number => {
  const quality = getRasterPreviewQuality();
  if (quality === "fast") {
    return 0.6;
  }
  if (quality === "quality") {
    return 0.75;
  }
  return 0.75;
};

const getRasterMotionCoverageTarget = (coverageTarget: number, explicitCoverageTarget: boolean): number => {
  const params = new URLSearchParams(window.location.search);
  const value = Number(params.get("computeTileRasterMotionCoverageTarget"));
  if (Number.isFinite(value) && value > 0) {
    return Math.min(coverageTarget, Math.max(0.05, value));
  }
  if (params.get("computeTileRasterMotionCoverage") === "false" || explicitCoverageTarget) {
    return coverageTarget;
  }
  return Math.min(coverageTarget, getDefaultMotionCoverageTarget());
};

const hasExplicitWorkItemBudget = (): boolean => {
  const value = Number(new URLSearchParams(window.location.search).get("computeTileRasterWorkItems"));
  return Number.isFinite(value) && value > 0;
};

const getWorkQueueOrderMode = (): "compact" | "depth-band" =>
  new URLSearchParams(window.location.search).get("computeTileWorkQueueOrder") === "depth-band"
    ? "depth-band"
    : "compact";

const getStableDepthBandOrder = (): boolean => {
  const params = new URLSearchParams(window.location.search);
  if (params.get("computeTileWorkQueueStableOrder") === "true") {
    return params.get("computeTileWorkQueueOrder") === "depth-band";
  }
  if (params.get("computeTileWorkQueueStableOrder") === "false") {
    return false;
  }
  return params.get("computeTileWorkQueueOrder") === "depth-band" && getRasterPreviewQuality() === "quality";
};

const getDepthBandRangeOverride = (): number | undefined => {
  const value = Number(new URLSearchParams(window.location.search).get("computeTileDepthBandRange"));
  if (!Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.min(1024, Math.max(1, Math.floor(value)));
};

class ComputeTileWorkQueuePass {
  private readonly clearShader: ComputeShader;
  private readonly compactShader: ComputeShader;
  private readonly depthBandCountShader?: ComputeShader;
  private readonly depthBandPrefixShader?: ComputeShader;
  private readonly depthBandResetCountersShader?: ComputeShader;
  private readonly depthBandScatterShader?: ComputeShader;
  private readonly depthBandStableShader?: ComputeShader;
  private readonly workQueue: StorageBuffer;
  private readonly workDepthRanges: StorageBuffer;
  private readonly metadata: StorageBuffer;
  private readonly depthBandCounters: StorageBuffer;
  private readonly depthBandOffsets: StorageBuffer;
  private readonly params: StorageBuffer;
  private readonly paramsData = new Uint32Array(6);
  private readonly maxSplatsPerWorkItem = getMaxSplatsPerWorkItem();
  private readonly workItemBudget = getWorkItemBudget();
  private readonly adaptiveWorkItemBudgetCap = getAdaptiveWorkItemBudgetCap();
  private readonly coverageTarget = getRasterCoverageTarget();
  private readonly explicitCoverageTarget = hasExplicitRasterCoverageTarget();
  private readonly motionCoverageTarget = getRasterMotionCoverageTarget(this.coverageTarget, this.explicitCoverageTarget);
  private readonly explicitWorkItemBudget = hasExplicitWorkItemBudget();
  private readonly workQueueOrderMode = getWorkQueueOrderMode();
  private readonly stableDepthBandOrder = getStableDepthBandOrder();
  private readonly depthBandRangeOverride = getDepthBandRangeOverride();
  private readonly lastCoverageCameraPosition = new Vector3(Number.POSITIVE_INFINITY, 0, 0);
  private readonly lastCoverageCameraForward = new Vector3(0, 0, 0);
  private activeWorkItemBudget = this.workItemBudget;
  private motionCoverageFrames = 0;
  private readPending = false;
  private stats: ComputeTileWorkQueueStats = {
    enabled: true,
    dispatched: false,
    orderMode: this.workQueueOrderMode,
    depthBandCount: DEPTH_BAND_COUNT,
    stableOrder: this.stableDepthBandOrder,
    maxSplatsPerWorkItem: this.maxSplatsPerWorkItem,
    workItemBudget: this.activeWorkItemBudget,
    workItemBudgetCap: this.adaptiveWorkItemBudgetCap,
    coverageTarget: this.coverageTarget,
    explicitWorkItemBudget: this.explicitWorkItemBudget,
    workTiles: 0,
    queuedSplats: 0,
    maxTileSplats: 0,
    avgTileSplats: 0,
    overflowTiles: 0,
    lastDispatchMs: 0,
  };

  constructor(
    private readonly scene: Scene,
    private readonly tileStatsPass: ComputeTileStatsPass,
    private readonly tileDepthRangePass: ComputeTileDepthRangePass,
  ) {
    const engine = scene.getEngine() as WebGPUEngine;
    this.workQueue = new StorageBuffer(engine, MAX_WORK_ITEMS * 4 * 4, undefined, "ComputeTileWorkQueue");
    this.workQueue.update(new Uint32Array(MAX_WORK_ITEMS * 4));
    this.workDepthRanges = new StorageBuffer(engine, MAX_WORK_ITEMS * 4 * 4, undefined, "ComputeTileWorkDepthRanges");
    this.workDepthRanges.update(new Float32Array(MAX_WORK_ITEMS * 4));
    this.metadata = new StorageBuffer(engine, METADATA_COUNT * 4, undefined, "ComputeTileWorkQueueMetadata");
    this.metadata.update(new Uint32Array(METADATA_COUNT));
    this.depthBandCounters = new StorageBuffer(
      engine,
      DEPTH_BAND_COUNT * 4,
      undefined,
      "ComputeTileWorkQueueDepthBandCounters",
    );
    this.depthBandCounters.update(new Uint32Array(DEPTH_BAND_COUNT));
    this.depthBandOffsets = new StorageBuffer(
      engine,
      DEPTH_BAND_COUNT * 4,
      undefined,
      "ComputeTileWorkQueueDepthBandOffsets",
    );
    this.depthBandOffsets.update(new Uint32Array(DEPTH_BAND_COUNT));
    this.params = new StorageBuffer(engine, this.paramsData.byteLength, undefined, "ComputeTileWorkQueueParams");

    this.clearShader = new ComputeShader(
      "ComputeTileWorkQueueClear",
      engine,
      { computeSource: CLEAR_SOURCE },
      {
        bindingsMapping: {
          metadata: { group: 0, binding: 0 },
          depthBandCounters: { group: 0, binding: 1 },
          depthBandOffsets: { group: 0, binding: 2 },
        },
      },
    );
    this.clearShader.setStorageBuffer("metadata", this.metadata);
    this.clearShader.setStorageBuffer("depthBandCounters", this.depthBandCounters);
    this.clearShader.setStorageBuffer("depthBandOffsets", this.depthBandOffsets);

    this.compactShader = new ComputeShader(
      "ComputeTileWorkQueueCompact",
      engine,
      { computeSource: COMPACT_SOURCE },
      {
        bindingsMapping: {
          tileCounters: { group: 0, binding: 0 },
          tileOffsets: { group: 0, binding: 1 },
          depthRanges: { group: 0, binding: 2 },
          workQueue: { group: 0, binding: 3 },
          workDepthRanges: { group: 0, binding: 4 },
          metadata: { group: 0, binding: 5 },
          paramsBuffer: { group: 0, binding: 6 },
        },
      },
    );
    this.compactShader.setStorageBuffer("tileCounters", this.tileStatsPass.getTileCountersBuffer());
    this.compactShader.setStorageBuffer("tileOffsets", this.tileStatsPass.getTileOffsetsBuffer());
    this.compactShader.setStorageBuffer("depthRanges", this.tileDepthRangePass.getDepthRangesBuffer());
    this.compactShader.setStorageBuffer("workQueue", this.workQueue);
    this.compactShader.setStorageBuffer("workDepthRanges", this.workDepthRanges);
    this.compactShader.setStorageBuffer("metadata", this.metadata);
    this.compactShader.setStorageBuffer("paramsBuffer", this.params);
    if (this.workQueueOrderMode === "depth-band" && this.stableDepthBandOrder) {
      this.depthBandStableShader = new ComputeShader(
        "ComputeTileWorkQueueDepthBandStable",
        engine,
        { computeSource: DEPTH_BAND_STABLE_SOURCE },
        {
          bindingsMapping: {
            tileCounters: { group: 0, binding: 0 },
            tileOffsets: { group: 0, binding: 1 },
            depthRanges: { group: 0, binding: 2 },
            workQueue: { group: 0, binding: 3 },
            metadata: { group: 0, binding: 4 },
            paramsBuffer: { group: 0, binding: 5 },
          },
        },
      );
      this.depthBandStableShader.setStorageBuffer("tileCounters", this.tileStatsPass.getTileCountersBuffer());
      this.depthBandStableShader.setStorageBuffer("tileOffsets", this.tileStatsPass.getTileOffsetsBuffer());
      this.depthBandStableShader.setStorageBuffer("depthRanges", this.tileDepthRangePass.getDepthRangesBuffer());
      this.depthBandStableShader.setStorageBuffer("workQueue", this.workQueue);
      this.depthBandStableShader.setStorageBuffer("metadata", this.metadata);
      this.depthBandStableShader.setStorageBuffer("paramsBuffer", this.params);
    } else if (this.workQueueOrderMode === "depth-band") {
      this.depthBandCountShader = new ComputeShader(
        "ComputeTileWorkQueueDepthBandCount",
        engine,
        { computeSource: DEPTH_BAND_COUNT_SOURCE },
        {
          bindingsMapping: {
            tileCounters: { group: 0, binding: 0 },
            depthRanges: { group: 0, binding: 1 },
            depthBandCounters: { group: 0, binding: 2 },
            paramsBuffer: { group: 0, binding: 3 },
          },
        },
      );
      this.depthBandCountShader.setStorageBuffer("tileCounters", this.tileStatsPass.getTileCountersBuffer());
      this.depthBandCountShader.setStorageBuffer("depthRanges", this.tileDepthRangePass.getDepthRangesBuffer());
      this.depthBandCountShader.setStorageBuffer("depthBandCounters", this.depthBandCounters);
      this.depthBandCountShader.setStorageBuffer("paramsBuffer", this.params);

      this.depthBandPrefixShader = new ComputeShader(
        "ComputeTileWorkQueueDepthBandPrefix",
        engine,
        { computeSource: DEPTH_BAND_PREFIX_SOURCE },
        {
          bindingsMapping: {
            depthBandCounters: { group: 0, binding: 0 },
            depthBandOffsets: { group: 0, binding: 1 },
            metadata: { group: 0, binding: 2 },
            paramsBuffer: { group: 0, binding: 3 },
          },
        },
      );
      this.depthBandPrefixShader.setStorageBuffer("depthBandCounters", this.depthBandCounters);
      this.depthBandPrefixShader.setStorageBuffer("depthBandOffsets", this.depthBandOffsets);
      this.depthBandPrefixShader.setStorageBuffer("metadata", this.metadata);
      this.depthBandPrefixShader.setStorageBuffer("paramsBuffer", this.params);

      this.depthBandResetCountersShader = new ComputeShader(
        "ComputeTileWorkQueueDepthBandResetCounters",
        engine,
        { computeSource: DEPTH_BAND_RESET_COUNTERS_SOURCE },
        {
          bindingsMapping: {
            depthBandCounters: { group: 0, binding: 0 },
          },
        },
      );
      this.depthBandResetCountersShader.setStorageBuffer("depthBandCounters", this.depthBandCounters);

      this.depthBandScatterShader = new ComputeShader(
        "ComputeTileWorkQueueDepthBandScatter",
        engine,
        { computeSource: DEPTH_BAND_SCATTER_SOURCE },
        {
          bindingsMapping: {
            tileCounters: { group: 0, binding: 0 },
            tileOffsets: { group: 0, binding: 1 },
            depthRanges: { group: 0, binding: 2 },
            workQueue: { group: 0, binding: 3 },
            metadata: { group: 0, binding: 4 },
            paramsBuffer: { group: 0, binding: 5 },
            depthBandCounters: { group: 0, binding: 6 },
            depthBandOffsets: { group: 0, binding: 7 },
          },
        },
      );
      this.depthBandScatterShader.setStorageBuffer("tileCounters", this.tileStatsPass.getTileCountersBuffer());
      this.depthBandScatterShader.setStorageBuffer("tileOffsets", this.tileStatsPass.getTileOffsetsBuffer());
      this.depthBandScatterShader.setStorageBuffer("depthRanges", this.tileDepthRangePass.getDepthRangesBuffer());
      this.depthBandScatterShader.setStorageBuffer("workQueue", this.workQueue);
      this.depthBandScatterShader.setStorageBuffer("metadata", this.metadata);
      this.depthBandScatterShader.setStorageBuffer("paramsBuffer", this.params);
      this.depthBandScatterShader.setStorageBuffer("depthBandCounters", this.depthBandCounters);
      this.depthBandScatterShader.setStorageBuffer("depthBandOffsets", this.depthBandOffsets);
    }
  }

  static isEnabled(): boolean {
    return isEnabled();
  }

  static isSupported(scene: Scene): boolean {
    return canCreateComputeShader(scene);
  }

  dispose(): void {
    this.workQueue.dispose();
    this.workDepthRanges.dispose();
    this.metadata.dispose();
    this.depthBandCounters.dispose();
    this.depthBandOffsets.dispose();
    this.params.dispose();
  }

  dispatch(): boolean {
    const tileStats = this.tileStatsPass.getStats();
    const depthStats = this.tileDepthRangePass.getStats();
    if (!tileStats.tileListScatterDispatched || !depthStats.dispatched || tileStats.tileCount <= 0) {
      return false;
    }

    const start = performance.now();
    const runtimeCoverageTarget = this.getRuntimeCoverageTarget();
    this.paramsData[0] = tileStats.tileCount;
    this.paramsData[1] = this.maxSplatsPerWorkItem;
    const adaptiveWorkItemBudget =
      this.workQueueOrderMode === "depth-band" && !this.explicitWorkItemBudget && this.maxSplatsPerWorkItem > 0
        ? Math.ceil(
            (Math.max(tileStats.visibleSplats, tileStats.tileListEntries) / this.maxSplatsPerWorkItem) *
              runtimeCoverageTarget,
          )
        : this.workItemBudget;
    this.paramsData[2] = Math.min(
      MAX_WORK_ITEMS,
      this.explicitWorkItemBudget ? this.workItemBudget : Math.max(this.workItemBudget, Math.min(this.adaptiveWorkItemBudgetCap, adaptiveWorkItemBudget)),
    );
    this.activeWorkItemBudget = this.paramsData[2];
    this.paramsData[3] = this.depthBandRangeOverride ?? 0;
    const minDepth =
      this.depthBandRangeOverride !== undefined ? 0 : Math.max(0, Math.floor(depthStats.minDepth * DEPTH_BAND_QUANTIZATION));
    const depthRange =
      this.depthBandRangeOverride !== undefined
        ? this.depthBandRangeOverride * DEPTH_BAND_QUANTIZATION
        : Math.max(1, Math.ceil(Math.max(0.001, depthStats.maxDepth - depthStats.minDepth) * DEPTH_BAND_QUANTIZATION));
    this.paramsData[4] = minDepth;
    this.paramsData[5] = depthRange;
    this.params.update(this.paramsData);
    const cleared = this.clearShader.dispatch(1);
    const dispatchCount = Math.ceil(tileStats.tileCount / WORKGROUP_SIZE);
    const dispatched =
      this.workQueueOrderMode === "depth-band"
        ? this.stableDepthBandOrder
          ? cleared && !!this.depthBandStableShader?.dispatch(1)
          : cleared &&
          !!this.depthBandCountShader?.dispatch(dispatchCount) &&
          !!this.depthBandPrefixShader?.dispatch(1) &&
          !!this.depthBandResetCountersShader?.dispatch(1) &&
          !!this.depthBandScatterShader?.dispatch(dispatchCount)
        : cleared && this.compactShader.dispatch(dispatchCount);
    if (dispatched) {
      this.stats = {
        ...this.stats,
        dispatched: true,
        orderMode: this.workQueueOrderMode,
        depthBandCount: DEPTH_BAND_COUNT,
        stableOrder: this.stableDepthBandOrder,
        maxSplatsPerWorkItem: this.maxSplatsPerWorkItem,
        workItemBudget: this.activeWorkItemBudget,
        workItemBudgetCap: this.adaptiveWorkItemBudgetCap,
        coverageTarget: runtimeCoverageTarget,
        explicitWorkItemBudget: this.explicitWorkItemBudget,
        lastDispatchMs: performance.now() - start,
      };
      this.scheduleReadback();
    }
    return dispatched;
  }

  getStats(): ComputeTileWorkQueueStats {
    return this.stats;
  }

  getWorkQueueBuffer(): StorageBuffer {
    return this.workQueue;
  }

  getWorkDepthRangesBuffer(): StorageBuffer {
    return this.workDepthRanges;
  }

  private scheduleReadback(): void {
    if (this.readPending) {
      return;
    }
    this.readPending = true;
    void this.metadata
      .read(0, METADATA_COUNT * 4)
      .then((metadataView) => {
        const metadata = new Uint32Array(
          metadataView.buffer,
          metadataView.byteOffset,
          metadataView.byteLength / 4,
        );
        const workTiles = metadata[0];
        const queuedSplats = metadata[1];
        this.stats = {
          ...this.stats,
          workTiles,
          queuedSplats,
          maxTileSplats: metadata[2],
          avgTileSplats: workTiles > 0 ? queuedSplats / workTiles : 0,
          overflowTiles: metadata[3],
        };
      })
      .catch(() => {
        this.stats = {
          ...this.stats,
          workTiles: 0,
          queuedSplats: 0,
          maxTileSplats: 0,
          avgTileSplats: 0,
          overflowTiles: 0,
        };
      })
      .finally(() => {
        this.readPending = false;
      });
  }

  private getRuntimeCoverageTarget(): number {
    if (this.motionCoverageTarget >= this.coverageTarget) {
      return this.coverageTarget;
    }

    const camera = this.scene.activeCamera;
    if (!camera) {
      return this.coverageTarget;
    }

    const cameraPosition = camera.globalPosition;
    const cameraForward = camera.getDirection(Vector3.Forward());
    const initialized = Number.isFinite(this.lastCoverageCameraPosition.x);
    const moving =
      initialized &&
      (Vector3.DistanceSquared(cameraPosition, this.lastCoverageCameraPosition) > MOTION_COVERAGE_MOVE_EPSILON_SQ ||
        Vector3.Dot(cameraForward, this.lastCoverageCameraForward) < MOTION_COVERAGE_FORWARD_DOT);

    this.lastCoverageCameraPosition.copyFrom(cameraPosition);
    this.lastCoverageCameraForward.copyFrom(cameraForward);
    if (moving) {
      this.motionCoverageFrames = MOTION_COVERAGE_HOLD_FRAMES;
    } else if (this.motionCoverageFrames > 0) {
      this.motionCoverageFrames--;
    }

    return this.motionCoverageFrames > 0 ? this.motionCoverageTarget : this.coverageTarget;
  }
}

export { ComputeTileWorkQueuePass };
export type { ComputeTileWorkQueueStats };
