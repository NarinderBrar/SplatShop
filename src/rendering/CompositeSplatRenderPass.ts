import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Scene } from "@babylonjs/core/scene";

import type { SsogPackedChunk } from "../splat/SplatAsset";
import { selectSsogLod } from "../splat/SsogLodSelector";
import type { PackedSogRenderPass, PackedSogRenderStats } from "./PackedSogRenderPass";
import type { SplatRenderPass, SplatRenderStats } from "./SplatRenderPass";

type RenderPassLike = SplatRenderPass | PackedSogRenderPass;

type CompositeSplatRenderPassOptions = {
  scene: Scene;
  chunks: SsogPackedChunk[];
  passes: RenderPassLike[];
};

type ChunkRuntime = {
  chunk: SsogPackedChunk;
  pass: RenderPassLike;
  center: Vector3;
  radius: number;
  active: boolean;
};

const LOD_SELECT_INTERVAL_FRAMES = 15;

const getSplatBudget = (sourceSplats: number): number => {
  const params = new URLSearchParams(window.location.search);
  const explicit = Number(params.get("splatBudget"));
  if (Number.isFinite(explicit) && explicit > 0) {
    return Math.floor(explicit);
  }

  const quality = params.get("quality");
  if (quality === "fast") {
    return Math.min(sourceSplats, 1_000_000);
  }
  if (quality === "balanced") {
    return Math.min(sourceSplats, 2_000_000);
  }
  return sourceSplats;
};

const getLodRangeMin = (): number => {
  const value = Number(new URLSearchParams(window.location.search).get("lodRangeMin"));
  return Number.isFinite(value) && value > 0 ? value : 0.0005;
};

const getLodRangeMax = (): number => {
  const value = Number(new URLSearchParams(window.location.search).get("lodRangeMax"));
  return Number.isFinite(value) && value > 0 ? value : 0.15;
};

const getLodUnderfillLimit = (): number => {
  const value = Number(new URLSearchParams(window.location.search).get("lodUnderfillLimit"));
  return Number.isFinite(value) && value > 0 ? value : 0.85;
};

const getLodMoveEpsilonSq = (): number => {
  const value = Number(new URLSearchParams(window.location.search).get("lodMoveEpsilon"));
  const epsilon = Number.isFinite(value) && value > 0 ? value : 0.08;
  return epsilon * epsilon;
};

const getLodForwardDotThreshold = (): number => {
  const value = Number(new URLSearchParams(window.location.search).get("lodAngleDegrees"));
  const degrees = Number.isFinite(value) && value > 0 ? value : 1.0;
  return Math.cos((degrees * Math.PI) / 180);
};

class CompositeSplatRenderPass {
  private readonly scene: Scene;
  private readonly runtimes: ChunkRuntime[];
  private readonly updateObserver: () => void;
  private readonly sourceSplats: number;
  private readonly splatBudget: number;
  private readonly lodRangeMin = getLodRangeMin();
  private readonly lodRangeMax = getLodRangeMax();
  private readonly lodUnderfillLimit = getLodUnderfillLimit();
  private readonly lodMoveEpsilonSq = getLodMoveEpsilonSq();
  private readonly lodForwardDotThreshold = getLodForwardDotThreshold();
  private frame = 0;
  private lastLodCameraPosition = new Vector3(Number.POSITIVE_INFINITY, 0, 0);
  private lastLodCameraForward = new Vector3(0, 0, 0);
  private activeChunks = 0;
  private selectedLods = 0;
  private lastLodBuildMs = 0;

  constructor(options: CompositeSplatRenderPassOptions) {
    const { scene, chunks, passes } = options;
    this.scene = scene;
    this.runtimes = chunks.map((chunk, index) => {
      const min = Vector3.FromArray(chunk.bound.min);
      const max = Vector3.FromArray(chunk.bound.max);
      const center = min.add(max).scaleInPlace(0.5);
      return {
        chunk,
        pass: passes[index],
        center,
        radius: Math.max(0.001, Vector3.Distance(center, max)),
        active: true,
      };
    });
    this.sourceSplats = chunks.reduce((sum, chunk) => sum + chunk.data.numSplats, 0);
    this.splatBudget = getSplatBudget(this.sourceSplats);
    this.updateObserver = () => this.updateLodSelection(scene);
    scene.registerBeforeRender(this.updateObserver);
    this.updateLodSelection(scene, true);
  }

  dispose(): void {
    this.scene.unregisterBeforeRender(this.updateObserver);
    this.runtimes.forEach((runtime) => runtime.pass.dispose());
  }

  setVizMode(mode: number): void {
    this.runtimes.forEach((runtime) => {
      if ("setVizMode" in runtime.pass) {
        (runtime.pass as unknown as { setVizMode: (m: number) => void }).setVizMode(mode);
      }
    });
  }

  getStats(): SplatRenderStats | PackedSogRenderStats {
    const stats = this.runtimes.filter((runtime) => runtime.active).map((runtime) => runtime.pass.getStats());
    const first = stats[0];

    return {
      renderSplats: stats.reduce((sum, item) => sum + item.renderSplats, 0),
      chunkCount: stats.reduce((sum, item) => sum + item.chunkCount, 0),
      activeChunks: this.activeChunks,
      selectedLods: this.selectedLods,
      rendererMode: `ssog-composite-${first?.rendererMode ?? "none"}`,
      rendererRequested: first?.rendererRequested ?? "auto",
      rendererEffective: first?.rendererEffective ?? "cpu",
      rendererFallbackReason: first?.rendererFallbackReason ?? "",
      computeRendererEnabled: stats.some((item) => item.computeRendererEnabled),
      computeRendererPhase:
        stats.find((item) => item.computeRendererEnabled)?.computeRendererPhase ?? "disabled",
      colorMode: stats.some((item) => item.colorMode === "sh") ? "sh" : "dc",
      shNFileCount: stats.reduce((sum, item) => sum + item.shNFileCount, 0),
      shNCodebookLength: stats.reduce((sum, item) => sum + item.shNCodebookLength, 0),
      shBands: Math.max(0, ...stats.map((item) => item.shBands)),
      shCoeffCount: Math.max(0, ...stats.map((item) => item.shCoeffCount)),
      shPaletteCount: stats.reduce((sum, item) => sum + item.shPaletteCount, 0),
      shRenderMode: stats.some((item) => item.shRenderMode === "cpu")
        ? "cpu"
        : stats.some((item) => item.shRenderMode === "loaded")
          ? "loaded"
          : "dc",
      computeTileStatsEnabled: stats.some((item) => item.computeTileStatsEnabled),
      computeTileStatsDispatched: stats.some((item) => item.computeTileStatsDispatched),
      computeTileSize: first?.computeTileSize ?? 0,
      computeTileCount: stats.reduce((sum, item) => sum + item.computeTileCount, 0),
      computeTileCols: first?.computeTileCols ?? 0,
      computeTileRows: first?.computeTileRows ?? 0,
      computeOccupiedTiles: stats.reduce((sum, item) => sum + item.computeOccupiedTiles, 0),
      computeMaxTileOccupancy: stats.reduce((max, item) => Math.max(max, item.computeMaxTileOccupancy), 0),
      computeVisibleSplats: stats.reduce((sum, item) => sum + item.computeVisibleSplats, 0),
      computeBehindSplats: stats.reduce((sum, item) => sum + item.computeBehindSplats, 0),
      computeClippedSplats: stats.reduce((sum, item) => sum + item.computeClippedSplats, 0),
      computeOverflowSplats: stats.reduce((sum, item) => sum + item.computeOverflowSplats, 0),
      computeTileOffsetsDispatched: stats.some((item) => item.computeTileOffsetsDispatched),
      computeTileListScatterDispatched: stats.some((item) => item.computeTileListScatterDispatched),
      computeTileListValidated: stats.length > 0 && stats.every((item) => item.computeTileListValidated),
      computeTileListEntries: stats.reduce((sum, item) => sum + item.computeTileListEntries, 0),
      computeTileListCapacity: stats.reduce((sum, item) => sum + item.computeTileListCapacity, 0),
      computeTileOffsetEntries: stats.reduce((sum, item) => sum + item.computeTileOffsetEntries, 0),
      computeTileCursorEntries: stats.reduce((sum, item) => sum + item.computeTileCursorEntries, 0),
      computeTileListMismatchedTiles: stats.reduce((sum, item) => sum + item.computeTileListMismatchedTiles, 0),
      lastComputeTileStatsMs: stats.reduce((sum, item) => sum + item.lastComputeTileStatsMs, 0),
      lastComputeTileOffsetMs: stats.reduce((sum, item) => sum + item.lastComputeTileOffsetMs, 0),
      lastComputeTileListScatterMs: stats.reduce((sum, item) => sum + item.lastComputeTileListScatterMs, 0),
      computeTileDepthEnabled: stats.some((item) => item.computeTileDepthEnabled),
      computeTileDepthDispatched: stats.some((item) => item.computeTileDepthDispatched),
      computeTileDepthTiles: stats.reduce((sum, item) => sum + item.computeTileDepthTiles, 0),
      computeTileDepthMin: stats.reduce(
        (min, item) => (item.computeTileDepthMin > 0 ? Math.min(min, item.computeTileDepthMin) : min),
        Number.POSITIVE_INFINITY,
      ),
      computeTileDepthMax: stats.reduce((max, item) => Math.max(max, item.computeTileDepthMax), 0),
      computeTileDepthMaxSpan: stats.reduce((max, item) => Math.max(max, item.computeTileDepthMaxSpan), 0),
      computeTileDepthAvgSpan:
        stats.reduce((sum, item) => sum + item.computeTileDepthAvgSpan * item.computeTileDepthTiles, 0) /
        Math.max(1, stats.reduce((sum, item) => sum + item.computeTileDepthTiles, 0)),
      lastComputeTileDepthMs: stats.reduce((sum, item) => sum + item.lastComputeTileDepthMs, 0),
      computeTileWorkQueueEnabled: stats.some((item) => item.computeTileWorkQueueEnabled),
      computeTileWorkQueueDispatched: stats.some((item) => item.computeTileWorkQueueDispatched),
      computeTileWorkQueueOrderMode: first?.computeTileWorkQueueOrderMode ?? "compact",
      computeTileWorkQueueDepthBands: first?.computeTileWorkQueueDepthBands ?? 0,
      computeTileWorkQueueStableOrder: first?.computeTileWorkQueueStableOrder ?? false,
      computeTileWorkQueueMaxSplatsPerItemConfig: first?.computeTileWorkQueueMaxSplatsPerItemConfig ?? 0,
      computeTileWorkQueueBudget: stats.reduce((sum, item) => sum + item.computeTileWorkQueueBudget, 0),
      computeTileWorkQueueBudgetCap: stats.reduce((sum, item) => sum + item.computeTileWorkQueueBudgetCap, 0),
      computeTileWorkQueueCoverageTarget: first?.computeTileWorkQueueCoverageTarget ?? 1,
      computeTileWorkQueueExplicitBudget: stats.some((item) => item.computeTileWorkQueueExplicitBudget),
      computeTileWorkQueueTiles: stats.reduce((sum, item) => sum + item.computeTileWorkQueueTiles, 0),
      computeTileWorkQueueSplats: stats.reduce((sum, item) => sum + item.computeTileWorkQueueSplats, 0),
      computeTileWorkQueueMaxTileSplats: stats.reduce(
        (max, item) => Math.max(max, item.computeTileWorkQueueMaxTileSplats),
        0,
      ),
      computeTileWorkQueueAvgTileSplats:
        stats.reduce((sum, item) => sum + item.computeTileWorkQueueSplats, 0) /
        Math.max(1, stats.reduce((sum, item) => sum + item.computeTileWorkQueueTiles, 0)),
      computeTileWorkQueueOverflowTiles: stats.reduce(
        (sum, item) => sum + item.computeTileWorkQueueOverflowTiles,
        0,
      ),
      lastComputeTileWorkQueueMs: stats.reduce((sum, item) => sum + item.lastComputeTileWorkQueueMs, 0),
      computeTileOrderEnabled: stats.some((item) => item.computeTileOrderEnabled),
      computeTileOrderDispatched: stats.some((item) => item.computeTileOrderDispatched),
      computeTileOrderBuckets: first?.computeTileOrderBuckets ?? 0,
      computeTileOrderSplats: stats.reduce((sum, item) => sum + item.computeTileOrderSplats, 0),
      lastComputeTileOrderMs: stats.reduce((sum, item) => sum + item.lastComputeTileOrderMs, 0),
      computeTileSplatPreviewEnabled: stats.some((item) => item.computeTileSplatPreviewEnabled),
      computeTileSplatPreviewSamplesPerTile: first?.computeTileSplatPreviewSamplesPerTile ?? 0,
      computeTileSplatPreviewSplats: stats.reduce((sum, item) => sum + item.computeTileSplatPreviewSplats, 0),
      computeTileSplatPreviewActiveTiles: stats.reduce(
        (sum, item) => sum + item.computeTileSplatPreviewActiveTiles,
        0,
      ),
      computeTileSplatPreviewWorkTiles: stats.reduce(
        (sum, item) => sum + item.computeTileSplatPreviewWorkTiles,
        0,
      ),
      computeTileSplatPreviewColorMode: first?.computeTileSplatPreviewColorMode ?? "debug",
      computeTileSplatPreviewShapeMode: first?.computeTileSplatPreviewShapeMode ?? "marker",
      computeTileRasterPreviewEnabled: stats.some((item) => item.computeTileRasterPreviewEnabled),
      computeTileRasterPreviewSamplesPerTile: first?.computeTileRasterPreviewSamplesPerTile ?? 0,
      computeTileRasterPreviewSplats: stats.reduce((sum, item) => sum + item.computeTileRasterPreviewSplats, 0),
      computeTileRasterPreviewWindowSplats: stats.reduce(
        (sum, item) => sum + (item.computeTileRasterPreviewWindowSplats ?? 0),
        0,
      ),
      computeTileRasterPreviewSampledCoverage:
        (first?.computeTileRasterPreviewSampledCoverage ?? 0),
      computeTileRasterPreviewWindowCoverage:
        (first?.computeTileRasterPreviewWindowCoverage ?? 0),
      computeTileRasterPreviewActiveTiles: stats.reduce(
        (sum, item) => sum + item.computeTileRasterPreviewActiveTiles,
        0,
      ),
      computeTileRasterPreviewWorkTiles: stats.reduce(
        (sum, item) => sum + item.computeTileRasterPreviewWorkTiles,
        0,
      ),
      computeTileRasterPreviewDrawLimit: first?.computeTileRasterPreviewDrawLimit ?? 0,
      computeTileRasterPreviewStaticDrawLimit: first?.computeTileRasterPreviewStaticDrawLimit ?? 0,
      computeTileRasterPreviewRequestedDrawLimit: first?.computeTileRasterPreviewRequestedDrawLimit ?? 0,
      computeTileRasterPreviewMotionDrawLimit: first?.computeTileRasterPreviewMotionDrawLimit ?? 0,
      computeTileRasterPreviewAdaptiveScale: first?.computeTileRasterPreviewAdaptiveScale ?? 1,
      computeTileRasterPreviewFrameMs: first?.computeTileRasterPreviewFrameMs ?? 0,
      computeTileRasterPreviewMaxMarkerPixels: first?.computeTileRasterPreviewMaxMarkerPixels ?? 0,
      computeTileRasterPreviewStaticRamp: first?.computeTileRasterPreviewStaticRamp ?? 1,
      computeTileRasterPreviewDrawOrder: first?.computeTileRasterPreviewDrawOrder ?? "far",
      computeTileRasterPreviewWindowMode: first?.computeTileRasterPreviewWindowMode ?? "sampled",
      computeTileRasterPreviewCoverageMode: first?.computeTileRasterPreviewCoverageMode ?? "sampled",
      computeTileRasterPreviewTruncatedSplats: stats.reduce(
        (sum, item) => sum + (item.computeTileRasterPreviewTruncatedSplats ?? 0),
        0,
      ),
      computeTileRasterPreviewNearWindowMargin: first?.computeTileRasterPreviewNearWindowMargin ?? 0,
      computeTileRasterPreviewSampleAlphaCompensation:
        first?.computeTileRasterPreviewSampleAlphaCompensation ?? 1,
      computeTileRasterPreviewRuntimeSampleAlphaCompensation:
        first?.computeTileRasterPreviewRuntimeSampleAlphaCompensation ?? 1,
      computeTileRasterPreviewSamplePasses: first?.computeTileRasterPreviewSamplePasses ?? 1,
      computeTileRasterPreviewMaxUsefulSamplePasses:
        first?.computeTileRasterPreviewMaxUsefulSamplePasses ?? 1,
      computeTileRasterPreviewStaticSamplePasses:
        first?.computeTileRasterPreviewStaticSamplePasses ?? 1,
      computeTileRasterPreviewMotionSamplePasses:
        first?.computeTileRasterPreviewMotionSamplePasses ?? 1,
      computeTileRasterPreviewSampleCoverageTarget:
        first?.computeTileRasterPreviewSampleCoverageTarget ?? 1,
      computeTileRasterPreviewMotionSampleCoverageTarget:
        first?.computeTileRasterPreviewMotionSampleCoverageTarget ?? 1,
      computeTileRasterPreviewRuntimeSampleCoverageTarget:
        first?.computeTileRasterPreviewRuntimeSampleCoverageTarget ?? 1,
      computeTileRasterPreviewSamplePassesAdaptive:
        first?.computeTileRasterPreviewSamplePassesAdaptive ?? false,
      computeTileRasterPreviewDrawCoverageTarget:
        first?.computeTileRasterPreviewDrawCoverageTarget ?? 0,
      computeTileRasterPreviewMotionDrawCoverageTarget:
        first?.computeTileRasterPreviewMotionDrawCoverageTarget ?? 0,
      computeTileRasterPreviewRuntimeDrawCoverageTarget:
        first?.computeTileRasterPreviewRuntimeDrawCoverageTarget ?? 0,
      computeTileRasterPreviewDrawCoverageAdaptive:
        first?.computeTileRasterPreviewDrawCoverageAdaptive ?? false,
      computeTileRasterPreviewColorMode: first?.computeTileRasterPreviewColorMode ?? "debug",
      computeTileRasterPreviewShapeMode: first?.computeTileRasterPreviewShapeMode ?? "marker",
      computeTileUpdateInterval: first?.computeTileUpdateInterval ?? 1,
      sortMode: first?.sortMode ?? "auto",
      sortPending: stats.some((item) => item.sortPending),
      lastSortMs: stats.reduce((sum, item) => sum + item.lastSortMs, 0),
      lastUploadMs: stats.reduce((sum, item) => sum + item.lastUploadMs, 0),
      lastLodBuildMs: this.lastLodBuildMs + stats.reduce((sum, item) => sum + item.lastLodBuildMs, 0),
      gpuDepthKeyEnabled: stats.some((item) => item.gpuDepthKeyEnabled),
      gpuDepthKeyDispatched: stats.some((item) => item.gpuDepthKeyDispatched),
      lastGpuDepthKeyMs: stats.reduce((sum, item) => sum + item.lastGpuDepthKeyMs, 0),
      lastGpuDepthKeySplats: stats.reduce((sum, item) => sum + item.lastGpuDepthKeySplats, 0),
      gpuSortHistogramEnabled: stats.some((item) => item.gpuSortHistogramEnabled),
      gpuSortHistogramDispatched: stats.some((item) => item.gpuSortHistogramDispatched),
      lastGpuSortHistogramMs: stats.reduce((sum, item) => sum + item.lastGpuSortHistogramMs, 0),
      lastGpuSortHistogramSplats: stats.reduce((sum, item) => sum + item.lastGpuSortHistogramSplats, 0),
      gpuSortHistogramBuckets: first?.gpuSortHistogramBuckets ?? 0,
      gpuSortPrefixSumEnabled: stats.some((item) => item.gpuSortPrefixSumEnabled),
      gpuSortPrefixSumDispatched: stats.some((item) => item.gpuSortPrefixSumDispatched),
      lastGpuSortPrefixSumMs: stats.reduce((sum, item) => sum + item.lastGpuSortPrefixSumMs, 0),
      gpuSortPrefixSumBuckets: first?.gpuSortPrefixSumBuckets ?? 0,
      gpuSortMode: first?.gpuSortMode ?? "shadow",
      gpuSortScatterEnabled: stats.some((item) => item.gpuSortScatterEnabled),
      gpuSortScatterDispatched: stats.some((item) => item.gpuSortScatterDispatched),
      lastGpuSortScatterMs: stats.reduce((sum, item) => sum + item.lastGpuSortScatterMs, 0),
      lastGpuSortScatterSplats: stats.reduce((sum, item) => sum + item.lastGpuSortScatterSplats, 0),
      gpuRadixSortEnabled: stats.some((item) => item.gpuRadixSortEnabled),
      gpuRadixSortDispatched: stats.some((item) => item.gpuRadixSortDispatched),
      lastGpuRadixSortMs: stats.reduce((sum, item) => sum + item.lastGpuRadixSortMs, 0),
      lastGpuRadixSortSplats: stats.reduce((sum, item) => sum + item.lastGpuRadixSortSplats, 0),
      gpuRadixSortBits: first?.gpuRadixSortBits ?? 0,
      gpuRadixSortPasses: first?.gpuRadixSortPasses ?? 0,
      gpuSortVisibleMode: first?.gpuSortVisibleMode ?? "cpu",
      gpuSortVisibleEffective: first?.gpuSortVisibleEffective ?? "cpu",
      gpuRadixValidationEnabled: stats.some((item) => item.gpuRadixValidationEnabled),
      gpuRadixValidationPending: stats.some((item) => item.gpuRadixValidationPending),
      gpuRadixValidationSamples: stats.reduce((sum, item) => sum + item.gpuRadixValidationSamples, 0),
      gpuRadixAscendingViolations: stats.reduce((sum, item) => sum + item.gpuRadixAscendingViolations, 0),
      gpuRadixDescendingViolations: stats.reduce((sum, item) => sum + item.gpuRadixDescendingViolations, 0),
      gpuRadixOutOfRangeIndices: stats.reduce((sum, item) => sum + item.gpuRadixOutOfRangeIndices, 0),
      gpuRadixDuplicateAdjacentIndices: stats.reduce((sum, item) => sum + item.gpuRadixDuplicateAdjacentIndices, 0),
      gpuRadixChecksumValid: stats.length > 0 && stats.every((item) => item.gpuRadixChecksumValid),
      gpuRadixValidatedIndexCount: stats.reduce((sum, item) => sum + item.gpuRadixValidatedIndexCount, 0),
    };
  }

  private setPassEnabled(pass: RenderPassLike, enabled: boolean): void {
    const maybePass = pass as unknown as { setEnabled?: (enabled: boolean) => void };
    maybePass.setEnabled?.(enabled);
  }

  private updateLodSelection(scene: Scene, force = false): void {
    this.frame = (this.frame + 1) % LOD_SELECT_INTERVAL_FRAMES;

    const camera = scene.activeCamera;
    if (!camera) {
      return;
    }

    const cameraPosition = camera.globalPosition;
    const cameraForward = camera.getDirection(Vector3.Forward());
    const initial = !Number.isFinite(this.lastLodCameraPosition.x);
    const moved = Vector3.DistanceSquared(cameraPosition, this.lastLodCameraPosition) > this.lodMoveEpsilonSq;
    const turned = Vector3.Dot(cameraForward, this.lastLodCameraForward) < this.lodForwardDotThreshold;
    if (!force && this.frame !== 1 && !initial && !moved && !turned) {
      return;
    }

    const start = performance.now();
    const fov = "fov" in camera && typeof camera.fov === "number" ? camera.fov : Math.PI / 3;
    const viewportHeight = scene.getEngine().getRenderHeight(true);
    const focalPixels = viewportHeight / Math.max(0.001, 2 * Math.tan(fov * 0.5));
    const selectedKeys = new Set(
      selectSsogLod(
        this.runtimes.map((runtime, index) => ({
          value: runtime,
          key: String(index),
          nodeId: runtime.chunk.nodeId,
          parentNodeId: runtime.chunk.parentNodeId,
          depth: runtime.chunk.depth,
          lod: runtime.chunk.lod,
          count: runtime.chunk.data.numSplats,
          bound: runtime.chunk.bound,
          wasSelected: runtime.active,
        })),
        {
          budget: this.splatBudget,
          cameraPosition,
          focalPixels,
          lodRangeMin: this.lodRangeMin,
          lodRangeMax: this.lodRangeMax,
          lodUnderfillLimit: this.lodUnderfillLimit,
        },
      ).selected.map((item) => item.key),
    );

    this.runtimes.forEach((runtime, index) => {
      runtime.active = selectedKeys.has(String(index));
      this.setPassEnabled(runtime.pass, runtime.active);
    });

    const activeRuntimes = this.runtimes.filter((runtime) => runtime.active);
    this.activeChunks = activeRuntimes.length;
    this.selectedLods = new Set(activeRuntimes.map((runtime) => runtime.chunk.lod)).size;
    this.lastLodCameraPosition.copyFrom(cameraPosition);
    this.lastLodCameraForward.copyFrom(cameraForward);
    this.lastLodBuildMs = performance.now() - start;
  }
}

export { CompositeSplatRenderPass };
export type { CompositeSplatRenderPassOptions, RenderPassLike };
