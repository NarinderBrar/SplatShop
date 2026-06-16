import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Scene } from "@babylonjs/core/scene";

import type { SogPackedData, SsogChunkEntry, SsogChunkLoader, SsogPackedChunk } from "../splat/SplatAsset";
import { SogBuffers } from "../splat/SogBuffers";
import { SplatBuffers, type PackedSplatArrays } from "../splat/SplatBuffers";
import { selectSsogLod } from "../splat/SsogLodSelector";
import { Frustum } from "@babylonjs/core/Maths/math.frustum";
import { isAabbInFrustum } from "../splat/SsogFrustumCulling";
import { PackedSogRenderPass, type PackedSogRenderStats } from "./PackedSogRenderPass";
import { SplatRenderPass } from "./SplatRenderPass";
import { SsogGlobalPackedRenderPass } from "./SsogGlobalPackedRenderPass";

type StreamingSsogRenderStats = PackedSogRenderStats & {
  qualityPreset: SsogQualityPreset;
  loadedChunks: number;
  pendingChunks: number;
  queuedChunks: number;
  prefetchedChunks: number;
  evictedChunks: number;
  cacheSplats: number;
  cacheChunkPressure: number;
  cacheSplatPressure: number;
  selectedCacheRatio: number;
  selectedNodes: number;
  selectedSplats: number;
  requestedChunks: number;
  requestedSplats: number;
  cacheChunkLimit: number;
  cacheSplatLimit: number;
  maxPendingLoads: number;
  prefetchMultiplier: number;
  chunkSortMode: SsogChunkSortMode;
  chunkSortScale: number;
  chunkSortHysteresis: number;
  globalSortRequested: SsogGlobalSortMode;
  globalSortEffective: SsogGlobalSortMode | "group-merged";
  globalSortFallbackReason: string;
  globalSortBuildPending: boolean;
  packedMetadataMode: "none" | "shared" | "per-chunk";
  packedMetadataGroups: number;
  packedMergeCompatible: boolean;
  lastGlobalSortBuildMs: number;
  lastChunkLoadMs: number;
  lodTransitionCount: number;
  pendingReplacementNodes: number;
  finestSelectedNodes: number;
  coarseFallbackNodes: number;
  candidateChunks: number;
  frustumVisibleChunks: number;
  frustumCulledChunks: number;
  frustumMargin: number;
};

type LoadedChunk = {
  entry: SsogChunkEntry;
  chunk: SsogPackedChunk;
  buffers: SogBuffers;
  pass: PackedSogRenderPass;
  active: boolean;
  lastUsedFrame: number;
};

type SelectedSsogItem = {
  value: SsogChunkEntry;
  key: string;
  nodeId: number;
  lod: number;
  count: number;
};

type MergedRuntime = {
  signature: string;
  keys: Set<string>;
  buffers: SogBuffers;
  pass: PackedSogRenderPass;
};

type ExpandedRuntime = {
  signature: string;
  buffers: SplatBuffers;
  pass: SplatRenderPass;
};

type SsogGlobalSortMode = "off" | "packed" | "expanded";
type SsogChunkSortMode = "near" | "center" | "far";
type SsogQualityPreset = "full" | "balanced" | "fast";

type SsogStreamingPreset = {
  cacheChunks: number;
  maxPendingLoads: number;
  prefetchMultiplier: number;
  evictAfterFrames: number;
  cacheSplatMultiplier: number;
  lodMoveEpsilon: number;
  lodAngleDegrees: number;
  selectionStableFrames: number;
};

const LOD_SELECT_INTERVAL_FRAMES = 15;

const chunkKey = (entry: SsogChunkEntry): string =>
  `${entry.fileIndex}:${entry.offset}:${entry.count}:${entry.lod}:${entry.nodeId}`;

const getPositiveNumberParam = (name: string, fallback: number): number => {
  const value = Number(new URLSearchParams(window.location.search).get(name));
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const getSsogQualityPreset = (): SsogQualityPreset => {
  const params = new URLSearchParams(window.location.search);
  const value = params.get("quality");
  if (value === "full" || value === "balanced" || value === "fast") {
    return value;
  }
  return params.get("ssogReference") === "true" ? "full" : "balanced";
};

const getSsogStreamingPreset = (): SsogStreamingPreset => {
  switch (getSsogQualityPreset()) {
    case "fast":
      return {
        cacheChunks: 48,
        maxPendingLoads: 3,
        prefetchMultiplier: 1,
        evictAfterFrames: 4,
        cacheSplatMultiplier: 1.1,
        lodMoveEpsilon: 0.8,
        lodAngleDegrees: 18,
        selectionStableFrames: 6,
      };
    case "balanced":
      return {
        cacheChunks: 96,
        maxPendingLoads: 6,
        prefetchMultiplier: 1.08,
        evictAfterFrames: 8,
        cacheSplatMultiplier: 1.35,
        lodMoveEpsilon: 0.65,
        lodAngleDegrees: 14,
        selectionStableFrames: 12,
      };
    default:
      return {
        cacheChunks: 128,
        maxPendingLoads: 6,
        prefetchMultiplier: 1.05,
        evictAfterFrames: 8,
        cacheSplatMultiplier: 1.35,
        lodMoveEpsilon: 0.08,
        lodAngleDegrees: 1,
        selectionStableFrames: 2,
      };
  }
};

const getSplatBudget = (sourceSplats: number): number => {
  const params = new URLSearchParams(window.location.search);
  const explicit = Number(params.get("splatBudget"));
  if (Number.isFinite(explicit) && explicit > 0) {
    return Math.floor(explicit);
  }

  if (params.get("ssogReference") === "true") {
    return sourceSplats;
  }

  const quality = getSsogQualityPreset();
  const expandedGlobalSort = params.get("ssogGlobalSort") === "expanded";
  if (expandedGlobalSort && quality !== "fast") {
    return sourceSplats;
  }
  if (quality === "fast") {
    return Math.min(sourceSplats, expandedGlobalSort ? Math.ceil(sourceSplats * 0.55) : 900_000);
  }
  if (quality === "balanced") {
    return Math.min(sourceSplats, 2_000_000);
  }
  return sourceSplats;
};

const getSsogCacheChunkLimit = (): number => {
  const raw = new URLSearchParams(window.location.search).get("ssogCacheChunks");
  if (raw === "all") {
    return Number.POSITIVE_INFINITY;
  }
  return Math.floor(getPositiveNumberParam("ssogCacheChunks", getSsogStreamingPreset().cacheChunks));
};

const getSsogMaxPendingLoads = (): number =>
  Math.max(1, Math.floor(getPositiveNumberParam("ssogMaxPending", getSsogStreamingPreset().maxPendingLoads)));

const getSsogPrefetchMultiplier = (): number =>
  Math.max(1, getPositiveNumberParam("ssogPrefetchMultiplier", getSsogStreamingPreset().prefetchMultiplier));

const getSsogEvictAfterFrames = (): number =>
  Math.max(0, Math.floor(getPositiveNumberParam("ssogEvictAfterFrames", getSsogStreamingPreset().evictAfterFrames)));

const getSsogCacheSplatMultiplier = (): number =>
  Math.max(1, getPositiveNumberParam("ssogCacheSplatMultiplier", getSsogStreamingPreset().cacheSplatMultiplier));

const getLodMoveEpsilonSq = (): number => {
  const epsilon = getPositiveNumberParam("lodMoveEpsilon", getSsogStreamingPreset().lodMoveEpsilon);
  return epsilon * epsilon;
};

const getLodForwardDotThreshold = (): number => {
  const degrees = getPositiveNumberParam("lodAngleDegrees", getSsogStreamingPreset().lodAngleDegrees);
  return Math.cos((degrees * Math.PI) / 180);
};

const getSsogChunkSortMode = (): SsogChunkSortMode => {
  const value = new URLSearchParams(window.location.search).get("ssogChunkSort");
  return value === "center" || value === "far" ? value : "near";
};

const getSsogChunkSortScale = (): number => getPositiveNumberParam("ssogChunkSortScale", 64);

const getSsogChunkSortHysteresis = (): number =>
  Math.max(0, getPositiveNumberParam("ssogChunkSortHysteresis", 2));

const isSsogMergedRenderingEnabled = (): boolean =>
  new URLSearchParams(window.location.search).get("ssogMerge") !== "false";

const getSsogGlobalSortMode = (): SsogGlobalSortMode => {
  const params = new URLSearchParams(window.location.search);
  if (params.get("ssogReference") === "true") {
    return "expanded";
  }

  const value = params.get("ssogGlobalSort");
  if (value === "off" || value === "expanded") {
    return value;
  }
  if (value === "packed") {
    return "packed";
  }
  if (params.get("ssogPackedFallback") === "expanded" || getSsogQualityPreset() === "full") {
    return "expanded";
  }
  return "packed";
};

const getSsogForceFineScreenRatio = (): number => {
  const params = new URLSearchParams(window.location.search);
  const fallback = params.get("ssogGlobalSort") === "expanded" && params.get("quality") !== "full" ? 0.45 : 0.9;
  return getPositiveNumberParam("ssogForceFineScreenRatio", fallback);
};

const getSsogForceFineViewDot = (): number => {
  const params = new URLSearchParams(window.location.search);
  const fallback = params.get("ssogGlobalSort") === "expanded" && params.get("quality") !== "full" ? 0.05 : 0.2;
  return getPositiveNumberParam("ssogForceFineViewDot", fallback);
};

const getSsogSelectionStableFrames = (): number => {
  const params = new URLSearchParams(window.location.search);
  const explicit = Number(params.get("ssogSelectionStableFrames"));
  if (Number.isFinite(explicit) && explicit >= 0) {
    return Math.floor(explicit);
  }

  return getSsogStreamingPreset().selectionStableFrames;
};

const isSsogProgressiveGlobalBuildEnabled = (): boolean =>
  new URLSearchParams(window.location.search).get("ssogProgressiveGlobalBuild") === "true";

class StreamingSsogRenderPass {
  private readonly loaded = new Map<string, LoadedChunk>();
  private readonly pending = new Map<string, Promise<void>>();
  private readonly queued = new Map<string, SsogChunkEntry>();
  private readonly entriesByKey = new Map<string, SsogChunkEntry>();
  private readonly selectedKeys = new Set<string>();
  private readonly prefetchKeys = new Set<string>();
  private readonly fallbackKeys = new Set<string>();
  private readonly updateObserver: () => void;
  private readonly qualityPreset = getSsogQualityPreset();
  private readonly sourceSplats: number;
  private readonly splatBudget: number;
  private readonly cacheChunkLimit = getSsogCacheChunkLimit();
  private readonly maxPendingLoads = getSsogMaxPendingLoads();
  private readonly prefetchMultiplier = getSsogPrefetchMultiplier();
  private readonly evictAfterFrames = getSsogEvictAfterFrames();
  private readonly cacheSplatMultiplier = getSsogCacheSplatMultiplier();
  private readonly cacheSplatLimit: number;
  private readonly lodRangeMin = getPositiveNumberParam("lodRangeMin", 24);
  private readonly lodRangeMax = getPositiveNumberParam("lodRangeMax", 220);
  private readonly lodUnderfillLimit = getPositiveNumberParam("lodUnderfillLimit", 0.85);
  private readonly lodMoveEpsilonSq = getLodMoveEpsilonSq();
  private readonly lodForwardDotThreshold = getLodForwardDotThreshold();
  private readonly chunkSortMode = getSsogChunkSortMode();
  private readonly chunkSortScale = getSsogChunkSortScale();
  private readonly chunkSortHysteresis = getSsogChunkSortHysteresis();
  private readonly mergedRendering = isSsogMergedRenderingEnabled();
  private readonly globalSortMode = getSsogGlobalSortMode();
  private readonly forceFineScreenRatio = getSsogForceFineScreenRatio();
  private readonly forceFineViewDot = getSsogForceFineViewDot();
  private readonly selectionStableFrames = getSsogSelectionStableFrames();
  private readonly progressiveGlobalBuild = isSsogProgressiveGlobalBuildEnabled();
  private readonly mergedRuntimes = new Map<string, MergedRuntime>();
  private readonly pendingSelections = new Map<number, { key: string; frames: number }>();
  private readonly transitionLocks = new Map<number, number>();
  private packedGlobalRuntime?: SsogGlobalPackedRenderPass;
  private expandedRuntime?: ExpandedRuntime;
  private activeVizMode = 0;
  private frame = 0;
  private generation = 0;
  private disposed = false;
  private lastLodCameraPosition = new Vector3(Number.POSITIVE_INFINITY, 0, 0);
  private lastLodCameraForward = new Vector3(0, 0, 0);
  private activeChunks = 0;
  private selectedLods = 0;
  private selectedNodes = 0;
  private selectedSplats = 0;
  private requestedChunks = 0;
  private requestedSplats = 0;
  private cacheSplats = 0;
  private evictedChunks = 0;
  private lastLodBuildMs = 0;
  private globalSortFallbackReason = "";
  private globalSortBuildPending = false;
  private readonly packedMetadataFingerprints = new WeakMap<SogPackedData, string>();
  private lastGlobalSortBuildMs = 0;
  private lastChunkLoadMs = 0;
  private lodTransitionCount = 0;
  private pendingReplacementNodes = 0;
  private finestSelectedNodes = 0;
  private coarseFallbackNodes = 0;
  private candidateChunks = 0;
  private frustumVisibleChunks = 0;
  private frustumCulledChunks = 0;

  constructor(
    private readonly scene: Scene,
    private readonly entries: SsogChunkEntry[],
    private readonly loadChunk: SsogChunkLoader,
  ) {
    entries.forEach((entry) => this.entriesByKey.set(chunkKey(entry), entry));
    const finestEntries = entries.filter((entry) => entry.lod === 0);
    this.sourceSplats = (finestEntries.length > 0 ? finestEntries : entries).reduce(
      (sum, entry) => sum + entry.count,
      0,
    );
    this.splatBudget = getSplatBudget(this.sourceSplats);
    this.cacheSplatLimit = Math.floor(
      getPositiveNumberParam("ssogCacheSplats", Math.max(this.splatBudget * this.cacheSplatMultiplier, 1)),
    );
    this.updateObserver = () => this.updateLodSelection();
    scene.registerBeforeRender(this.updateObserver);
    this.updateLodSelection(true);
  }

  dispose(): void {
    this.disposed = true;
    this.scene.unregisterBeforeRender(this.updateObserver);
    this.loaded.forEach((runtime) => {
      runtime.pass.dispose();
      runtime.buffers.dispose();
    });
    this.disposeMergedRuntimes();
    this.disposePackedGlobalRuntime();
    this.disposeExpandedRuntime();
    this.loaded.clear();
    this.pending.clear();
    this.queued.clear();
  }

  setVizMode(mode: number): void {
    this.activeVizMode = mode;
    this.loaded.forEach((runtime) => runtime.pass.setVizMode(mode));
    this.mergedRuntimes.forEach((runtime) => runtime.pass.setVizMode(mode));
    if (this.packedGlobalRuntime) {
      this.packedGlobalRuntime.setVizMode(mode);
    }
    if (this.expandedRuntime) {
      this.expandedRuntime.pass.setVizMode(mode);
    }
  }

  getStats(): StreamingSsogRenderStats {
    const mergedKeys = this.getMergedKeys();
    const packedMetadata = this.getActivePackedMetadataStats();
    const activeStats = [
      ...(this.expandedRuntime ? [this.expandedRuntime.pass.getStats()] : []),
      ...(this.packedGlobalRuntime ? [this.packedGlobalRuntime.getStats()] : []),
      ...Array.from(this.mergedRuntimes.values()).map((runtime) => runtime.pass.getStats()),
      ...Array.from(this.loaded.entries())
        .filter(
          ([key, runtime]) =>
            !this.expandedRuntime && !this.packedGlobalRuntime && runtime.active && !mergedKeys.has(key),
        )
        .map(([, runtime]) => runtime.pass.getStats()),
    ];
    const first = activeStats[0];
    const firstPreviewStats = first as
      | (typeof first & {
          computeTileRasterPreviewDrawLimit?: number;
          computeTileRasterPreviewRequestedDrawLimit?: number;
          computeTileRasterPreviewStaticDrawLimit?: number;
          computeTileRasterPreviewMotionDrawLimit?: number;
          computeTileRasterPreviewAdaptiveScale?: number;
          computeTileRasterPreviewFrameMs?: number;
          computeTileRasterPreviewMaxMarkerPixels?: number;
          computeTileRasterPreviewStaticRamp?: number;
          computeTileRasterPreviewDrawOrder?: "coverage" | "far" | "near";
          computeTileRasterPreviewWindowMode?: "sampled" | "full";
          computeTileRasterPreviewCoverageMode?: "sampled" | "full";
          computeTileRasterPreviewTruncatedSplats?: number;
          computeTileRasterPreviewNearWindowMargin?: number;
          computeTileRasterPreviewSampleAlphaCompensation?: number;
          computeTileRasterPreviewRuntimeSampleAlphaCompensation?: number;
          computeTileRasterPreviewSamplePasses?: number;
          computeTileRasterPreviewMaxUsefulSamplePasses?: number;
          computeTileRasterPreviewStaticSamplePasses?: number;
          computeTileRasterPreviewMotionSamplePasses?: number;
          computeTileRasterPreviewWindowSplats?: number;
          computeTileRasterPreviewSampledCoverage?: number;
          computeTileRasterPreviewWindowCoverage?: number;
          computeTileRasterPreviewSampleCoverageTarget?: number;
          computeTileRasterPreviewMotionSampleCoverageTarget?: number;
          computeTileRasterPreviewRuntimeSampleCoverageTarget?: number;
          computeTileRasterPreviewSamplePassesAdaptive?: boolean;
          computeTileRasterPreviewDrawCoverageTarget?: number;
          computeTileRasterPreviewMotionDrawCoverageTarget?: number;
          computeTileRasterPreviewRuntimeDrawCoverageTarget?: number;
          computeTileRasterPreviewDrawCoverageAdaptive?: boolean;
        })
      | undefined;
    const totalComputeTileWorkQueueSplats = activeStats.reduce(
      (sum, item) => sum + item.computeTileWorkQueueSplats,
      0,
    );
    const totalComputeTileRasterPreviewSplats = activeStats.reduce(
      (sum, item) => sum + item.computeTileRasterPreviewSplats,
      0,
    );
    const totalComputeTileRasterPreviewWindowSplats = activeStats.reduce(
      (sum, item) => sum + (item.computeTileRasterPreviewWindowSplats ?? 0),
      0,
    );

    return {
      renderSplats: activeStats.reduce((sum, item) => sum + item.renderSplats, 0),
      chunkCount: this.entries.length,
      activeChunks: this.activeChunks,
      selectedLods: this.selectedLods,
      rendererMode: `ssog-streaming-${
        this.expandedRuntime
          ? "expanded-global-"
          : this.packedGlobalRuntime
            ? "packed-global-"
            : this.mergedRuntimes.size > 0
              ? "group-merged-"
              : ""
      }${first?.rendererMode ?? "loading"}`,
      rendererRequested: first?.rendererRequested ?? "auto",
      rendererEffective: first?.rendererEffective ?? "cpu",
      rendererFallbackReason: first?.rendererFallbackReason ?? "",
      computeRendererEnabled: activeStats.some((item) => item.computeRendererEnabled),
      computeRendererPhase:
        activeStats.find((item) => item.computeRendererEnabled)?.computeRendererPhase ?? "disabled",
      colorMode: activeStats.some((item) => item.colorMode === "sh") ? "sh" : "dc",
      shNFileCount: activeStats.reduce((sum, item) => sum + item.shNFileCount, 0),
      shNCodebookLength: activeStats.reduce((sum, item) => sum + item.shNCodebookLength, 0),
      shBands: Math.max(0, ...activeStats.map((item) => item.shBands)),
      shCoeffCount: Math.max(0, ...activeStats.map((item) => item.shCoeffCount)),
      shPaletteCount: activeStats.reduce((sum, item) => sum + item.shPaletteCount, 0),
      shRenderMode: activeStats.some((item) => item.shRenderMode === "cpu")
        ? "cpu"
        : activeStats.some((item) => item.shRenderMode === "loaded")
          ? "loaded"
          : "dc",
      computeTileStatsEnabled: activeStats.some((item) => item.computeTileStatsEnabled),
      computeTileStatsDispatched: activeStats.some((item) => item.computeTileStatsDispatched),
      computeTileSize: first?.computeTileSize ?? 0,
      computeTileCount: activeStats.reduce((sum, item) => sum + item.computeTileCount, 0),
      computeTileCols: first?.computeTileCols ?? 0,
      computeTileRows: first?.computeTileRows ?? 0,
      computeOccupiedTiles: activeStats.reduce((sum, item) => sum + item.computeOccupiedTiles, 0),
      computeMaxTileOccupancy: activeStats.reduce(
        (max, item) => Math.max(max, item.computeMaxTileOccupancy),
        0,
      ),
      computeVisibleSplats: activeStats.reduce((sum, item) => sum + item.computeVisibleSplats, 0),
      computeBehindSplats: activeStats.reduce((sum, item) => sum + item.computeBehindSplats, 0),
      computeClippedSplats: activeStats.reduce((sum, item) => sum + item.computeClippedSplats, 0),
      computeOverflowSplats: activeStats.reduce((sum, item) => sum + item.computeOverflowSplats, 0),
      computeTileOffsetsDispatched: activeStats.some((item) => item.computeTileOffsetsDispatched),
      computeTileListScatterDispatched: activeStats.some((item) => item.computeTileListScatterDispatched),
      computeTileListValidated:
        activeStats.length > 0 && activeStats.every((item) => item.computeTileListValidated),
      computeTileListEntries: activeStats.reduce((sum, item) => sum + item.computeTileListEntries, 0),
      computeTileListCapacity: activeStats.reduce((sum, item) => sum + item.computeTileListCapacity, 0),
      computeTileOffsetEntries: activeStats.reduce((sum, item) => sum + item.computeTileOffsetEntries, 0),
      computeTileCursorEntries: activeStats.reduce((sum, item) => sum + item.computeTileCursorEntries, 0),
      computeTileListMismatchedTiles: activeStats.reduce(
        (sum, item) => sum + item.computeTileListMismatchedTiles,
        0,
      ),
      lastComputeTileStatsMs: activeStats.reduce((sum, item) => sum + item.lastComputeTileStatsMs, 0),
      lastComputeTileOffsetMs: activeStats.reduce((sum, item) => sum + item.lastComputeTileOffsetMs, 0),
      lastComputeTileListScatterMs: activeStats.reduce((sum, item) => sum + item.lastComputeTileListScatterMs, 0),
      computeTileDepthEnabled: activeStats.some((item) => item.computeTileDepthEnabled),
      computeTileDepthDispatched: activeStats.some((item) => item.computeTileDepthDispatched),
      computeTileDepthTiles: activeStats.reduce((sum, item) => sum + item.computeTileDepthTiles, 0),
      computeTileDepthMin: activeStats.reduce(
        (min, item) => (item.computeTileDepthMin > 0 ? Math.min(min, item.computeTileDepthMin) : min),
        Number.POSITIVE_INFINITY,
      ),
      computeTileDepthMax: activeStats.reduce((max, item) => Math.max(max, item.computeTileDepthMax), 0),
      computeTileDepthMaxSpan: activeStats.reduce((max, item) => Math.max(max, item.computeTileDepthMaxSpan), 0),
      computeTileDepthAvgSpan:
        activeStats.reduce((sum, item) => sum + item.computeTileDepthAvgSpan * item.computeTileDepthTiles, 0) /
        Math.max(1, activeStats.reduce((sum, item) => sum + item.computeTileDepthTiles, 0)),
      lastComputeTileDepthMs: activeStats.reduce((sum, item) => sum + item.lastComputeTileDepthMs, 0),
      computeTileWorkQueueEnabled: activeStats.some((item) => item.computeTileWorkQueueEnabled),
      computeTileWorkQueueDispatched: activeStats.some((item) => item.computeTileWorkQueueDispatched),
      computeTileWorkQueueOrderMode: first?.computeTileWorkQueueOrderMode ?? "compact",
      computeTileWorkQueueDepthBands: first?.computeTileWorkQueueDepthBands ?? 0,
      computeTileWorkQueueStableOrder: first?.computeTileWorkQueueStableOrder ?? false,
      computeTileWorkQueueMaxSplatsPerItemConfig: first?.computeTileWorkQueueMaxSplatsPerItemConfig ?? 0,
      computeTileWorkQueueBudget: activeStats.reduce((sum, item) => sum + item.computeTileWorkQueueBudget, 0),
      computeTileWorkQueueBudgetCap: activeStats.reduce((sum, item) => sum + item.computeTileWorkQueueBudgetCap, 0),
      computeTileWorkQueueCoverageTarget: first?.computeTileWorkQueueCoverageTarget ?? 1,
      computeTileWorkQueueExplicitBudget: activeStats.some((item) => item.computeTileWorkQueueExplicitBudget),
      computeTileWorkQueueTiles: activeStats.reduce((sum, item) => sum + item.computeTileWorkQueueTiles, 0),
      computeTileWorkQueueSplats: totalComputeTileWorkQueueSplats,
      computeTileWorkQueueMaxTileSplats: activeStats.reduce(
        (max, item) => Math.max(max, item.computeTileWorkQueueMaxTileSplats),
        0,
      ),
      computeTileWorkQueueAvgTileSplats:
        totalComputeTileWorkQueueSplats /
        Math.max(1, activeStats.reduce((sum, item) => sum + item.computeTileWorkQueueTiles, 0)),
      computeTileWorkQueueOverflowTiles: activeStats.reduce(
        (sum, item) => sum + item.computeTileWorkQueueOverflowTiles,
        0,
      ),
      lastComputeTileWorkQueueMs: activeStats.reduce((sum, item) => sum + item.lastComputeTileWorkQueueMs, 0),
      computeTileOrderEnabled: activeStats.some((item) => item.computeTileOrderEnabled),
      computeTileOrderDispatched: activeStats.some((item) => item.computeTileOrderDispatched),
      computeTileOrderBuckets: first?.computeTileOrderBuckets ?? 0,
      computeTileOrderSplats: activeStats.reduce((sum, item) => sum + item.computeTileOrderSplats, 0),
      lastComputeTileOrderMs: activeStats.reduce((sum, item) => sum + item.lastComputeTileOrderMs, 0),
      computeTileSplatPreviewEnabled: activeStats.some((item) => item.computeTileSplatPreviewEnabled),
      computeTileSplatPreviewSamplesPerTile: first?.computeTileSplatPreviewSamplesPerTile ?? 0,
      computeTileSplatPreviewSplats: activeStats.reduce((sum, item) => sum + item.computeTileSplatPreviewSplats, 0),
      computeTileSplatPreviewActiveTiles: activeStats.reduce(
        (sum, item) => sum + item.computeTileSplatPreviewActiveTiles,
        0,
      ),
      computeTileSplatPreviewWorkTiles: activeStats.reduce(
        (sum, item) => sum + item.computeTileSplatPreviewWorkTiles,
        0,
      ),
      computeTileSplatPreviewColorMode: first?.computeTileSplatPreviewColorMode ?? "debug",
      computeTileSplatPreviewShapeMode: first?.computeTileSplatPreviewShapeMode ?? "marker",
      computeTileRasterPreviewEnabled: activeStats.some((item) => item.computeTileRasterPreviewEnabled),
      computeTileRasterPreviewSamplesPerTile: first?.computeTileRasterPreviewSamplesPerTile ?? 0,
      computeTileRasterPreviewSplats: totalComputeTileRasterPreviewSplats,
      computeTileRasterPreviewWindowSplats: totalComputeTileRasterPreviewWindowSplats,
      computeTileRasterPreviewSampledCoverage:
        totalComputeTileRasterPreviewSplats / Math.max(1, totalComputeTileRasterPreviewWindowSplats),
      computeTileRasterPreviewWindowCoverage:
        totalComputeTileRasterPreviewWindowSplats / Math.max(1, totalComputeTileWorkQueueSplats),
      computeTileRasterPreviewActiveTiles: activeStats.reduce(
        (sum, item) => sum + item.computeTileRasterPreviewActiveTiles,
        0,
      ),
      computeTileRasterPreviewWorkTiles: activeStats.reduce(
        (sum, item) => sum + item.computeTileRasterPreviewWorkTiles,
        0,
      ),
      computeTileRasterPreviewDrawLimit: firstPreviewStats?.computeTileRasterPreviewDrawLimit ?? 0,
      computeTileRasterPreviewRequestedDrawLimit:
        firstPreviewStats?.computeTileRasterPreviewRequestedDrawLimit ?? 0,
      computeTileRasterPreviewStaticDrawLimit: firstPreviewStats?.computeTileRasterPreviewStaticDrawLimit ?? 0,
      computeTileRasterPreviewMotionDrawLimit: firstPreviewStats?.computeTileRasterPreviewMotionDrawLimit ?? 0,
      computeTileRasterPreviewAdaptiveScale: firstPreviewStats?.computeTileRasterPreviewAdaptiveScale ?? 1,
      computeTileRasterPreviewFrameMs: firstPreviewStats?.computeTileRasterPreviewFrameMs ?? 0,
      computeTileRasterPreviewMaxMarkerPixels: firstPreviewStats?.computeTileRasterPreviewMaxMarkerPixels ?? 0,
      computeTileRasterPreviewStaticRamp: firstPreviewStats?.computeTileRasterPreviewStaticRamp ?? 1,
      computeTileRasterPreviewDrawOrder: firstPreviewStats?.computeTileRasterPreviewDrawOrder ?? "far",
      computeTileRasterPreviewWindowMode: firstPreviewStats?.computeTileRasterPreviewWindowMode ?? "sampled",
      computeTileRasterPreviewCoverageMode:
        firstPreviewStats?.computeTileRasterPreviewCoverageMode ?? "sampled",
      computeTileRasterPreviewTruncatedSplats: activeStats.reduce(
        (sum, item) => sum + (item.computeTileRasterPreviewTruncatedSplats ?? 0),
        0,
      ),
      computeTileRasterPreviewNearWindowMargin: firstPreviewStats?.computeTileRasterPreviewNearWindowMargin ?? 0,
      computeTileRasterPreviewSampleAlphaCompensation:
        firstPreviewStats?.computeTileRasterPreviewSampleAlphaCompensation ?? 1,
      computeTileRasterPreviewRuntimeSampleAlphaCompensation:
        firstPreviewStats?.computeTileRasterPreviewRuntimeSampleAlphaCompensation ?? 1,
      computeTileRasterPreviewSamplePasses: firstPreviewStats?.computeTileRasterPreviewSamplePasses ?? 1,
      computeTileRasterPreviewMaxUsefulSamplePasses:
        firstPreviewStats?.computeTileRasterPreviewMaxUsefulSamplePasses ?? 1,
      computeTileRasterPreviewStaticSamplePasses:
        firstPreviewStats?.computeTileRasterPreviewStaticSamplePasses ?? 1,
      computeTileRasterPreviewMotionSamplePasses:
        firstPreviewStats?.computeTileRasterPreviewMotionSamplePasses ?? 1,
      computeTileRasterPreviewSampleCoverageTarget:
        firstPreviewStats?.computeTileRasterPreviewSampleCoverageTarget ?? 1,
      computeTileRasterPreviewMotionSampleCoverageTarget:
        firstPreviewStats?.computeTileRasterPreviewMotionSampleCoverageTarget ?? 1,
      computeTileRasterPreviewRuntimeSampleCoverageTarget:
        firstPreviewStats?.computeTileRasterPreviewRuntimeSampleCoverageTarget ?? 1,
      computeTileRasterPreviewSamplePassesAdaptive:
        firstPreviewStats?.computeTileRasterPreviewSamplePassesAdaptive ?? false,
      computeTileRasterPreviewDrawCoverageTarget:
        firstPreviewStats?.computeTileRasterPreviewDrawCoverageTarget ?? 0,
      computeTileRasterPreviewMotionDrawCoverageTarget:
        firstPreviewStats?.computeTileRasterPreviewMotionDrawCoverageTarget ?? 0,
      computeTileRasterPreviewRuntimeDrawCoverageTarget:
        firstPreviewStats?.computeTileRasterPreviewRuntimeDrawCoverageTarget ?? 0,
      computeTileRasterPreviewDrawCoverageAdaptive:
        firstPreviewStats?.computeTileRasterPreviewDrawCoverageAdaptive ?? false,
      computeTileRasterPreviewColorMode: first?.computeTileRasterPreviewColorMode ?? "debug",
      computeTileRasterPreviewShapeMode: first?.computeTileRasterPreviewShapeMode ?? "marker",
      computeTileUpdateInterval: first?.computeTileUpdateInterval ?? 1,
      sortMode: first?.sortMode ?? "auto",
      sortPending: activeStats.some((item) => item.sortPending),
      lastSortMs: activeStats.reduce((sum, item) => sum + item.lastSortMs, 0),
      lastUploadMs: activeStats.reduce((sum, item) => sum + item.lastUploadMs, 0),
      lastLodBuildMs: this.lastLodBuildMs + activeStats.reduce((sum, item) => sum + item.lastLodBuildMs, 0),
      gpuDepthKeyEnabled: activeStats.some((item) => item.gpuDepthKeyEnabled),
      gpuDepthKeyDispatched: activeStats.some((item) => item.gpuDepthKeyDispatched),
      lastGpuDepthKeyMs: activeStats.reduce((sum, item) => sum + item.lastGpuDepthKeyMs, 0),
      lastGpuDepthKeySplats: activeStats.reduce((sum, item) => sum + item.lastGpuDepthKeySplats, 0),
      gpuSortHistogramEnabled: activeStats.some((item) => item.gpuSortHistogramEnabled),
      gpuSortHistogramDispatched: activeStats.some((item) => item.gpuSortHistogramDispatched),
      lastGpuSortHistogramMs: activeStats.reduce((sum, item) => sum + item.lastGpuSortHistogramMs, 0),
      lastGpuSortHistogramSplats: activeStats.reduce((sum, item) => sum + item.lastGpuSortHistogramSplats, 0),
      gpuSortHistogramBuckets: first?.gpuSortHistogramBuckets ?? 0,
      gpuSortPrefixSumEnabled: activeStats.some((item) => item.gpuSortPrefixSumEnabled),
      gpuSortPrefixSumDispatched: activeStats.some((item) => item.gpuSortPrefixSumDispatched),
      lastGpuSortPrefixSumMs: activeStats.reduce((sum, item) => sum + item.lastGpuSortPrefixSumMs, 0),
      gpuSortPrefixSumBuckets: first?.gpuSortPrefixSumBuckets ?? 0,
      gpuSortMode: first?.gpuSortMode ?? "shadow",
      gpuSortScatterEnabled: activeStats.some((item) => item.gpuSortScatterEnabled),
      gpuSortScatterDispatched: activeStats.some((item) => item.gpuSortScatterDispatched),
      lastGpuSortScatterMs: activeStats.reduce((sum, item) => sum + item.lastGpuSortScatterMs, 0),
      lastGpuSortScatterSplats: activeStats.reduce((sum, item) => sum + item.lastGpuSortScatterSplats, 0),
      gpuRadixSortEnabled: activeStats.some((item) => item.gpuRadixSortEnabled),
      gpuRadixSortDispatched: activeStats.some((item) => item.gpuRadixSortDispatched),
      lastGpuRadixSortMs: activeStats.reduce((sum, item) => sum + item.lastGpuRadixSortMs, 0),
      lastGpuRadixSortSplats: activeStats.reduce((sum, item) => sum + item.lastGpuRadixSortSplats, 0),
      gpuRadixSortBits: first?.gpuRadixSortBits ?? 0,
      gpuRadixSortPasses: first?.gpuRadixSortPasses ?? 0,
      gpuSortVisibleMode: first?.gpuSortVisibleMode ?? "cpu",
      gpuSortVisibleEffective: first?.gpuSortVisibleEffective ?? "cpu",
      gpuRadixValidationEnabled: activeStats.some((item) => item.gpuRadixValidationEnabled),
      gpuRadixValidationPending: activeStats.some((item) => item.gpuRadixValidationPending),
      gpuRadixValidationSamples: activeStats.reduce((sum, item) => sum + item.gpuRadixValidationSamples, 0),
      gpuRadixAscendingViolations: activeStats.reduce((sum, item) => sum + item.gpuRadixAscendingViolations, 0),
      gpuRadixDescendingViolations: activeStats.reduce((sum, item) => sum + item.gpuRadixDescendingViolations, 0),
      gpuRadixOutOfRangeIndices: activeStats.reduce((sum, item) => sum + item.gpuRadixOutOfRangeIndices, 0),
      gpuRadixDuplicateAdjacentIndices: activeStats.reduce(
        (sum, item) => sum + item.gpuRadixDuplicateAdjacentIndices,
        0,
      ),
      gpuRadixChecksumValid: activeStats.length > 0 && activeStats.every((item) => item.gpuRadixChecksumValid),
      gpuRadixValidatedIndexCount: activeStats.reduce((sum, item) => sum + item.gpuRadixValidatedIndexCount, 0),
      qualityPreset: this.qualityPreset,
      loadedChunks: this.loaded.size,
      pendingChunks: this.pending.size,
      queuedChunks: this.queued.size,
      prefetchedChunks: Array.from(this.loaded.entries()).filter(
        ([key, runtime]) => !runtime.active && this.prefetchKeys.has(key),
      ).length,
      evictedChunks: this.evictedChunks,
      cacheSplats: this.cacheSplats,
      cacheChunkPressure: Number.isFinite(this.cacheChunkLimit)
        ? this.loaded.size / Math.max(1, this.cacheChunkLimit)
        : 0,
      cacheSplatPressure: this.cacheSplats / Math.max(1, this.cacheSplatLimit),
      selectedCacheRatio: this.cacheSplats / Math.max(1, this.selectedSplats),
      selectedNodes: this.selectedNodes,
      selectedSplats: this.selectedSplats,
      requestedChunks: this.requestedChunks,
      requestedSplats: this.requestedSplats,
      cacheChunkLimit: Number.isFinite(this.cacheChunkLimit) ? this.cacheChunkLimit : -1,
      cacheSplatLimit: this.cacheSplatLimit,
      maxPendingLoads: this.maxPendingLoads,
      prefetchMultiplier: this.prefetchMultiplier,
      chunkSortMode: this.chunkSortMode,
      chunkSortScale: this.chunkSortScale,
      chunkSortHysteresis: this.chunkSortHysteresis,
      globalSortRequested: this.globalSortMode,
      globalSortEffective: this.getGlobalSortEffectiveMode(),
      globalSortFallbackReason: this.globalSortFallbackReason,
      globalSortBuildPending: this.globalSortBuildPending,
      packedMetadataMode: packedMetadata.mode,
      packedMetadataGroups: packedMetadata.groups,
      packedMergeCompatible: packedMetadata.mergeCompatible,
      lastGlobalSortBuildMs: this.lastGlobalSortBuildMs,
      lastChunkLoadMs: this.lastChunkLoadMs,
      lodTransitionCount: this.lodTransitionCount,
      pendingReplacementNodes: this.pendingReplacementNodes,
      finestSelectedNodes: this.finestSelectedNodes,
      coarseFallbackNodes: this.coarseFallbackNodes,
      candidateChunks: this.candidateChunks,
      frustumVisibleChunks: this.frustumVisibleChunks,
      frustumCulledChunks: this.frustumCulledChunks,
      frustumMargin: getPositiveNumberParam("frustumMargin", 1),
    };
  }

  private updateLodSelection(force = false): void {
    this.frame = (this.frame + 1) % LOD_SELECT_INTERVAL_FRAMES;

    const camera = this.scene.activeCamera;
    if (!camera) {
      return;
    }

    const cameraPosition = camera.globalPosition;
    const cameraForward = camera.getDirection(Vector3.Forward());
    this.updateLoadedChunkSortDepth(cameraPosition, cameraForward);
    const initial = !Number.isFinite(this.lastLodCameraPosition.x);
    const moved = Vector3.DistanceSquared(cameraPosition, this.lastLodCameraPosition) > this.lodMoveEpsilonSq;
    const turned = Vector3.Dot(cameraForward, this.lastLodCameraForward) < this.lodForwardDotThreshold;
    if (!force && this.frame !== 1 && !initial && !moved && !turned) {
      return;
    }

    const start = performance.now();
    const frustumCullingEnabled = new URLSearchParams(window.location.search).get("ssogFrustumCulling") !== "false";
    const frustumMargin = getPositiveNumberParam("frustumMargin", 1);
    const frustumPlanes = frustumCullingEnabled ? Frustum.GetPlanes(camera.getTransformationMatrix()) : undefined;
    const visibleEntries = frustumPlanes
      ? this.entries.filter((entry) => isAabbInFrustum(entry.bound, frustumPlanes, frustumMargin))
      : this.entries;
    this.candidateChunks = this.entries.length;
    this.frustumVisibleChunks = visibleEntries.length;
    this.frustumCulledChunks = this.entries.length - visibleEntries.length;

    const fov = "fov" in camera && typeof camera.fov === "number" ? camera.fov : Math.PI / 3;
    const viewportHeight = this.scene.getEngine().getRenderHeight(true);
    const focalPixels = viewportHeight / Math.max(0.001, 2 * Math.tan(fov * 0.5));
    const mapEntry = (entry: SsogChunkEntry, wasSelected: boolean) => ({
      value: entry,
      key: chunkKey(entry),
      nodeId: entry.nodeId,
      parentNodeId: entry.parentNodeId,
      depth: entry.depth,
      lod: entry.lod,
      count: entry.count,
      bound: entry.bound,
      wasSelected,
    });
    const selection = selectSsogLod(
      visibleEntries.map((entry) => mapEntry(entry, this.selectedKeys.has(chunkKey(entry)))),
      {
        budget: this.splatBudget,
        cameraPosition,
        cameraForward,
        focalPixels,
        lodRangeMin: this.lodRangeMin,
        lodRangeMax: this.lodRangeMax,
        lodUnderfillLimit: this.lodUnderfillLimit,
        forceFineScreenRatio: this.forceFineScreenRatio,
        forceFineViewDot: this.forceFineViewDot,
      },
    );
    const prefetchSelection =
      this.prefetchMultiplier > 1
        ? selectSsogLod(
            visibleEntries.map((entry) => {
              const key = chunkKey(entry);
              return mapEntry(entry, this.selectedKeys.has(key) || this.prefetchKeys.has(key));
            }),
            {
              budget: Math.min(this.sourceSplats, Math.floor(this.splatBudget * this.prefetchMultiplier)),
              cameraPosition,
              cameraForward,
              focalPixels,
              lodRangeMin: this.lodRangeMin,
              lodRangeMax: this.lodRangeMax,
              lodUnderfillLimit: this.lodUnderfillLimit,
              forceFineScreenRatio: this.forceFineScreenRatio,
              forceFineViewDot: this.forceFineViewDot,
            },
          )
        : selection;

    const stableSelected = this.stabilizeSelection(selection.selected);
    const stableSelectedSplats = stableSelected.reduce((sum, item) => sum + item.count, 0);
    this.selectedKeys.clear();
    stableSelected.forEach((item) => this.selectedKeys.add(item.key));
    this.fallbackKeys.clear();
    const selectedNodeIds = new Set(stableSelected.map((item) => item.nodeId));
    const missingSelectedNodeIds = new Set(
      stableSelected.filter((item) => !this.loaded.has(item.key)).map((item) => item.nodeId),
    );
    for (const nodeId of missingSelectedNodeIds) {
      const fallback = this.getCoarsestEntryForNode(nodeId);
      if (fallback) {
        this.fallbackKeys.add(chunkKey(fallback));
        this.requestChunk(fallback);
      }
    }
    this.coarseFallbackNodes = new Set(
      Array.from(this.fallbackKeys)
        .map((key) => this.entriesByKey.get(key)?.nodeId)
        .filter((nodeId): nodeId is number => nodeId !== undefined),
    ).size;
    this.prefetchKeys.clear();
    prefetchSelection.selected.forEach((item) => {
      if (!this.selectedKeys.has(item.key)) {
        this.prefetchKeys.add(item.key);
      }
    });
    this.selectedNodes = new Set(stableSelected.map((item) => item.nodeId)).size;
    this.selectedSplats = stableSelectedSplats;
    this.finestSelectedNodes = new Set(stableSelected.filter((item) => item.lod === 0).map((item) => item.nodeId)).size;
    this.requestedChunks = prefetchSelection.selected.length;
    this.requestedSplats = prefetchSelection.selectedSplats;
    const activeLods = new Set<number>();
    let activeChunks = 0;
    this.loaded.forEach((runtime, key) => {
      const selected = this.selectedKeys.has(key);
      const fallback = this.fallbackKeys.has(key) && missingSelectedNodeIds.has(runtime.entry.nodeId);
      runtime.active = selected || fallback || (missingSelectedNodeIds.size > 0 && runtime.active && selectedNodeIds.has(runtime.entry.nodeId));
      runtime.pass.setEnabled(this.globalSortMode === "off" && !this.mergedRendering && runtime.active);
      if (runtime.active) {
        activeChunks++;
        activeLods.add(runtime.entry.lod);
        runtime.lastUsedFrame = this.generation;
      }
    });
    this.activeChunks = Math.max(stableSelected.length, activeChunks);
    this.selectedLods = Math.max(new Set(stableSelected.map((item) => item.lod)).size, activeLods.size);
    stableSelected.forEach((item) => this.requestChunk(item.value));
    selection.selected.forEach((item) => this.requestChunk(item.value));
    prefetchSelection.selected.forEach((item) => this.requestChunk(item.value));
    this.pumpChunkQueue();
    this.evictInactiveChunks();
    this.generation++;
    this.lastLodCameraPosition.copyFrom(cameraPosition);
    this.lastLodCameraForward.copyFrom(cameraForward);
    this.updateLoadedChunkSortDepth(cameraPosition, cameraForward);
    if (this.globalSortMode === "packed") {
      this.updatePackedGlobalRuntime();
    } else if (this.globalSortMode === "expanded") {
      this.updateExpandedRuntime();
    } else {
      this.updateMergedRuntime();
    }
    this.lastLodBuildMs = performance.now() - start;
  }

  private requestChunk(entry: SsogChunkEntry): void {
    const key = chunkKey(entry);
    if (this.loaded.has(key) || this.pending.has(key) || this.queued.has(key)) {
      return;
    }

    this.queued.set(key, entry);
  }

  private pumpChunkQueue(): void {
    if (this.disposed) {
      return;
    }

    while (this.pending.size < this.maxPendingLoads && this.queued.size > 0) {
      const next = this.takeNextQueuedChunk();
      if (!next) {
        return;
      }

      this.startChunkLoad(next);
    }
  }

  private takeNextQueuedChunk(): SsogChunkEntry | undefined {
    for (const [key, entry] of this.queued) {
      if (this.fallbackKeys.has(key)) {
        this.queued.delete(key);
        return entry;
      }
    }

    for (const [key, entry] of this.queued) {
      if (this.selectedKeys.has(key)) {
        this.queued.delete(key);
        return entry;
      }
    }

    for (const [key, entry] of this.queued) {
      if (this.prefetchKeys.has(key)) {
        this.queued.delete(key);
        return entry;
      }
      this.queued.delete(key);
    }

    return undefined;
  }

  private startChunkLoad(entry: SsogChunkEntry): void {
    const key = chunkKey(entry);
    if (this.loaded.has(key) || this.pending.has(key)) {
      return;
    }

    const loadStart = performance.now();
    const promise = this.loadChunk(entry)
      .then((chunk) => {
        if (this.disposed) {
          return;
        }

        this.lastChunkLoadMs = performance.now() - loadStart;
        const buffers = new SogBuffers(this.scene.getEngine(), chunk.data);
        const pass = new PackedSogRenderPass(this.scene, buffers);
        pass.setVizMode(this.activeVizMode);
        const active = this.selectedKeys.has(key);
        pass.setEnabled(this.globalSortMode === "off" && !this.mergedRendering && active);
        this.loaded.set(key, {
          entry,
          chunk,
          buffers,
          pass,
          active,
          lastUsedFrame: this.generation,
        });
        this.cacheSplats += chunk.data.numSplats;
        this.updateLodSelection(true);
        this.evictInactiveChunks();
      })
      .finally(() => {
        this.pending.delete(key);
        this.pumpChunkQueue();
      });

    this.pending.set(key, promise);
  }

  private evictInactiveChunks(): void {
    const globalRuntimeReady = !!this.expandedRuntime || !!this.packedGlobalRuntime;
    const inactive = Array.from(this.loaded.entries())
      .filter(([key, runtime]) => {
        const protectPrefetch =
          this.prefetchKeys.has(key) && (!globalRuntimeReady || this.qualityPreset !== "fast");
        const protectedChunk =
          runtime.active || this.selectedKeys.has(key) || protectPrefetch;
        const oldEnough = this.generation - runtime.lastUsedFrame >= this.evictAfterFrames;
        return !protectedChunk && oldEnough;
      })
      .sort((a, b) => {
        const prefetchA = this.prefetchKeys.has(a[0]) ? 1 : 0;
        const prefetchB = this.prefetchKeys.has(b[0]) ? 1 : 0;
        return prefetchA - prefetchB || a[1].lastUsedFrame - b[1].lastUsedFrame;
      });

    for (const [key, runtime] of inactive) {
      if (this.loaded.size <= this.cacheChunkLimit && this.cacheSplats <= this.cacheSplatLimit) {
        break;
      }

      runtime.pass.dispose();
      runtime.buffers.dispose();
      this.cacheSplats -= runtime.chunk.data.numSplats;
      this.loaded.delete(key);
      this.evictedChunks++;
    }

    if (this.globalSortMode === "packed") {
      this.updatePackedGlobalRuntime();
    } else if (this.globalSortMode === "expanded") {
      this.updateExpandedRuntime();
    } else {
      this.updateMergedRuntime();
    }
  }

  private getCoarsestEntryForNode(nodeId: number): SsogChunkEntry | undefined {
    return this.entries
      .filter((entry) => entry.nodeId === nodeId)
      .sort((a, b) => b.lod - a.lod || a.count - b.count)[0];
  }

  private stabilizeSelection(selected: SelectedSsogItem[]): SelectedSsogItem[] {
    this.pendingReplacementNodes = 0;
    this.transitionLocks.forEach((frames, nodeId) => {
      if (frames <= 1) {
        this.transitionLocks.delete(nodeId);
      } else {
        this.transitionLocks.set(nodeId, frames - 1);
      }
    });

    if (this.selectionStableFrames <= 0 || this.selectedKeys.size === 0) {
      this.pendingSelections.clear();
      this.transitionLocks.clear();
      return selected;
    }

    const previousByNode = new Map<number, SsogChunkEntry>();
    this.selectedKeys.forEach((key) => {
      const entry = this.entriesByKey.get(key);
      if (entry) {
        previousByNode.set(entry.nodeId, entry);
      }
    });

    const nextKeys = new Set(selected.map((item) => item.key));
    const activePendingNodes = new Set<number>();
    const pendingReplacementNodes = new Set<number>();
    const stable = selected.map((item): SelectedSsogItem => {
      const previous = previousByNode.get(item.nodeId);
      const previousKey = previous ? chunkKey(previous) : undefined;
      if (!previous || !previousKey || previousKey === item.key || !this.loaded.has(previousKey)) {
        this.pendingSelections.delete(item.nodeId);
        return item;
      }

      const lockedFrames = this.transitionLocks.get(item.nodeId) ?? 0;
      if (lockedFrames > 0) {
        pendingReplacementNodes.add(item.nodeId);
        return {
          ...item,
          value: previous,
          key: previousKey,
          lod: previous.lod,
          count: previous.count,
        };
      }

      if (!this.loaded.has(item.key)) {
        pendingReplacementNodes.add(item.nodeId);
        return {
          ...item,
          value: previous,
          key: previousKey,
          lod: previous.lod,
          count: previous.count,
        };
      }

      const pending = this.pendingSelections.get(item.nodeId);
      const frames = pending?.key === item.key ? pending.frames + 1 : 1;
      this.pendingSelections.set(item.nodeId, { key: item.key, frames });
      activePendingNodes.add(item.nodeId);
      if (frames < this.selectionStableFrames) {
        pendingReplacementNodes.add(item.nodeId);
        return {
          ...item,
          value: previous,
          key: previousKey,
          lod: previous.lod,
          count: previous.count,
        };
      }

      this.pendingSelections.delete(item.nodeId);
      this.transitionLocks.set(item.nodeId, this.selectionStableFrames);
      this.lodTransitionCount++;
      return item;
    });

    Array.from(this.pendingSelections.keys()).forEach((nodeId) => {
      const pending = this.pendingSelections.get(nodeId);
      if (!pending || (!activePendingNodes.has(nodeId) && !nextKeys.has(pending.key))) {
        this.pendingSelections.delete(nodeId);
      }
    });

    this.pendingReplacementNodes = pendingReplacementNodes.size;
    return stable;
  }

  private updateLoadedChunkSortDepth(cameraPosition: Vector3, cameraForward: Vector3): void {
    if (this.expandedRuntime || this.packedGlobalRuntime) {
      return;
    }

    this.mergedRuntimes.forEach((runtime) =>
      runtime.pass.setTransparentSortDepth(0, this.chunkSortScale, this.chunkSortHysteresis),
    );

    this.loaded.forEach((runtime) => {
      runtime.pass.setTransparentSortDepth(
        this.getChunkViewDepth(runtime.entry, cameraPosition, cameraForward),
        this.chunkSortScale,
        this.chunkSortHysteresis,
      );
    });
  }

  private getChunkViewDepth(entry: SsogChunkEntry, cameraPosition: Vector3, cameraForward: Vector3): number {
    const min = Vector3.FromArray(entry.bound.min);
    const max = Vector3.FromArray(entry.bound.max);
    const center = min.add(max).scaleInPlace(0.5);
    const centerDepth = Vector3.Dot(center.subtract(cameraPosition), cameraForward);
    if (this.chunkSortMode === "center") {
      return centerDepth;
    }

    let minDepth = Number.POSITIVE_INFINITY;
    let maxDepth = Number.NEGATIVE_INFINITY;
    for (const x of [min.x, max.x]) {
      for (const y of [min.y, max.y]) {
        for (const z of [min.z, max.z]) {
          const depth = Vector3.Dot(new Vector3(x, y, z).subtract(cameraPosition), cameraForward);
          minDepth = Math.min(minDepth, depth);
          maxDepth = Math.max(maxDepth, depth);
        }
      }
    }

    return this.chunkSortMode === "far" ? maxDepth : minDepth;
  }

  private updatePackedGlobalRuntime(): void {
    if (this.globalSortMode !== "packed") {
      this.disposePackedGlobalRuntime();
      return;
    }

    const activeEntries = Array.from(this.loaded.entries()).filter(([, runtime]) => runtime.active);
    activeEntries.forEach(([, runtime]) => runtime.pass.setEnabled(false));

    if (!this.canBuildGlobalRuntime(activeEntries)) {
      this.globalSortBuildPending = true;
      return;
    }
    this.globalSortBuildPending = false;

    if (activeEntries.length === 0) {
      this.disposePackedGlobalRuntime();
      this.disposeExpandedRuntime();
      this.disposeMergedRuntimes();
      this.globalSortFallbackReason = "";
      return;
    }

    const buildStart = performance.now();
    const signature = activeEntries.map(([key]) => key).sort().join("|");
    if (this.packedGlobalRuntime?.signature === signature) {
      this.packedGlobalRuntime.setEnabled(true);
      this.disposeExpandedRuntime();
      this.disposeMergedRuntimes();
      this.globalSortFallbackReason = "";
      this.lastGlobalSortBuildMs = 0;
      return;
    }

    this.disposeMergedRuntimes();
    this.disposePackedGlobalRuntime();
    this.disposeExpandedRuntime();
    const camera = this.scene.activeCamera;
    const cameraPosition = camera?.globalPosition ?? new Vector3(0, 0, 0);
    const cameraForward = camera?.getDirection(Vector3.Forward()) ?? Vector3.Forward();
    const depthSortedEntries = activeEntries.sort(
      (a, b) =>
        this.getChunkViewDepth(b[1].entry, cameraPosition, cameraForward) -
        this.getChunkViewDepth(a[1].entry, cameraPosition, cameraForward),
    );
    this.packedGlobalRuntime = new SsogGlobalPackedRenderPass(
      this.scene,
      depthSortedEntries.map(([key, runtime]) => ({ key, data: runtime.chunk.data })),
      { cameraPosition, cameraForward },
    );
    this.packedGlobalRuntime.setVizMode(this.activeVizMode);
    this.packedGlobalRuntime.setEnabled(true);
    this.globalSortFallbackReason = "";
    this.lastGlobalSortBuildMs = performance.now() - buildStart;
  }

  private updateExpandedRuntime(force = false): void {
    if (!force && this.globalSortMode !== "expanded") {
      this.disposeExpandedRuntime();
      return;
    }
    if (!force) {
      this.globalSortFallbackReason = "";
    }

    this.disposeMergedRuntimes();
    const activeEntries = Array.from(this.loaded.entries()).filter(([, runtime]) => runtime.active);
    activeEntries.forEach(([, runtime]) => runtime.pass.setEnabled(false));

    if (!this.canBuildGlobalRuntime(activeEntries)) {
      this.globalSortBuildPending = true;
      return;
    }
    this.globalSortBuildPending = false;

    if (activeEntries.length === 0) {
      this.disposeExpandedRuntime();
      return;
    }

    const buildStart = performance.now();
    const signature = activeEntries.map(([key]) => key).sort().join("|");
    if (this.expandedRuntime?.signature === signature) {
      this.expandedRuntime.pass.setEnabled(true);
      this.lastGlobalSortBuildMs = 0;
      return;
    }

    this.disposeExpandedRuntime();
    const packed = expandSogChunks(activeEntries.map(([, runtime]) => runtime.chunk.data));
    const buffers = new SplatBuffers(this.scene.getEngine(), packed);
    const pass = new SplatRenderPass(this.scene, buffers, { renderBudget: packed.indices.length });
    pass.setVizMode(this.activeVizMode);
    pass.setEnabled(true);
    this.expandedRuntime = { signature, buffers, pass };
    this.lastGlobalSortBuildMs = performance.now() - buildStart;
  }

  private disposeExpandedRuntime(): void {
    if (!this.expandedRuntime) {
      return;
    }

    this.expandedRuntime.pass.dispose();
    this.expandedRuntime.buffers.dispose();
    this.expandedRuntime = undefined;
  }

  private disposePackedGlobalRuntime(): void {
    if (!this.packedGlobalRuntime) {
      return;
    }

    this.packedGlobalRuntime.dispose();
    this.packedGlobalRuntime = undefined;
  }

  private updateMergedRuntime(preserveFallbackReason = false): void {
    if (!this.mergedRendering) {
      return;
    }
    if (!preserveFallbackReason) {
      this.globalSortFallbackReason = "";
    }

    const activeEntries = Array.from(this.loaded.entries()).filter(([, runtime]) => runtime.active);
    if (activeEntries.length === 0) {
      this.disposeMergedRuntimes();
      return;
    }

    const groups = new Map<string, Array<[string, LoadedChunk]>>();
    activeEntries.forEach(([key, runtime]) => {
      const groupKey = String(runtime.entry.fileIndex);
      const group = groups.get(groupKey) ?? [];
      group.push([key, runtime]);
      groups.set(groupKey, group);
    });

    const nextGroupKeys = new Set<string>();
    const mergedKeys = new Set<string>();
    for (const [groupKey, group] of groups) {
      if (group.length < 2) {
        continue;
      }

      const signature = group.map(([key]) => key).sort().join("|");
      nextGroupKeys.add(groupKey);
      const existing = this.mergedRuntimes.get(groupKey);
      if (existing?.signature === signature) {
        existing.pass.setEnabled(true);
        existing.keys.forEach((key) => mergedKeys.add(key));
        continue;
      }

      const merged = this.mergePackedChunks(group.map(([, runtime]) => runtime.chunk.data));
      if (!merged) {
        if (this.globalSortMode === "off" && !preserveFallbackReason) {
          this.globalSortFallbackReason =
            "selected chunks use per-chunk decode metadata; grouped debug path renders them separately";
        }
        this.disposeMergedRuntime(groupKey);
        continue;
      }

      this.disposeMergedRuntime(groupKey);
      const keys = new Set(group.map(([key]) => key));
      keys.forEach((key) => mergedKeys.add(key));
      const buffers = new SogBuffers(this.scene.getEngine(), merged);
      const pass = new PackedSogRenderPass(this.scene, buffers);
      pass.setVizMode(this.activeVizMode);
      pass.setEnabled(true);
      this.mergedRuntimes.set(groupKey, { signature, keys, buffers, pass });
    }

    Array.from(this.mergedRuntimes.keys()).forEach((groupKey) => {
      if (!nextGroupKeys.has(groupKey)) {
        this.disposeMergedRuntime(groupKey);
      }
    });

    activeEntries.forEach(([key, runtime]) => runtime.pass.setEnabled(!mergedKeys.has(key)));
  }

  private canBuildGlobalRuntime(activeEntries: Array<[string, LoadedChunk]>): boolean {
    if (this.progressiveGlobalBuild || this.selectedKeys.size === 0) {
      return true;
    }

    const loadedActiveKeys = new Set(activeEntries.map(([key]) => key));
    for (const key of this.selectedKeys) {
      if (!loadedActiveKeys.has(key)) {
        return false;
      }
    }
    return true;
  }

  private getGlobalSortEffectiveMode(): StreamingSsogRenderStats["globalSortEffective"] {
    if (this.packedGlobalRuntime) {
      return "packed";
    }
    if (this.expandedRuntime) {
      return "expanded";
    }
    if (this.mergedRuntimes.size > 0) {
      return "group-merged";
    }
    return "off";
  }

  private getMergedKeys(): Set<string> {
    const keys = new Set<string>();
    this.mergedRuntimes.forEach((runtime) => runtime.keys.forEach((key) => keys.add(key)));
    return keys;
  }

  private getActivePackedMetadataStats(): {
    mode: StreamingSsogRenderStats["packedMetadataMode"];
    groups: number;
    mergeCompatible: boolean;
  } {
    const chunks = Array.from(this.loaded.values())
      .filter((runtime) => runtime.active)
      .map((runtime) => runtime.chunk.data);

    if (chunks.length === 0) {
      return { mode: "none", groups: 0, mergeCompatible: true };
    }

    const fingerprints = new Set(chunks.map((chunk) => this.getPackedMetadataFingerprint(chunk)));
    return {
      mode: fingerprints.size > 1 ? "per-chunk" : "shared",
      groups: fingerprints.size,
      mergeCompatible: fingerprints.size <= 1,
    };
  }

  private getPackedMetadataFingerprint(chunk: SogPackedData): string {
    const cached = this.packedMetadataFingerprints.get(chunk);
    if (cached) {
      return cached;
    }

    const fingerprint = JSON.stringify({
      meansMins: chunk.meansMins,
      meansMaxs: chunk.meansMaxs,
      scaleCodebook: Array.from(chunk.scaleCodebook),
      sh0Codebook: Array.from(chunk.sh0Codebook),
      shN: chunk.shN
        ? {
            bands: chunk.shN.bands,
            coeffsPerChannel: chunk.shN.coeffsPerChannel,
            paletteCount: chunk.shN.paletteCount,
            centroidWidth: chunk.shN.centroidWidth,
            centroidHeight: chunk.shN.centroidHeight,
            centroids: Array.from(chunk.shN.centroids),
            codebook: Array.from(chunk.shN.codebook),
          }
        : undefined,
    });
    this.packedMetadataFingerprints.set(chunk, fingerprint);
    return fingerprint;
  }

  private disposeMergedRuntime(groupKey: string): void {
    const runtime = this.mergedRuntimes.get(groupKey);
    if (!runtime) {
      return;
    }

    runtime.pass.dispose();
    runtime.buffers.dispose();
    this.mergedRuntimes.delete(groupKey);
  }

  private disposeMergedRuntimes(): void {
    Array.from(this.mergedRuntimes.keys()).forEach((groupKey) => this.disposeMergedRuntime(groupKey));
  }

  private mergePackedChunks(chunks: SogPackedData[]): SogPackedData | undefined {
    const first = chunks[0];
    if (!first) {
      return undefined;
    }
    if (!chunks.every((chunk) => this.canMergePackedData(first, chunk))) {
      return undefined;
    }

    const numSplats = chunks.reduce((sum, chunk) => sum + chunk.numSplats, 0);
    const boundsMin: [number, number, number] = [
      Number.POSITIVE_INFINITY,
      Number.POSITIVE_INFINITY,
      Number.POSITIVE_INFINITY,
    ];
    const boundsMax: [number, number, number] = [
      Number.NEGATIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ];
    chunks.forEach((chunk) => {
      for (let axis = 0; axis < 3; axis++) {
        boundsMin[axis] = Math.min(boundsMin[axis], chunk.boundsMin[axis]);
        boundsMax[axis] = Math.max(boundsMax[axis], chunk.boundsMax[axis]);
      }
    });

    return {
      numSplats,
      textureWidth: first.textureWidth,
      textureHeight: Math.ceil(numSplats / Math.max(1, first.textureWidth)),
      meansL: concatUint32(chunks.map((chunk) => chunk.meansL)),
      meansU: concatUint32(chunks.map((chunk) => chunk.meansU)),
      quats: concatUint32(chunks.map((chunk) => chunk.quats)),
      scales: concatUint32(chunks.map((chunk) => chunk.scales)),
      sh0: concatUint32(chunks.map((chunk) => chunk.sh0)),
      scaleCodebook: first.scaleCodebook,
      sh0Codebook: first.sh0Codebook,
      shN: first.shN
        ? {
            ...first.shN,
            labels: concatUint32(chunks.map((chunk) => chunk.shN?.labels ?? new Uint32Array())),
          }
        : undefined,
      meansMins: first.meansMins,
      meansMaxs: first.meansMaxs,
      centers: concatFloat32(chunks.map((chunk) => chunk.centers)),
      boundsMin,
      boundsMax,
    };
  }

  private canMergePackedData(first: SogPackedData, next: SogPackedData): boolean {
    return (
      equalNumberArray(first.meansMins, next.meansMins) &&
      equalNumberArray(first.meansMaxs, next.meansMaxs) &&
      equalFloatArray(first.scaleCodebook, next.scaleCodebook) &&
      equalFloatArray(first.sh0Codebook, next.sh0Codebook) &&
      !!first.shN === !!next.shN &&
      (!first.shN ||
        (!!next.shN &&
          first.shN.bands === next.shN.bands &&
          first.shN.coeffsPerChannel === next.shN.coeffsPerChannel &&
          first.shN.paletteCount === next.shN.paletteCount &&
          first.shN.centroidWidth === next.shN.centroidWidth &&
          first.shN.centroidHeight === next.shN.centroidHeight &&
          equalUintArray(first.shN.centroids, next.shN.centroids) &&
          equalFloatArray(first.shN.codebook, next.shN.codebook)))
    );
  }
}

export { StreamingSsogRenderPass };
export type { StreamingSsogRenderStats };

const concatUint32 = (arrays: Uint32Array[]): Uint32Array => {
  const length = arrays.reduce((sum, array) => sum + array.length, 0);
  const out = new Uint32Array(length);
  let offset = 0;
  arrays.forEach((array) => {
    out.set(array, offset);
    offset += array.length;
  });
  return out;
};

const concatFloat32 = (arrays: Float32Array[]): Float32Array => {
  const length = arrays.reduce((sum, array) => sum + array.length, 0);
  const out = new Float32Array(length);
  let offset = 0;
  arrays.forEach((array) => {
    out.set(array, offset);
    offset += array.length;
  });
  return out;
};

const equalNumberArray = (a: readonly number[], b: readonly number[]): boolean =>
  a.length === b.length && a.every((value, index) => value === b[index]);

const equalUintArray = (a: Uint32Array, b: Uint32Array): boolean =>
  a.length === b.length && a.every((value, index) => value === b[index]);

const equalFloatArray = (a: Float32Array, b: Float32Array): boolean =>
  a.length === b.length && a.every((value, index) => value === b[index]);

const SH_C0 = 0.28209479177387814;
const SQRT2 = Math.SQRT2;

const chan = (pixel: number, component: number): number => (pixel >>> (component * 8)) & 0xff;

const expandSogChunks = (chunks: SogPackedData[]): PackedSplatArrays => {
  const splatCount = chunks.reduce((sum, chunk) => sum + chunk.numSplats, 0);
  const centerScale = new Float32Array(splatCount * 4);
  const scale = new Float32Array(splatCount * 4);
  const rotationOpacity = new Float32Array(splatCount * 4);
  const color = new Float32Array(splatCount * 4);
  const indices = new Uint32Array(splatCount);

  let dst = 0;
  for (const chunk of chunks) {
    for (let src = 0; src < chunk.numSplats; src++, dst++) {
      const dst4 = dst * 4;
      const center = decodeSogCenter(chunk, src);
      const logScale = decodeSogScale(chunk, src);
      const rotation = decodeSogRotation(chunk, src);
      const dc = decodeSogDcColor(chunk, src);

      centerScale[dst4 + 0] = center[0];
      centerScale[dst4 + 1] = center[1];
      centerScale[dst4 + 2] = center[2];
      centerScale[dst4 + 3] = Math.max(logScale[0], logScale[1], logScale[2]);

      scale[dst4 + 0] = logScale[0];
      scale[dst4 + 1] = logScale[1];
      scale[dst4 + 2] = logScale[2];
      scale[dst4 + 3] = centerScale[dst4 + 3];

      rotationOpacity[dst4 + 0] = rotation[0];
      rotationOpacity[dst4 + 1] = rotation[1];
      rotationOpacity[dst4 + 2] = rotation[2];
      rotationOpacity[dst4 + 3] = rotation[3];

      color[dst4 + 0] = dc[0];
      color[dst4 + 1] = dc[1];
      color[dst4 + 2] = dc[2];
      color[dst4 + 3] = dc[3];

      indices[dst] = dst;
    }
  }

  return { centerScale, scale, rotationOpacity, color, indices };
};

const decodeSogCenter = (chunk: SogPackedData, index: number): [number, number, number] => {
  const lo = chunk.meansL[index];
  const hi = chunk.meansU[index];
  const out: [number, number, number] = [0, 0, 0];
  for (let axis = 0; axis < 3; axis++) {
    const q = ((chan(hi, axis) << 8) + chan(lo, axis)) / 65535;
    const encoded = chunk.meansMins[axis] * (1 - q) + chunk.meansMaxs[axis] * q;
    out[axis] = Math.sign(encoded) * (Math.exp(Math.abs(encoded)) - 1);
  }
  return out;
};

const decodeSogScale = (chunk: SogPackedData, index: number): [number, number, number] => {
  const pixel = chunk.scales[index];
  return [
    chunk.scaleCodebook[chan(pixel, 0)],
    chunk.scaleCodebook[chan(pixel, 1)],
    chunk.scaleCodebook[chan(pixel, 2)],
  ];
};

const decodeSogRotation = (chunk: SogPackedData, index: number): [number, number, number, number] => {
  const pixel = chunk.quats[index];
  const a = (chan(pixel, 0) / 255 - 0.5) * SQRT2;
  const b = (chan(pixel, 1) / 255 - 0.5) * SQRT2;
  const c = (chan(pixel, 2) / 255 - 0.5) * SQRT2;
  const d = Math.sqrt(Math.max(0, 1 - (a * a + b * b + c * c)));
  const mode = chan(pixel, 3) - 252;
  if (mode === 0) {
    return [d, a, b, c];
  }
  if (mode === 1) {
    return [a, d, b, c];
  }
  if (mode === 2) {
    return [a, b, d, c];
  }
  return [a, b, c, d];
};

const decodeSogDcColor = (chunk: SogPackedData, index: number): [number, number, number, number] => {
  const pixel = chunk.sh0[index];
  return [
    0.5 + chunk.sh0Codebook[chan(pixel, 0)] * SH_C0,
    0.5 + chunk.sh0Codebook[chan(pixel, 1)] * SH_C0,
    0.5 + chunk.sh0Codebook[chan(pixel, 2)] * SH_C0,
    chan(pixel, 3) / 255,
  ];
};
