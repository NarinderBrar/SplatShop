import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Plane } from "@babylonjs/core/Maths/math.plane";
import type { Scene } from "@babylonjs/core/scene";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";

import type { SogPackedData, SsogChunkEntry, SsogChunkLoader, SsogPackedChunk } from "../splat/SplatAsset";
import { SogBuffers } from "../splat/SogBuffers";
import { SplatBuffers, type PackedSplatArrays } from "../splat/SplatBuffers";
import { selectSsogLodFromSoA, SsogLodSelectorScratch, type SsogSelectableItem } from "../splat/SsogLodSelector";
import { Frustum } from "@babylonjs/core/Maths/math.frustum";
import { isAabbInFrustum } from "../splat/SsogFrustumCulling";
import { SsogDebugBounds } from "../debug/SsogDebugBounds";
import { PackedSogRenderPass, type PackedSogRenderStats } from "./PackedSogRenderPass";
import { SplatRenderPass } from "./SplatRenderPass";
import { SsogGlobalPackedRenderPass } from "./SsogGlobalPackedRenderPass";
import { SsogGpuPagePool, type SsogGpuPageAllocation } from "./SsogGpuPagePool";
import { GpuBufferWriter } from "./GpuBufferWriter";
import {
  getDeviceTier,
  getExplicitSplatBudget,
  getPlatformQualityProfile,
  getQualityPreset,
  type SplatDeviceTier,
  type SplatQualityPreset,
} from "./qualityProfiles";

type StreamingSsogRenderStats = PackedSogRenderStats & {
  qualityPreset: SsogQualityPreset;
  qualityDeviceTier: SsogDeviceTier;
  splatBudget: number;
  baseSplatBudget: number;
  adaptiveQualityScale: number;
  adaptiveInteractionScale: number;
  adaptiveFrameMs: number;
  adaptiveTargetFrameMs: number;
  qualityInteractionState: "moving" | "settling" | "idle" | "screenshot";
  loadedChunks: number;
  pendingChunks: number;
  pendingUploadChunks: number;
  queuedChunks: number;
  prefetchedChunks: number;
  evictedChunks: number;
  cacheSplats: number;
  cacheChunkPressure: number;
  cacheSplatPressure: number;
  selectedCacheRatio: number;
  selectedChunks: number;
  selectedLoadedChunks: number;
  selectedPendingChunks: number;
  selectedQueuedChunks: number;
  selectedNodes: number;
  selectedSplats: number;
  fallbackChunks: number;
  loadedActiveChunks: number;
  loadedInactiveChunks: number;
  requestedChunks: number;
  requestedSplats: number;
  cacheChunkLimit: number;
  cacheSplatLimit: number;
  gpuPagePoolPageCapacitySplats: number;
  gpuPagePoolTotalPages: number;
  gpuPagePoolUsedPages: number;
  gpuPagePoolFreePages: number;
  gpuPagePoolAllocatedChunks: number;
  gpuPagePoolResidentSplats: number;
  gpuPagePoolOverflowChunks: number;
  gpuPagePoolOverflowPages: number;
  gpuPagePoolPressure: number;
  gpuPageEvictedChunks: number;
  gpuPageEvictedPages: number;
  decodedCacheChunks: number;
  decodedCacheBytes: number;
  decodedCachePressure: number;
  gpuResidentChunks: number;
  gpuResidentSplats: number;
  cpuEvictedChunks: number;
  reuploadedChunks: number;
  protectedFallbackChunks: number;
  nearPrefetchChunksLoaded: number;
  idlePrefetchChunksLoaded: number;
  gpuPreUploadEvictedChunks: number;
  gpuPreUploadEvictedPages: number;
  decodedCacheSplatLimit: number;
  gpuBufferWriterTotalUploadBytes: number;
  gpuBufferWriterTotalUploadCount: number;
  gpuBufferWriterTotalErrorCount: number;
  gpuBufferWriterTotalFallbackCount: number;
  gpuBufferWriterScratchReuseCount: number;
  gpuBufferWriterArenaBufferCount: number;
  gpuBufferWriterArenaTotalBytes: number;
  gpuBufferWriterFrameUploadBytes: number;
  gpuBufferWriterFrameUploadCount: number;
  gpuBufferWriterFrameErrorCount: number;
  gpuBufferWriterLastErrorMessage: string;
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
  lastChunkUploadMs: number;
  uploadBudgetBytes: number;
  staleQueuedChunksDropped: number;
  stalePendingChunksDropped: number;
  staleUploadChunksDropped: number;
  attemptedUploadChunksThisFrame: number;
  uploadedBytesThisFrame: number;
  uploadedChunksThisFrame: number;
  skippedUploadChunksThisFrame: number;
  deferredUploadChunks: number;
  deferredUploadBytes: number;
  lodTransitionCount: number;
  pendingReplacementNodes: number;
  finestSelectedNodes: number;
  coarseFallbackNodes: number;
  fallbackReasonChildMissing: number;
  fallbackReasonUploadBudgetExceeded: number;
  fallbackReasonGpuPageUnavailable: number;
  fallbackReasonMemoryPressure: number;
  fallbackReasonBudgetThrottled: number;
  fallbackReasonBreakdown: string;
  candidateChunks: number;
  frustumVisibleChunks: number;
  frustumCulledChunks: number;
  frustumMargin: number;
  prefetchCandidateChunks: number;
  prefetchFrustumChunks: number;
  nearPrefetchChunks: number;
  candidateSoACapacity: number;
  candidateSoAGrows: number;
  rendererCommandsPending: number;
  rendererCommandsQueued: number;
  rendererCommandsDeduped: number;
  rendererCommandsFlushed: number;
  rendererCommandPoolGrows: number;
  prefetchFrustumMargin: number;
  nearPrefetchDistance: number;
};

type GpuResidentChunk = {
  buffers: SogBuffers;
  pass: PackedSogRenderPass;
  pageAllocation: SsogGpuPageAllocation;
  active: boolean;
  lastUsedFrame: number;
};

type CachedDecodedChunk = {
  entry: SsogChunkEntry;
  chunk: SsogPackedChunk;
  bytes: number;
  lastUsedFrame: number;
};

type DecodedChunk = {
  key: string;
  entry: SsogChunkEntry;
  chunk: SsogPackedChunk;
  bytes: number;
};

type SsogUploadFrameDiagnostics = {
  attemptedChunks: number;
  uploadedChunks: number;
  uploadedBytes: number;
  skippedLoadedChunks: number;
  deferredChunks: number;
  deferredBytes: number;
};

type SsogUploadBudgetState = {
  uploadedChunks: number;
  uploadedBytes: number;
};

type CacheClass = "fallback" | "selected" | "desired" | "near-prefetch" | "idle-prefetch" | "inactive";

type RendererCommandType = "chunkLoaded" | "chunkLoadFailed" | "chunkLoadSettled";

type RendererCommand = {
  type: RendererCommandType;
  key: string;
  entry: SsogChunkEntry | undefined;
  chunk: SsogPackedChunk | undefined;
  error: unknown;
  loadMs: number;
};

type SelectableSsogEntry = SsogSelectableItem<SsogChunkEntry>;

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
type SsogQualityPreset = SplatQualityPreset;
type SsogDeviceTier = SplatDeviceTier;
type SsogChunkLoadPriority = 0 | 1 | 2 | 3 | 4 | 5;

type SsogQualityProfile = {
  preset: SsogQualityPreset;
  deviceTier: SsogDeviceTier;
  splatBudget: number;
  expandedSortBudgetRatio: number;
  cacheChunks: number;
  maxPendingLoads: number;
  prefetchMultiplier: number;
  prefetchFrustumMargin: number;
  nearPrefetchDistance: number;
  evictAfterFrames: number;
  cacheSplatMultiplier: number;
  lodMoveEpsilon: number;
  lodAngleDegrees: number;
  selectionStableFrames: number;
  uploadBudgetBytes: number;
  chunkSortScale: number;
  chunkSortHysteresis: number;
  globalRuntimeRebuildIntervalFrames: number;
};

class ChunkIndexBuffer {
  data = new Uint32Array(0);
  length = 0;
  growCount = 0;

  reset(): void {
    this.length = 0;
  }

  push(value: number): void {
    if (this.length >= this.data.length) {
      const next = new Uint32Array(Math.max(16, this.data.length * 2));
      next.set(this.data);
      this.data = next;
      this.growCount++;
    }
    this.data[this.length++] = value;
  }
}

class SsogCandidateSoA {
  entryIndices = new Uint32Array(0);
  nodeIds = new Uint32Array(0);
  parentNodeIds = new Int32Array(0);
  depths = new Uint16Array(0);
  lods = new Uint16Array(0);
  counts = new Uint32Array(0);
  flags = new Uint8Array(0);
  bounds = new Float32Array(0);
  length = 0;
  growCount = 0;

  reset(length: number): void {
    this.ensureCapacity(length);
    this.length = length;
  }

  set(
    index: number,
    entryIndex: number,
    entry: SsogChunkEntry,
    wasSelected: boolean,
  ): void {
    const boundsOffset = index * 6;
    this.entryIndices[index] = entryIndex;
    this.nodeIds[index] = entry.nodeId;
    this.parentNodeIds[index] = entry.parentNodeId ?? -1;
    this.depths[index] = entry.depth;
    this.lods[index] = entry.lod;
    this.counts[index] = entry.count;
    this.flags[index] = wasSelected ? 1 : 0;
    this.bounds[boundsOffset + 0] = entry.bound.min[0];
    this.bounds[boundsOffset + 1] = entry.bound.min[1];
    this.bounds[boundsOffset + 2] = entry.bound.min[2];
    this.bounds[boundsOffset + 3] = entry.bound.max[0];
    this.bounds[boundsOffset + 4] = entry.bound.max[1];
    this.bounds[boundsOffset + 5] = entry.bound.max[2];
  }

  private ensureCapacity(length: number): void {
    if (this.entryIndices.length >= length) {
      return;
    }

    let capacity = Math.max(16, this.entryIndices.length);
    while (capacity < length) {
      capacity *= 2;
    }

    this.entryIndices = new Uint32Array(capacity);
    this.nodeIds = new Uint32Array(capacity);
    this.parentNodeIds = new Int32Array(capacity);
    this.depths = new Uint16Array(capacity);
    this.lods = new Uint16Array(capacity);
    this.counts = new Uint32Array(capacity);
    this.flags = new Uint8Array(capacity);
    this.bounds = new Float32Array(capacity * 6);
    this.growCount++;
  }
}

class RendererCommandQueue {
  private readonly commands: RendererCommand[] = [];
  private readonly indices = new Map<string, number>();
  private readonly pool: RendererCommand[] = [];
  queuedTotal = 0;
  dedupedTotal = 0;
  flushedTotal = 0;
  poolGrows = 0;

  get pending(): number {
    return this.commands.length;
  }

  enqueueChunkLoaded(key: string, entry: SsogChunkEntry, chunk: SsogPackedChunk, loadMs: number): void {
    this.enqueue("chunkLoaded", key, (command) => {
      command.entry = entry;
      command.chunk = chunk;
      command.error = undefined;
      command.loadMs = loadMs;
    });
  }

  enqueueChunkLoadFailed(key: string, entry: SsogChunkEntry, error: unknown): void {
    this.enqueue("chunkLoadFailed", key, (command) => {
      command.entry = entry;
      command.chunk = undefined;
      command.error = error;
      command.loadMs = 0;
    });
  }

  enqueueChunkLoadSettled(key: string): void {
    this.enqueue("chunkLoadSettled", key, (command) => {
      command.entry = undefined;
      command.chunk = undefined;
      command.error = undefined;
      command.loadMs = 0;
    });
  }

  flush(process: (command: RendererCommand) => boolean): number {
    let processed = 0;
    for (let index = 0; index < this.commands.length; index++) {
      const command = this.commands[index];
      if (process(command)) {
        processed++;
      }
      this.pool.push(command);
    }
    this.flushedTotal += this.commands.length;
    this.commands.length = 0;
    this.indices.clear();
    return processed;
  }

  clear(): void {
    for (let index = 0; index < this.commands.length; index++) {
      this.pool.push(this.commands[index]);
    }
    this.commands.length = 0;
    this.indices.clear();
  }

  private enqueue(type: RendererCommandType, key: string, write: (command: RendererCommand) => void): void {
    const dedupeKey = `${type}:${key}`;
    const existingIndex = this.indices.get(dedupeKey);
    if (existingIndex !== undefined) {
      const existing = this.commands[existingIndex];
      existing.type = type;
      existing.key = key;
      write(existing);
      this.dedupedTotal++;
      return;
    }

    const command = this.pool.pop() ?? this.createCommand();
    command.type = type;
    command.key = key;
    write(command);
    this.indices.set(dedupeKey, this.commands.length);
    this.commands.push(command);
    this.queuedTotal++;
  }

  private createCommand(): RendererCommand {
    this.poolGrows++;
    return {
      type: "chunkLoadSettled",
      key: "",
      entry: undefined,
      chunk: undefined,
      error: undefined,
      loadMs: 0,
    };
  }
}

const LOD_SELECT_INTERVAL_FRAMES = 15;
const FALLBACK_EVICTION_REASON_TTL_FRAMES = 120;
const ADAPTIVE_QUALITY_TARGET_FRAME_MS = 1000 / 55;
const ADAPTIVE_QUALITY_MIN_SCALE = 0.45;
const ADAPTIVE_QUALITY_MAX_SCALE = 1.15;
const ADAPTIVE_QUALITY_RECOVERY_RATE = 0.015;
const ADAPTIVE_QUALITY_DECAY_RATE = 0.08;
const DEFAULT_IDLE_REFINE_FRAMES = 24;
const DEFAULT_SETTLE_FRAMES = 8;
const DEFAULT_MOVING_QUALITY_SCALE = 0.72;
const DEFAULT_SETTLING_QUALITY_SCALE = 0.9;
const DEFAULT_IDLE_QUALITY_SCALE = 1.18;
const DEFAULT_SCREENSHOT_QUALITY_SCALE = 1.45;

const chunkKey = (entry: SsogChunkEntry): string =>
  `${entry.fileIndex}:${entry.offset}:${entry.count}:${entry.lod}:${entry.nodeId}`;

const getPositiveNumberParam = (name: string, fallback: number): number => {
  const value = Number(new URLSearchParams(window.location.search).get(name));
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const getNonNegativeNumberParam = (name: string, fallback: number): number => {
  const value = Number(new URLSearchParams(window.location.search).get(name));
  return Number.isFinite(value) && value >= 0 ? value : fallback;
};

const getSsogQualityPreset = (): SsogQualityPreset => getQualityPreset();

const getSsogDeviceTier = (): SsogDeviceTier => getDeviceTier();

const hasExplicitNumberParam = (name: string): boolean => {
  const value = Number(new URLSearchParams(window.location.search).get(name));
  return Number.isFinite(value) && value > 0;
};

const scaleSsogQualityProfileForDevice = (profile: SsogQualityProfile): SsogQualityProfile => {
  if (profile.preset === "fast") {
    return profile;
  }

  if (profile.deviceTier === "low") {
    return {
      ...profile,
      splatBudget: profile.preset === "balanced" ? Math.min(profile.splatBudget, 1_200_000) : profile.splatBudget,
      cacheChunks: Math.min(profile.cacheChunks, 64),
      maxPendingLoads: Math.min(profile.maxPendingLoads, 4),
      prefetchMultiplier: Math.min(profile.prefetchMultiplier, 1.03),
      prefetchFrustumMargin: Math.min(profile.prefetchFrustumMargin, 8),
      nearPrefetchDistance: Math.min(profile.nearPrefetchDistance, 12),
      cacheSplatMultiplier: Math.min(profile.cacheSplatMultiplier, 1.15),
      uploadBudgetBytes: Math.min(profile.uploadBudgetBytes, 12 * 1024 * 1024),
      chunkSortScale: Math.min(profile.chunkSortScale, 48),
      chunkSortHysteresis: Math.max(profile.chunkSortHysteresis, 3),
      globalRuntimeRebuildIntervalFrames: Math.max(profile.globalRuntimeRebuildIntervalFrames, 6),
    };
  }

  if (profile.deviceTier === "high" && profile.preset === "full") {
    return {
      ...profile,
      cacheChunks: Math.max(profile.cacheChunks, 192),
      maxPendingLoads: Math.max(profile.maxPendingLoads, 8),
      uploadBudgetBytes: Math.max(profile.uploadBudgetBytes, 64 * 1024 * 1024),
      prefetchFrustumMargin: Math.max(profile.prefetchFrustumMargin, 8),
      globalRuntimeRebuildIntervalFrames: Math.min(profile.globalRuntimeRebuildIntervalFrames, 1),
    };
  }

  return profile;
};

const getSsogQualityProfile = (): SsogQualityProfile => {
  const preset = getSsogQualityPreset();
  const deviceTier = getSsogDeviceTier();
  const platformProfile = getPlatformQualityProfile();
  const base = (() => {
    switch (preset) {
    case "fast":
      return {
        preset,
        deviceTier,
        splatBudget: platformProfile.ssogSplatBudget,
        expandedSortBudgetRatio: 0.55,
        cacheChunks: 48,
        maxPendingLoads: 3,
        prefetchMultiplier: 1,
        prefetchFrustumMargin: 8,
        nearPrefetchDistance: 12,
        evictAfterFrames: 4,
        cacheSplatMultiplier: 1.1,
        lodMoveEpsilon: 0.8,
        lodAngleDegrees: 18,
        selectionStableFrames: 6,
        uploadBudgetBytes: 12 * 1024 * 1024,
        chunkSortScale: 48,
        chunkSortHysteresis: 3,
        globalRuntimeRebuildIntervalFrames: 6,
      };
    case "balanced":
      return {
        preset,
        deviceTier,
        splatBudget: platformProfile.ssogSplatBudget,
        expandedSortBudgetRatio: 1,
        cacheChunks: 96,
        maxPendingLoads: 6,
        prefetchMultiplier: 1.08,
        prefetchFrustumMargin: 12,
        nearPrefetchDistance: 20,
        evictAfterFrames: 8,
        cacheSplatMultiplier: 1.35,
        lodMoveEpsilon: 0.65,
        lodAngleDegrees: 14,
        selectionStableFrames: 12,
        uploadBudgetBytes: 24 * 1024 * 1024,
        chunkSortScale: 64,
        chunkSortHysteresis: 2,
        globalRuntimeRebuildIntervalFrames: 3,
      };
    default:
      return {
        preset,
        deviceTier,
        splatBudget: platformProfile.ssogSplatBudget,
        expandedSortBudgetRatio: 1,
        cacheChunks: 128,
        maxPendingLoads: 6,
        prefetchMultiplier: 1.05,
        prefetchFrustumMargin: 6,
        nearPrefetchDistance: 16,
        evictAfterFrames: 8,
        cacheSplatMultiplier: 1.35,
        lodMoveEpsilon: 0.08,
        lodAngleDegrees: 1,
        selectionStableFrames: 2,
        uploadBudgetBytes: 48 * 1024 * 1024,
        chunkSortScale: 64,
        chunkSortHysteresis: 2,
        globalRuntimeRebuildIntervalFrames: 1,
      };
    }
  })();

  return scaleSsogQualityProfileForDevice(base);
};

const getSplatBudget = (sourceSplats: number): number => {
  const params = new URLSearchParams(window.location.search);
  const profile = getSsogQualityProfile();
  const explicit = getExplicitSplatBudget();
  if (explicit !== undefined) {
    return Math.min(sourceSplats, explicit);
  }

  if (params.get("ssogReference") === "true") {
    return sourceSplats;
  }

  const expandedGlobalSort = params.get("ssogGlobalSort") === "expanded";
  if (expandedGlobalSort && profile.preset !== "fast") {
    return sourceSplats;
  }
  if (expandedGlobalSort && profile.expandedSortBudgetRatio < 1) {
    return Math.min(sourceSplats, Math.ceil(sourceSplats * profile.expandedSortBudgetRatio));
  }
  return Math.min(sourceSplats, profile.splatBudget);
};

const getSsogCacheChunkLimit = (): number => {
  const raw = new URLSearchParams(window.location.search).get("ssogCacheChunks");
  if (raw === "all") {
    return Number.POSITIVE_INFINITY;
  }
  return Math.floor(getPositiveNumberParam("ssogCacheChunks", getSsogQualityProfile().cacheChunks));
};

const getSsogMaxPendingLoads = (): number =>
  Math.max(1, Math.floor(getPositiveNumberParam("ssogMaxPending", getSsogQualityProfile().maxPendingLoads)));

const getSsogPrefetchMultiplier = (): number =>
  Math.max(1, getPositiveNumberParam("ssogPrefetchMultiplier", getSsogQualityProfile().prefetchMultiplier));

const getSsogPrefetchFrustumMargin = (): number =>
  getNonNegativeNumberParam("ssogPrefetchFrustumMargin", getSsogQualityProfile().prefetchFrustumMargin);

const getSsogNearPrefetchDistance = (): number =>
  getNonNegativeNumberParam("ssogNearPrefetchDistance", getSsogQualityProfile().nearPrefetchDistance);

const getSsogEvictAfterFrames = (): number =>
  Math.max(0, Math.floor(getPositiveNumberParam("ssogEvictAfterFrames", getSsogQualityProfile().evictAfterFrames)));

const getSsogCacheSplatMultiplier = (): number =>
  Math.max(1, getPositiveNumberParam("ssogCacheSplatMultiplier", getSsogQualityProfile().cacheSplatMultiplier));

const getSsogDecodedCacheSplatLimit = (fallback: number): number =>
  Math.max(1, Math.floor(getPositiveNumberParam("ssogDecodedCacheSplats", fallback)));

const getLodMoveEpsilonSq = (): number => {
  const epsilon = getPositiveNumberParam("lodMoveEpsilon", getSsogQualityProfile().lodMoveEpsilon);
  return epsilon * epsilon;
};

const getLodForwardDotThreshold = (): number => {
  const degrees = getPositiveNumberParam("lodAngleDegrees", getSsogQualityProfile().lodAngleDegrees);
  return Math.cos((degrees * Math.PI) / 180);
};

const getSsogMotionMoveEpsilonSq = (): number => {
  const epsilon = getPositiveNumberParam("ssogMotionMoveEpsilon", 0.025);
  return epsilon * epsilon;
};

const getSsogMotionForwardDotThreshold = (): number => {
  const degrees = getPositiveNumberParam("ssogMotionAngleDegrees", 0.35);
  return Math.cos((degrees * Math.PI) / 180);
};

const getSsogChunkSortMode = (): SsogChunkSortMode => {
  const value = new URLSearchParams(window.location.search).get("ssogChunkSort");
  return value === "center" || value === "far" ? value : "near";
};

const getSsogChunkSortScale = (): number =>
  getPositiveNumberParam("ssogChunkSortScale", getSsogQualityProfile().chunkSortScale);

const getSsogChunkSortHysteresis = (): number =>
  Math.max(0, getPositiveNumberParam("ssogChunkSortHysteresis", getSsogQualityProfile().chunkSortHysteresis));

const getSsogGlobalRuntimeRebuildIntervalFrames = (): number =>
  Math.max(
    0,
    Math.floor(
      getNonNegativeNumberParam(
        "ssogGlobalRuntimeRebuildIntervalFrames",
        getSsogQualityProfile().globalRuntimeRebuildIntervalFrames,
      ),
    ),
  );

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
  const preset = getSsogQualityProfile().preset;
  if (params.get("ssogPackedFallback") === "expanded" || preset === "full" || preset === "screenshot") {
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

  return getSsogQualityProfile().selectionStableFrames;
};

const isSsogProgressiveGlobalBuildEnabled = (): boolean =>
  new URLSearchParams(window.location.search).get("ssogProgressiveGlobalBuild") === "true";

const getSsogUploadBudgetBytes = (): number => {
  const raw = new URLSearchParams(window.location.search).get("ssogUploadBudgetBytes");
  if (raw === "all") {
    return Number.POSITIVE_INFINITY;
  }

  return Math.floor(getPositiveNumberParam("ssogUploadBudgetBytes", getSsogQualityProfile().uploadBudgetBytes));
};

const getSsogGpuPageCapacitySplats = (): number =>
  Math.max(1, Math.floor(getPositiveNumberParam("ssogGpuPageSplats", 65_536)));

const getSogPackedDataByteLength = (data: SogPackedData): number => {
  const shNBytes = data.shN
    ? data.shN.centroids.byteLength + data.shN.labels.byteLength + data.shN.codebook.byteLength
    : 0;
  return (
    data.meansL.byteLength +
    data.meansU.byteLength +
    data.quats.byteLength +
    data.scales.byteLength +
    data.sh0.byteLength +
    data.scaleCodebook.byteLength +
    data.sh0Codebook.byteLength +
    data.centers.byteLength +
    shNBytes
  );
};

const getChunkCenterDistance = (entry: SsogChunkEntry, cameraPosition: Vector3): number => {
  const min = entry.bound.min;
  const max = entry.bound.max;
  const centerX = (min[0] + max[0]) * 0.5;
  const centerY = (min[1] + max[1]) * 0.5;
  const centerZ = (min[2] + max[2]) * 0.5;
  const radiusX = max[0] - centerX;
  const radiusY = max[1] - centerY;
  const radiusZ = max[2] - centerZ;
  const dx = centerX - cameraPosition.x;
  const dy = centerY - cameraPosition.y;
  const dz = centerZ - cameraPosition.z;
  const centerDistance = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const radius = Math.sqrt(radiusX * radiusX + radiusY * radiusY + radiusZ * radiusZ);
  return Math.max(0, centerDistance - radius);
};

class StreamingSsogRenderPass {
  private readonly gpuLoaded = new Map<string, GpuResidentChunk>();
  private readonly decodedCache = new Map<string, CachedDecodedChunk>();
  private decodedCacheBytes = 0;
  private decodedCacheSplats = 0;
  private decodedCacheBudget = Number.POSITIVE_INFINITY;
  private cpuEvictedChunks = 0;
  private reuploadedChunks = 0;
  private readonly pending = new Map<string, Promise<void>>();
  private readonly pendingEntries = new Map<string, SsogChunkEntry>();
  private readonly decodedUploadQueue = new Map<string, DecodedChunk>();
  private readonly decodedUploadScratch: DecodedChunk[] = [];
  private readonly rendererCommandQueue = new RendererCommandQueue();
  private readonly queued = new Map<string, SsogChunkEntry>();
  private readonly chunkLoadAttempts = new Map<string, number>();
  private readonly chunkRetryReadyFrame = new Map<string, number>();
  private readonly entriesByKey = new Map<string, SsogChunkEntry>();
  private readonly finestLodByNode = new Map<number, number>();
  private readonly entryKeys: string[];
  private readonly selectedKeys = new Set<string>();
  private readonly desiredKeys = new Set<string>();
  private readonly prefetchKeys = new Set<string>();
  private readonly nearPrefetchKeys = new Set<string>();
  private readonly fallbackKeys = new Set<string>();
  private readonly recentlyEvictedKeyFrames = new Map<string, number>();
  private readonly visibleEntryIndices = new ChunkIndexBuffer();
  private readonly prefetchFrustumEntryIndices = new ChunkIndexBuffer();
  private readonly nearPrefetchEntryIndices = new ChunkIndexBuffer();
  private readonly prefetchEntryIndices = new ChunkIndexBuffer();
  private readonly visibleCandidateSoA = new SsogCandidateSoA();
  private readonly prefetchCandidateSoA = new SsogCandidateSoA();
  private readonly prefetchEntryMarks: Uint32Array;
  private prefetchEntryMark = 1;
  private readonly visibleSelectItems: SelectableSsogEntry[] = [];
  private readonly prefetchSelectItems: SelectableSsogEntry[] = [];
  private readonly visibleLodScratch = new SsogLodSelectorScratch<SsogChunkEntry>();
  private readonly prefetchLodScratch = new SsogLodSelectorScratch<SsogChunkEntry>();
  private readonly stableSelectedByNode = new Map<number, SelectedSsogItem>();
  private readonly missingSelectedNodeIds = new Set<number>();
  private readonly coarseFallbackNodeIds = new Set<number>();
  private readonly renderSelectedNodeIds = new Set<number>();
  private readonly finestSelectedNodeIds = new Set<number>();
  private readonly selectedLodValues = new Set<number>();
  private readonly activeLodValues = new Set<number>();
  private readonly updateObserver: () => void;
  private readonly qualityPreset = getSsogQualityPreset();
  private readonly sourceSplats: number;
  private readonly baseSplatBudget: number;
  private splatBudget: number;
  private readonly cacheChunkLimit = getSsogCacheChunkLimit();
  private readonly baseMaxPendingLoads = getSsogMaxPendingLoads();
  private maxPendingLoads = this.baseMaxPendingLoads;
  private readonly basePrefetchMultiplier = getSsogPrefetchMultiplier();
  private prefetchMultiplier = this.basePrefetchMultiplier;
  private readonly evictAfterFrames = getSsogEvictAfterFrames();
  private readonly cacheSplatMultiplier = getSsogCacheSplatMultiplier();
  private readonly cacheSplatLimit: number;
  private readonly decodedCacheSplatLimit: number;
  private readonly gpuPagePool: SsogGpuPagePool;
  private readonly gpuBufferWriter: GpuBufferWriter | undefined;
  private readonly lodRangeMin = getPositiveNumberParam("lodRangeMin", 24);
  private readonly lodRangeMax = getPositiveNumberParam("lodRangeMax", 220);
  private readonly lodUnderfillLimit = getPositiveNumberParam("lodUnderfillLimit", 0.85);
  private readonly lodMoveEpsilonSq = getLodMoveEpsilonSq();
  private readonly lodForwardDotThreshold = getLodForwardDotThreshold();
  private readonly motionMoveEpsilonSq = getSsogMotionMoveEpsilonSq();
  private readonly motionForwardDotThreshold = getSsogMotionForwardDotThreshold();
  private readonly idleRefineFrames = Math.max(1, Math.floor(getPositiveNumberParam("ssogIdleRefineFrames", DEFAULT_IDLE_REFINE_FRAMES)));
  private readonly settleFrames = Math.max(0, Math.floor(getNonNegativeNumberParam("ssogSettleFrames", DEFAULT_SETTLE_FRAMES)));
  private readonly movingQualityScale = getPositiveNumberParam("ssogMovingQualityScale", DEFAULT_MOVING_QUALITY_SCALE);
  private readonly settlingQualityScale = getPositiveNumberParam("ssogSettlingQualityScale", DEFAULT_SETTLING_QUALITY_SCALE);
  private readonly idleQualityScale = getPositiveNumberParam("ssogIdleQualityScale", DEFAULT_IDLE_QUALITY_SCALE);
  private readonly screenshotQualityScale = getPositiveNumberParam("ssogScreenshotQualityScale", DEFAULT_SCREENSHOT_QUALITY_SCALE);
  private readonly chunkSortMode = getSsogChunkSortMode();
  private readonly chunkSortScale = getSsogChunkSortScale();
  private readonly chunkSortHysteresis = getSsogChunkSortHysteresis();
  private readonly globalRuntimeRebuildIntervalFrames = getSsogGlobalRuntimeRebuildIntervalFrames();
  private readonly mergedRendering = isSsogMergedRenderingEnabled();
  private readonly globalSortMode = getSsogGlobalSortMode();
  private readonly forceFineScreenRatio = getSsogForceFineScreenRatio();
  private readonly forceFineViewDot = getSsogForceFineViewDot();
  private readonly selectionStableFrames = getSsogSelectionStableFrames();
  private readonly progressiveGlobalBuild = isSsogProgressiveGlobalBuildEnabled();
  private readonly baseUploadBudgetBytes = getSsogUploadBudgetBytes();
  private uploadBudgetBytes = this.baseUploadBudgetBytes;
  private readonly adaptiveQualityEnabled =
    !hasExplicitNumberParam("splatBudget") &&
    !hasExplicitNumberParam("ssogMaxPending") &&
    !hasExplicitNumberParam("ssogUploadBudgetBytes") &&
    new URLSearchParams(window.location.search).get("ssogAdaptiveQuality") !== "false" &&
    new URLSearchParams(window.location.search).get("ssogReference") !== "true";
  private readonly mergedRuntimes = new Map<string, MergedRuntime>();
  private readonly pendingSelections = new Map<number, { key: string; frames: number }>();
  private readonly transitionLocks = new Map<number, number>();
  private packedGlobalRuntime?: SsogGlobalPackedRenderPass;
  private expandedRuntime?: ExpandedRuntime;
  private activeVizMode = 0;
  private frame = 0;
  private generation = 0;
  private disposed = false;
  private adaptiveQualityScale = 1;
  private adaptiveInteractionScale = 1;
  private adaptiveFrameMs = ADAPTIVE_QUALITY_TARGET_FRAME_MS;
  private lastAdaptiveFrameTime = performance.now();
  private qualityInteractionState: StreamingSsogRenderStats["qualityInteractionState"] = "idle";
  private idleFrames = 0;
  private lastQualityCameraPosition = new Vector3(Number.POSITIVE_INFINITY, 0, 0);
  private lastQualityCameraForward = new Vector3(0, 0, 0);
  private lastLodCameraPosition = new Vector3(Number.POSITIVE_INFINITY, 0, 0);
  private lastLodCameraForward = new Vector3(0, 0, 0);
  private activeChunks = 0;
  private selectedLods = 0;
  private selectedNodes = 0;
  private selectedSplats = 0;
  private requestedChunks = 0;
  private requestedSplats = 0;
  private evictedChunks = 0;
  private lastLodBuildMs = 0;
  private globalSortFallbackReason = "";
  private globalSortBuildPending = false;
  private readonly packedMetadataFingerprints = new WeakMap<SogPackedData, string>();
  private lastGlobalSortBuildMs = 0;
  private lastGlobalRuntimeRebuildFrame = Number.NEGATIVE_INFINITY;
  private lastChunkLoadMs = 0;
  private lastChunkUploadMs = 0;
  private attemptedUploadChunksThisFrame = 0;
  private uploadedBytesThisFrame = 0;
  private uploadedChunksThisFrame = 0;
  private skippedUploadChunksThisFrame = 0;
  private deferredUploadChunks = 0;
  private deferredUploadBytes = 0;
  private lodTransitionCount = 0;
  private pendingReplacementNodes = 0;
  private finestSelectedNodes = 0;
  private coarseFallbackNodes = 0;
  private fallbackReasonChildMissing = 0;
  private fallbackReasonUploadBudgetExceeded = 0;
  private fallbackReasonGpuPageUnavailable = 0;
  private fallbackReasonMemoryPressure = 0;
  private fallbackReasonBudgetThrottled = 0;
  private candidateChunks = 0;
  private frustumVisibleChunks = 0;
  private frustumCulledChunks = 0;
  private prefetchCandidateChunks = 0;
  private prefetchFrustumChunks = 0;
  private nearPrefetchChunks = 0;
  private gpuPageEvictedChunks = 0;
  private gpuPageEvictedPages = 0;
  private gpuPreUploadEvictedChunks = 0;
  private gpuPreUploadEvictedPages = 0;
  private staleQueuedChunksDropped = 0;
  private stalePendingChunksDropped = 0;
  private staleUploadChunksDropped = 0;
  private debugChunkBoundsVisible = false;
  private debugBounds!: SsogDebugBounds;

  constructor(
    private readonly scene: Scene,
    private readonly entries: SsogChunkEntry[],
    private readonly loadChunk: SsogChunkLoader,
  ) {
    this.debugBounds = new SsogDebugBounds(scene);
    this.entryKeys = entries.map((entry) => chunkKey(entry));
    this.prefetchEntryMarks = new Uint32Array(entries.length);
    entries.forEach((entry, index) => {
      this.entriesByKey.set(this.entryKeys[index], entry);
      const finestLod = this.finestLodByNode.get(entry.nodeId);
      if (finestLod === undefined || entry.lod < finestLod) {
        this.finestLodByNode.set(entry.nodeId, entry.lod);
      }
    });
    const finestEntries = entries.filter((entry) => entry.lod === 0);
    this.sourceSplats = (finestEntries.length > 0 ? finestEntries : entries).reduce(
      (sum, entry) => sum + entry.count,
      0,
    );
    this.baseSplatBudget = getSplatBudget(this.sourceSplats);
    this.splatBudget = this.baseSplatBudget;
    this.cacheSplatLimit = Math.floor(
      getPositiveNumberParam("ssogCacheSplats", Math.max(this.splatBudget * this.cacheSplatMultiplier, 1)),
    );
    this.decodedCacheSplatLimit = getSsogDecodedCacheSplatLimit(Math.max(this.cacheSplatLimit * 2, 1));
    this.decodedCacheBudget = Math.floor(
      getPositiveNumberParam("ssogDecodedCacheBytes", Math.max(this.cacheSplatLimit * 256, 64 * 1024 * 1024)),
    );
    const gpuPageCapacitySplats = getSsogGpuPageCapacitySplats();
    this.gpuPagePool = new SsogGpuPagePool(
      gpuPageCapacitySplats,
      Math.max(1, Math.ceil(this.cacheSplatLimit / gpuPageCapacitySplats)),
    );
    const engine = this.scene.getEngine();
    this.gpuBufferWriter = engine instanceof WebGPUEngine ? new GpuBufferWriter(engine, "ssog-streaming") : undefined;
    this.updateObserver = () => this.updateLodSelection();
    scene.registerBeforeRender(this.updateObserver);
    this.updateLodSelection(true);
  }

  dispose(): void {
    this.disposed = true;
    this.scene.unregisterBeforeRender(this.updateObserver);
    this.gpuLoaded.forEach((gpu) => {
      gpu.pass.dispose();
      gpu.buffers.dispose();
    });
    this.gpuPagePool.clear();
    this.disposeMergedRuntimes();
    this.disposePackedGlobalRuntime();
    this.disposeExpandedRuntime();
    this.debugBounds.disposeAll();
    this.gpuBufferWriter?.dispose();
    this.gpuLoaded.clear();
    this.decodedCache.clear();
    this.pending.clear();
    this.pendingEntries.clear();
    this.decodedUploadQueue.clear();
    this.rendererCommandQueue.clear();
    this.queued.clear();
    this.chunkLoadAttempts.clear();
    this.chunkRetryReadyFrame.clear();
    this.selectedKeys.clear();
    this.desiredKeys.clear();
    this.prefetchKeys.clear();
    this.nearPrefetchKeys.clear();
    this.fallbackKeys.clear();
    this.decodedCacheBytes = 0;
    this.decodedCacheSplats = 0;
  }

  setDebugChunkBoundsVisible(visible: boolean): void {
    this.debugChunkBoundsVisible = visible;
    if (visible) {
      this.queued.forEach((entry, key) => this.debugBounds.ensure(key, entry, "unloaded"));
      this.pendingEntries.forEach((entry, key) => this.debugBounds.ensure(key, entry, "unloaded"));
      this.gpuLoaded.forEach((gpu, key) => {
        if (gpu.active && this.isChunkRepresentedByReadyRenderPath(key)) {
          this.debugBounds.dispose(key);
        } else {
          const cached = this.decodedCache.get(key);
          if (cached) {
            this.debugBounds.ensure(key, cached.entry, "loaded-waiting");
          }
        }
      });
    }
    this.debugBounds.setVisible(visible);
  }

  setVizMode(mode: number): void {
    this.activeVizMode = mode;
    this.gpuLoaded.forEach((gpu) => gpu.pass.setVizMode(mode));
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
    const gpuPagePoolStats = this.gpuPagePool.getStats();
    const gpuBufferWriterStats = this.gpuBufferWriter?.getStats();
    const selectedKeys = Array.from(this.selectedKeys);
    const gpuActiveChunks = Array.from(this.gpuLoaded.values()).filter((gpu) => gpu.active).length;
    const activeStats = [
      ...(this.expandedRuntime ? [this.expandedRuntime.pass.getStats()] : []),
      ...(this.packedGlobalRuntime ? [this.packedGlobalRuntime.getStats()] : []),
      ...Array.from(this.mergedRuntimes.values()).map((runtime) => runtime.pass.getStats()),
      ...Array.from(this.gpuLoaded.entries())
        .filter(
          ([key, gpu]) =>
            !this.expandedRuntime && !this.packedGlobalRuntime && gpu.active && !mergedKeys.has(key),
        )
        .map(([, gpu]) => gpu.pass.getStats()),
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
      gpuBufferArenaBuffers: activeStats.reduce((sum, item) => sum + item.gpuBufferArenaBuffers, 0),
      gpuBufferArenaBytes: activeStats.reduce((sum, item) => sum + item.gpuBufferArenaBytes, 0),
      gpuBufferArenaPeakBytes: activeStats.reduce((sum, item) => sum + item.gpuBufferArenaPeakBytes, 0),
      gpuBufferArenaAllocations: activeStats.reduce((sum, item) => sum + item.gpuBufferArenaAllocations, 0),
      gpuBufferArenaReuses: activeStats.reduce((sum, item) => sum + item.gpuBufferArenaReuses, 0),
      gpuBufferArenaGrows: activeStats.reduce((sum, item) => sum + item.gpuBufferArenaGrows, 0),
      bindGroupGeneration: activeStats.reduce((sum, item) => sum + item.bindGroupGeneration, 0),
      qualityPreset: this.qualityPreset,
      qualityDeviceTier: getSsogDeviceTier(),
      splatBudget: Number.isFinite(this.splatBudget) ? this.splatBudget : -1,
      baseSplatBudget: Number.isFinite(this.baseSplatBudget) ? this.baseSplatBudget : -1,
      adaptiveQualityScale: this.adaptiveQualityScale,
      adaptiveInteractionScale: this.adaptiveInteractionScale,
      adaptiveFrameMs: this.adaptiveFrameMs,
      adaptiveTargetFrameMs: ADAPTIVE_QUALITY_TARGET_FRAME_MS,
      qualityInteractionState: this.qualityInteractionState,
      loadedChunks: this.gpuLoaded.size,
      pendingChunks: this.pending.size,
      pendingUploadChunks: this.decodedUploadQueue.size,
      queuedChunks: this.queued.size,
      prefetchedChunks: Array.from(this.gpuLoaded.entries()).filter(
        ([key, gpu]) => !gpu.active && this.prefetchKeys.has(key),
      ).length,
      evictedChunks: this.evictedChunks,
      cacheSplats: this.decodedCacheSplats,
      cacheChunkPressure: Number.isFinite(this.cacheChunkLimit)
        ? this.gpuLoaded.size / Math.max(1, this.cacheChunkLimit)
        : 0,
      cacheSplatPressure: this.decodedCacheSplats / Math.max(1, this.decodedCacheSplatLimit),
      selectedCacheRatio: this.decodedCacheSplats / Math.max(1, this.selectedSplats),
      selectedChunks: this.selectedKeys.size,
      selectedLoadedChunks: selectedKeys.filter((key) => this.gpuLoaded.has(key)).length,
      selectedPendingChunks: selectedKeys.filter((key) => this.pending.has(key)).length,
      selectedQueuedChunks: selectedKeys.filter((key) => this.queued.has(key)).length,
      selectedNodes: this.selectedNodes,
      selectedSplats: this.selectedSplats,
      fallbackChunks: this.fallbackKeys.size,
      loadedActiveChunks: gpuActiveChunks,
      loadedInactiveChunks: this.gpuLoaded.size - gpuActiveChunks,
      requestedChunks: this.requestedChunks,
      requestedSplats: this.requestedSplats,
      cacheChunkLimit: Number.isFinite(this.cacheChunkLimit) ? this.cacheChunkLimit : -1,
      cacheSplatLimit: this.cacheSplatLimit,
      gpuPagePoolPageCapacitySplats: gpuPagePoolStats.pageCapacitySplats,
      gpuPagePoolTotalPages: gpuPagePoolStats.totalPages,
      gpuPagePoolUsedPages: gpuPagePoolStats.usedPages,
      gpuPagePoolFreePages: gpuPagePoolStats.freePages,
      gpuPagePoolAllocatedChunks: gpuPagePoolStats.allocatedChunks,
      gpuPagePoolResidentSplats: gpuPagePoolStats.residentSplats,
      gpuPagePoolOverflowChunks: gpuPagePoolStats.overflowChunks,
      gpuPagePoolOverflowPages: gpuPagePoolStats.overflowPages,
      gpuPagePoolPressure: gpuPagePoolStats.pressure,
      gpuPageEvictedChunks: this.gpuPageEvictedChunks,
      gpuPageEvictedPages: this.gpuPageEvictedPages,
      decodedCacheChunks: this.decodedCache.size,
      decodedCacheBytes: this.decodedCacheBytes,
      decodedCachePressure: Math.max(
        this.decodedCacheBytes / Math.max(1, this.decodedCacheBudget),
        this.decodedCacheSplats / Math.max(1, this.decodedCacheSplatLimit),
      ),
      gpuResidentChunks: this.gpuLoaded.size,
      gpuResidentSplats: gpuPagePoolStats.residentSplats,
      cpuEvictedChunks: this.cpuEvictedChunks,
      reuploadedChunks: this.reuploadedChunks,
      protectedFallbackChunks: this.fallbackKeys.size,
      nearPrefetchChunksLoaded: Array.from(this.gpuLoaded.keys()).filter((key) => this.nearPrefetchKeys.has(key)).length,
      idlePrefetchChunksLoaded: Array.from(this.gpuLoaded.keys()).filter(
        (key) => this.prefetchKeys.has(key) && !this.nearPrefetchKeys.has(key),
      ).length,
      gpuPreUploadEvictedChunks: this.gpuPreUploadEvictedChunks,
      gpuPreUploadEvictedPages: this.gpuPreUploadEvictedPages,
      decodedCacheSplatLimit: this.decodedCacheSplatLimit,
      gpuBufferWriterTotalUploadBytes: gpuBufferWriterStats?.totalUploadBytes ?? 0,
      gpuBufferWriterTotalUploadCount: gpuBufferWriterStats?.totalUploadCount ?? 0,
      gpuBufferWriterTotalErrorCount: gpuBufferWriterStats?.totalErrorCount ?? 0,
      gpuBufferWriterTotalFallbackCount: gpuBufferWriterStats?.totalFallbackCount ?? 0,
      gpuBufferWriterScratchReuseCount: gpuBufferWriterStats?.scratchReuseCount ?? 0,
      gpuBufferWriterArenaBufferCount: gpuBufferWriterStats?.arenaBufferCount ?? 0,
      gpuBufferWriterArenaTotalBytes: gpuBufferWriterStats?.arenaTotalBytes ?? 0,
      gpuBufferWriterFrameUploadBytes: gpuBufferWriterStats?.frameUploadBytes ?? 0,
      gpuBufferWriterFrameUploadCount: gpuBufferWriterStats?.frameUploadCount ?? 0,
      gpuBufferWriterFrameErrorCount: gpuBufferWriterStats?.frameErrorCount ?? 0,
      gpuBufferWriterLastErrorMessage: gpuBufferWriterStats?.lastErrorMessage ?? "",
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
      lastChunkUploadMs: this.lastChunkUploadMs,
      uploadBudgetBytes: Number.isFinite(this.uploadBudgetBytes) ? this.uploadBudgetBytes : -1,
      staleQueuedChunksDropped: this.staleQueuedChunksDropped,
      stalePendingChunksDropped: this.stalePendingChunksDropped,
      staleUploadChunksDropped: this.staleUploadChunksDropped,
      attemptedUploadChunksThisFrame: this.attemptedUploadChunksThisFrame,
      uploadedBytesThisFrame: this.uploadedBytesThisFrame,
      uploadedChunksThisFrame: this.uploadedChunksThisFrame,
      skippedUploadChunksThisFrame: this.skippedUploadChunksThisFrame,
      deferredUploadChunks: this.deferredUploadChunks,
      deferredUploadBytes: this.deferredUploadBytes,
      lodTransitionCount: this.lodTransitionCount,
      pendingReplacementNodes: this.pendingReplacementNodes,
      finestSelectedNodes: this.finestSelectedNodes,
      coarseFallbackNodes: this.coarseFallbackNodes,
      fallbackReasonChildMissing: this.fallbackReasonChildMissing,
      fallbackReasonUploadBudgetExceeded: this.fallbackReasonUploadBudgetExceeded,
      fallbackReasonGpuPageUnavailable: this.fallbackReasonGpuPageUnavailable,
      fallbackReasonMemoryPressure: this.fallbackReasonMemoryPressure,
      fallbackReasonBudgetThrottled: this.fallbackReasonBudgetThrottled,
      fallbackReasonBreakdown: [
        this.fallbackReasonChildMissing > 0 ? `child_missing:${this.fallbackReasonChildMissing}` : "",
        this.fallbackReasonUploadBudgetExceeded > 0 ? `upload_budget:${this.fallbackReasonUploadBudgetExceeded}` : "",
        this.fallbackReasonGpuPageUnavailable > 0 ? `gpu_page:${this.fallbackReasonGpuPageUnavailable}` : "",
        this.fallbackReasonMemoryPressure > 0 ? `memory_pressure:${this.fallbackReasonMemoryPressure}` : "",
        this.fallbackReasonBudgetThrottled > 0 ? `budget_throttled:${this.fallbackReasonBudgetThrottled}` : "",
      ].filter(Boolean).join(", "),
      candidateChunks: this.candidateChunks,
      frustumVisibleChunks: this.frustumVisibleChunks,
      frustumCulledChunks: this.frustumCulledChunks,
      frustumMargin: getPositiveNumberParam("frustumMargin", 1),
      prefetchCandidateChunks: this.prefetchCandidateChunks,
      prefetchFrustumChunks: this.prefetchFrustumChunks,
      nearPrefetchChunks: this.nearPrefetchChunks,
      candidateSoACapacity: this.visibleCandidateSoA.entryIndices.length,
      candidateSoAGrows: this.visibleCandidateSoA.growCount + this.prefetchCandidateSoA.growCount,
      rendererCommandsPending: this.rendererCommandQueue.pending,
      rendererCommandsQueued: this.rendererCommandQueue.queuedTotal,
      rendererCommandsDeduped: this.rendererCommandQueue.dedupedTotal,
      rendererCommandsFlushed: this.rendererCommandQueue.flushedTotal,
      rendererCommandPoolGrows: this.rendererCommandQueue.poolGrows,
      prefetchFrustumMargin: getSsogPrefetchFrustumMargin(),
      nearPrefetchDistance: getSsogNearPrefetchDistance(),
    };
  }

  private updateAdaptiveQuality(): void {
    const now = performance.now();
    const frameMs = Math.min(250, Math.max(0, now - this.lastAdaptiveFrameTime));
    this.lastAdaptiveFrameTime = now;
    this.adaptiveFrameMs = this.adaptiveFrameMs * 0.9 + frameMs * 0.1;

    if (!this.adaptiveQualityEnabled) {
      this.adaptiveQualityScale = 1;
      this.adaptiveInteractionScale = 1;
      this.splatBudget = this.baseSplatBudget;
      this.maxPendingLoads = this.baseMaxPendingLoads;
      this.prefetchMultiplier = this.basePrefetchMultiplier;
      this.uploadBudgetBytes = this.baseUploadBudgetBytes;
      return;
    }

    const cachePressure = Math.max(
      Number.isFinite(this.cacheChunkLimit) ? this.gpuLoaded.size / Math.max(1, this.cacheChunkLimit) : 0,
      this.decodedCacheSplats / Math.max(1, this.cacheSplatLimit),
      this.decodedCacheBytes / Math.max(1, this.decodedCacheBudget),
      this.gpuPagePool.getStats().pressure,
    );
    const queuePressure =
      (this.pending.size + this.decodedUploadQueue.size + this.queued.size) / Math.max(1, this.baseMaxPendingLoads * 3);
    const frameOverTarget = this.adaptiveFrameMs / ADAPTIVE_QUALITY_TARGET_FRAME_MS;
    const pressure = Math.max(cachePressure, queuePressure);
    const overloaded = frameOverTarget > 1.12 || pressure > 0.92;
    const comfortable = frameOverTarget < 0.82 && pressure < 0.68;

    if (overloaded) {
      const severity = Math.max(frameOverTarget - 1, pressure - 0.88, 0);
      this.adaptiveQualityScale = Math.max(
        ADAPTIVE_QUALITY_MIN_SCALE,
        this.adaptiveQualityScale - ADAPTIVE_QUALITY_DECAY_RATE * Math.min(2, 1 + severity),
      );
    } else if (comfortable) {
      this.adaptiveQualityScale = Math.min(
        ADAPTIVE_QUALITY_MAX_SCALE,
        this.adaptiveQualityScale + ADAPTIVE_QUALITY_RECOVERY_RATE,
      );
    }

    this.adaptiveInteractionScale = this.getInteractionQualityScale();
    const effectiveBudget = Math.max(
      1,
      Math.floor(this.baseSplatBudget * this.adaptiveQualityScale * this.adaptiveInteractionScale),
    );
    this.splatBudget = Math.min(this.sourceSplats, effectiveBudget);
    const loadScale = Math.max(0.45, Math.min(1.25, this.adaptiveQualityScale * this.adaptiveInteractionScale));
    this.maxPendingLoads = Math.max(1, Math.floor(this.baseMaxPendingLoads * loadScale));
    this.prefetchMultiplier = 1 + Math.max(0, this.basePrefetchMultiplier - 1) * loadScale;
    this.uploadBudgetBytes = Number.isFinite(this.baseUploadBudgetBytes)
      ? Math.max(1 * 1024 * 1024, Math.floor(this.baseUploadBudgetBytes * loadScale))
      : Number.POSITIVE_INFINITY;
  }

  private updateInteractionQualityState(cameraPosition: Vector3, cameraForward: Vector3): void {
    const initial = !Number.isFinite(this.lastQualityCameraPosition.x);
    const moved = initial || Vector3.DistanceSquared(cameraPosition, this.lastQualityCameraPosition) > this.motionMoveEpsilonSq;
    const turned = initial || Vector3.Dot(cameraForward, this.lastQualityCameraForward) < this.motionForwardDotThreshold;

    if (moved || turned) {
      this.idleFrames = 0;
      this.qualityInteractionState = "moving";
    } else {
      this.idleFrames++;
      this.qualityInteractionState =
        this.idleFrames >= Math.max(this.settleFrames, this.idleRefineFrames) ? "idle" : "settling";
    }

    if (this.qualityPreset === "screenshot") {
      this.qualityInteractionState = "screenshot";
    }

    this.lastQualityCameraPosition.copyFrom(cameraPosition);
    this.lastQualityCameraForward.copyFrom(cameraForward);
  }

  private getInteractionQualityScale(): number {
    switch (this.qualityInteractionState) {
    case "screenshot":
      return this.screenshotQualityScale;
    case "idle":
      return this.idleQualityScale;
    case "settling":
      return this.settlingQualityScale;
    case "moving":
    default:
      return this.movingQualityScale;
    }
  }

  private isChunkWanted(key: string): boolean {
    return this.getCacheClass(key) !== "inactive";
  }

  private getCacheClass(key: string): CacheClass {
    if (this.fallbackKeys.has(key)) {
      return "fallback";
    }
    if (this.selectedKeys.has(key)) {
      return "selected";
    }
    if (this.desiredKeys.has(key)) {
      return "desired";
    }
    if (this.prefetchKeys.has(key) && this.nearPrefetchKeys.has(key)) {
      return "near-prefetch";
    }
    if (this.prefetchKeys.has(key)) {
      return "idle-prefetch";
    }
    return "inactive";
  }

  private getSchedulingPriority(key: string): SsogChunkLoadPriority {
    switch (this.getCacheClass(key)) {
      case "fallback":
        return 0;
      case "selected":
        return 1;
      case "desired":
        return 2;
      case "near-prefetch":
        return 3;
      case "idle-prefetch":
        return 4;
      case "inactive":
        return 5;
    }
  }

  private dropStaleQueuedChunks(): void {
    for (const key of this.queued.keys()) {
      if (this.isChunkWanted(key) || this.generation === 0) {
        continue;
      }

      this.queued.delete(key);
      this.chunkLoadAttempts.delete(key);
      this.chunkRetryReadyFrame.delete(key);
      this.debugBounds.dispose(key);
      this.staleQueuedChunksDropped++;
    }
  }

  private dropStaleDecodedUploads(): void {
    for (const key of this.decodedUploadQueue.keys()) {
      if (this.isChunkWanted(key) || this.generation === 0) {
        continue;
      }

      this.decodedUploadQueue.delete(key);
      this.debugBounds.dispose(key);
      this.staleUploadChunksDropped++;
    }
    this.deferredUploadChunks = this.decodedUploadQueue.size;
    this.deferredUploadBytes = this.getDecodedUploadQueueBytes();
  }

  private updateLodSelection(force = false): void {
    this.frame = (this.frame + 1) % LOD_SELECT_INTERVAL_FRAMES;
    this.gpuBufferWriter?.beginFrame();
    const camera = this.scene.activeCamera;
    if (!camera) {
      this.updateAdaptiveQuality();
      return;
    }

    const cameraPosition = camera.globalPosition;
    const cameraForward = camera.getDirection(Vector3.Forward());
    this.updateInteractionQualityState(cameraPosition, cameraForward);
    this.updateAdaptiveQuality();
    force = this.processRendererCommandQueue() > 0 || force;
    this.attemptedUploadChunksThisFrame = 0;
    this.uploadedBytesThisFrame = 0;
    this.uploadedChunksThisFrame = 0;
    this.skippedUploadChunksThisFrame = 0;
    this.deferredUploadChunks = this.decodedUploadQueue.size;
    this.deferredUploadBytes = this.getDecodedUploadQueueBytes();
    this.dropStaleDecodedUploads();
    force = this.processDecodedUploadQueue() > 0 || force;

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
    const prefetchFrustumMargin = Math.max(frustumMargin, getSsogPrefetchFrustumMargin());
    const nearPrefetchDistance = getSsogNearPrefetchDistance();
    const frustumPlanes = frustumCullingEnabled ? Frustum.GetPlanes(camera.getTransformationMatrix()) : undefined;
    this.buildLodCandidateBuffers(frustumPlanes, frustumMargin, prefetchFrustumMargin, nearPrefetchDistance, cameraPosition);
    this.candidateChunks = this.entries.length;
    this.frustumVisibleChunks = this.visibleEntryIndices.length;
    this.frustumCulledChunks = this.entries.length - this.visibleEntryIndices.length;
    this.prefetchFrustumChunks = this.prefetchFrustumEntryIndices.length;
    this.nearPrefetchChunks = this.nearPrefetchEntryIndices.length;
    this.prefetchCandidateChunks = this.prefetchEntryIndices.length;

    const fov = "fov" in camera && typeof camera.fov === "number" ? camera.fov : Math.PI / 3;
    const viewportHeight = this.scene.getEngine().getRenderHeight(true);
    const focalPixels = viewportHeight / Math.max(0.001, 2 * Math.tan(fov * 0.5));
    const visibleItems = this.fillSelectableItems(
      this.visibleSelectItems,
      this.visibleCandidateSoA,
      this.visibleEntryIndices,
      false,
    );
    const selection = selectSsogLodFromSoA(
      this.visibleCandidateSoA,
      visibleItems,
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
      this.visibleLodScratch,
    );
    const prefetchBudgetMultiplier =
      this.prefetchEntryIndices.length > this.visibleEntryIndices.length
        ? Math.max(this.prefetchMultiplier, 1.25)
        : this.prefetchMultiplier;
    const prefetchSelection =
      this.prefetchEntryIndices.length > this.visibleEntryIndices.length || this.prefetchMultiplier > 1
        ? selectSsogLodFromSoA(
            this.prefetchCandidateSoA,
            this.fillSelectableItems(
              this.prefetchSelectItems,
              this.prefetchCandidateSoA,
              this.prefetchEntryIndices,
              true,
            ),
            {
              budget: Math.min(this.sourceSplats, Math.floor(this.splatBudget * prefetchBudgetMultiplier)),
              cameraPosition,
              cameraForward,
              focalPixels,
              lodRangeMin: this.lodRangeMin,
              lodRangeMax: this.lodRangeMax,
              lodUnderfillLimit: this.lodUnderfillLimit,
              forceFineScreenRatio: this.forceFineScreenRatio,
              forceFineViewDot: this.forceFineViewDot,
            },
            this.prefetchLodScratch,
          )
        : selection;

    const stableSelected = this.stabilizeSelection(selection.selected);
    const renderSelected = this.resolveResidentSelection(stableSelected);
    const stableSelectedByNode = this.stableSelectedByNode;
    stableSelectedByNode.clear();
    for (const item of stableSelected) {
      stableSelectedByNode.set(item.nodeId, item);
    }
    this.selectedKeys.clear();
    for (let index = 0; index < renderSelected.length; index++) {
      this.selectedKeys.add(renderSelected[index].key);
    }
    this.desiredKeys.clear();
    for (let index = 0; index < stableSelected.length; index++) {
      this.desiredKeys.add(stableSelected[index].key);
    }
    this.fallbackKeys.clear();
    const missingSelectedNodeIds = this.missingSelectedNodeIds;
    missingSelectedNodeIds.clear();
    for (const item of stableSelected) {
      if (!this.gpuLoaded.has(item.key)) {
        missingSelectedNodeIds.add(item.nodeId);
      }
    }
    for (const nodeId of missingSelectedNodeIds) {
      const fallback = this.getCoarsestEntryForNode(nodeId);
      if (fallback) {
        const fallbackKey = chunkKey(fallback);
        if (this.gpuLoaded.has(fallbackKey)) {
          this.fallbackKeys.add(fallbackKey);
        }
        this.requestChunk(fallback);
      }
    }
    for (let index = 0; index < renderSelected.length; index++) {
      const item = renderSelected[index];
      const requested = stableSelectedByNode.get(item.nodeId);
      if (requested && requested.key !== item.key) {
        this.fallbackKeys.add(item.key);
      }
    }
    this.coarseFallbackNodeIds.clear();
    for (const key of this.fallbackKeys) {
      const nodeId = this.entriesByKey.get(key)?.nodeId;
      if (nodeId !== undefined) {
        this.coarseFallbackNodeIds.add(nodeId);
      }
    }
    this.coarseFallbackNodes = this.coarseFallbackNodeIds.size;

    this.updateFallbackReasonStats(stableSelected, selection.selectedSplats);

    this.prefetchKeys.clear();
    this.nearPrefetchKeys.clear();
    for (let index = 0; index < this.nearPrefetchEntryIndices.length; index++) {
      const entryIndex = this.nearPrefetchEntryIndices.data[index];
      const key = this.entryKeys[entryIndex];
      if (key) {
        this.nearPrefetchKeys.add(key);
      }
    }
    for (let index = 0; index < prefetchSelection.selected.length; index++) {
      const item = prefetchSelection.selected[index];
      if (!this.selectedKeys.has(item.key)) {
        this.prefetchKeys.add(item.key);
        this.desiredKeys.add(item.key);
      }
    }
    this.renderSelectedNodeIds.clear();
    this.finestSelectedNodeIds.clear();
    this.selectedLodValues.clear();
    let renderSelectedSplats = 0;
    for (const item of renderSelected) {
      this.renderSelectedNodeIds.add(item.nodeId);
      this.selectedLodValues.add(item.lod);
      renderSelectedSplats += item.count;
      if (item.lod === 0) {
        this.finestSelectedNodeIds.add(item.nodeId);
      }
    }
    this.selectedNodes = this.renderSelectedNodeIds.size;
    this.selectedSplats = renderSelectedSplats;
    this.finestSelectedNodes = this.finestSelectedNodeIds.size;
    this.requestedChunks = prefetchSelection.selected.length;
    this.requestedSplats = prefetchSelection.selectedSplats;
    const activeLods = this.activeLodValues;
    activeLods.clear();
    let activeChunks = 0;
    for (const [key, gpu] of this.gpuLoaded) {
      const selected = this.selectedKeys.has(key);
      const fallback = this.fallbackKeys.has(key);
      gpu.active = selected || fallback;
      gpu.pass.setEnabled(this.globalSortMode === "off" && !this.mergedRendering && gpu.active);
      if (gpu.active && this.isChunkRepresentedByReadyRenderPath(key)) {
        this.debugBounds.dispose(key);
        activeChunks++;
        const cached = this.decodedCache.get(key);
        if (cached) {
          activeLods.add(cached.entry.lod);
          this.touchDecodedCache(key);
        }
        gpu.lastUsedFrame = this.generation;
      } else if (this.debugChunkBoundsVisible) {
        const cached = this.decodedCache.get(key);
        if (cached) {
          this.debugBounds.ensure(key, cached.entry, "loaded-waiting");
        }
      }
    }
    this.disposeDebugChunkBoundsForReadyRenderedNodes();
    this.activeChunks = Math.max(renderSelected.length, activeChunks);
    this.selectedLods = Math.max(this.selectedLodValues.size, activeLods.size);
    this.dropStaleQueuedChunks();
    this.dropStaleDecodedUploads();
    for (let index = 0; index < stableSelected.length; index++) {
      this.requestChunk(stableSelected[index].value);
    }
    for (let index = 0; index < selection.selected.length; index++) {
      this.requestChunk(selection.selected[index].value);
    }
    for (let index = 0; index < prefetchSelection.selected.length; index++) {
      this.requestChunk(prefetchSelection.selected[index].value);
    }
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
    this.disposeDebugChunkBoundsForReadyRenderedNodes();
    this.lastLodBuildMs = performance.now() - start;
  }

  private buildLodCandidateBuffers(
    frustumPlanes: Plane[] | undefined,
    frustumMargin: number,
    prefetchFrustumMargin: number,
    nearPrefetchDistance: number,
    cameraPosition: Vector3,
  ): void {
    this.visibleEntryIndices.reset();
    this.prefetchFrustumEntryIndices.reset();
    this.nearPrefetchEntryIndices.reset();
    this.prefetchEntryIndices.reset();

    this.prefetchEntryMark++;
    if (this.prefetchEntryMark >= 0xffffffff) {
      this.prefetchEntryMarks.fill(0);
      this.prefetchEntryMark = 1;
    }
    const mark = this.prefetchEntryMark;

    const addPrefetchIndex = (index: number): void => {
      if (this.prefetchEntryMarks[index] === mark) {
        return;
      }
      this.prefetchEntryMarks[index] = mark;
      this.prefetchEntryIndices.push(index);
    };

    for (let index = 0; index < this.entries.length; index++) {
      const entry = this.entries[index];
      if (!frustumPlanes || isAabbInFrustum(entry.bound, frustumPlanes, frustumMargin)) {
        this.visibleEntryIndices.push(index);
      }

      if (!frustumPlanes || isAabbInFrustum(entry.bound, frustumPlanes, prefetchFrustumMargin)) {
        this.prefetchFrustumEntryIndices.push(index);
        addPrefetchIndex(index);
      }

      if (nearPrefetchDistance > 0 && getChunkCenterDistance(entry, cameraPosition) <= nearPrefetchDistance) {
        this.nearPrefetchEntryIndices.push(index);
        addPrefetchIndex(index);
      }
    }
  }

  private fillSelectableItems(
    target: SelectableSsogEntry[],
    candidateSoA: SsogCandidateSoA,
    indices: ChunkIndexBuffer,
    includePrefetchKeys: boolean,
  ): SelectableSsogEntry[] {
    target.length = indices.length;
    candidateSoA.reset(indices.length);
    for (let itemIndex = 0; itemIndex < indices.length; itemIndex++) {
      const entryIndex = indices.data[itemIndex];
      const entry = this.entries[entryIndex];
      const key = this.entryKeys[entryIndex];
      const wasSelected = this.selectedKeys.has(key) || (includePrefetchKeys && this.prefetchKeys.has(key));
      candidateSoA.set(itemIndex, entryIndex, entry, wasSelected);
      const item = target[itemIndex];
      if (item) {
        item.value = entry;
        item.key = key;
        item.nodeId = entry.nodeId;
        item.parentNodeId = entry.parentNodeId;
        item.depth = entry.depth;
        item.lod = entry.lod;
        item.count = entry.count;
        item.bound = entry.bound;
        item.wasSelected = wasSelected;
      } else {
        target[itemIndex] = {
          value: entry,
          key,
          nodeId: entry.nodeId,
          parentNodeId: entry.parentNodeId,
          depth: entry.depth,
          lod: entry.lod,
          count: entry.count,
          bound: entry.bound,
          wasSelected,
        };
      }
    }
    return target;
  }

  private processRendererCommandQueue(): number {
    if (this.disposed || this.rendererCommandQueue.pending === 0) {
      return 0;
    }

    return this.rendererCommandQueue.flush((command) => this.processRendererCommand(command));
  }

  private processRendererCommand(command: RendererCommand): boolean {
    switch (command.type) {
      case "chunkLoaded":
        if (!command.entry || !command.chunk || this.gpuLoaded.has(command.key) || this.decodedUploadQueue.has(command.key)) {
          return false;
        }
        if (!this.isChunkWanted(command.key) && this.generation > 0) {
          this.chunkLoadAttempts.delete(command.key);
          this.chunkRetryReadyFrame.delete(command.key);
          this.debugBounds.dispose(command.key);
          this.stalePendingChunksDropped++;
          return true;
        }
        this.chunkLoadAttempts.delete(command.key);
        this.chunkRetryReadyFrame.delete(command.key);
        this.lastChunkLoadMs = command.loadMs;
        this.decodedUploadQueue.set(command.key, {
          key: command.key,
          entry: command.entry,
          chunk: command.chunk,
          bytes: getSogPackedDataByteLength(command.chunk.data),
        });
        return true;
      case "chunkLoadFailed":
        if (!command.entry) {
          return false;
        }
        if (!this.isChunkWanted(command.key) && this.generation > 0) {
          this.chunkLoadAttempts.delete(command.key);
          this.chunkRetryReadyFrame.delete(command.key);
          this.debugBounds.dispose(command.key);
          return true;
        }
        console.warn(`Failed to load SSOG chunk ${command.key}.`, command.error);
        this.scheduleChunkRetry(command.key, command.entry);
        return true;
      case "chunkLoadSettled":
        this.pending.delete(command.key);
        this.pendingEntries.delete(command.key);
        if (!this.gpuLoaded.has(command.key) && !this.decodedUploadQueue.has(command.key) && !this.queued.has(command.key)) {
          this.debugBounds.dispose(command.key);
        }
        this.pumpChunkQueue();
        return true;
    }
  }

  private requestChunk(entry: SsogChunkEntry): void {
    const key = chunkKey(entry);
    if (this.gpuLoaded.has(key) || this.pending.has(key) || this.decodedUploadQueue.has(key) || this.queued.has(key)) {
      return;
    }

    this.queued.set(key, entry);
    if (this.debugChunkBoundsVisible) {
      this.debugBounds.ensure(key, entry, "unloaded");
    }
  }

  private getChunkLoadPriority(key: string): SsogChunkLoadPriority {
    return this.getSchedulingPriority(key);
  }

  private isRetryReady(key: string): boolean {
    return (this.chunkRetryReadyFrame.get(key) ?? 0) <= this.generation;
  }

  private scheduleChunkRetry(key: string, entry: SsogChunkEntry): void {
    if (this.gpuLoaded.has(key) || this.decodedUploadQueue.has(key) || this.queued.has(key)) {
      return;
    }

    const attempt = this.chunkLoadAttempts.get(key) ?? 0;
    if (attempt >= 3) {
      this.chunkLoadAttempts.delete(key);
      this.chunkRetryReadyFrame.delete(key);
      return;
    }

    this.chunkLoadAttempts.set(key, attempt + 1);
    this.chunkRetryReadyFrame.set(key, this.generation + Math.min(60, 2 ** attempt));
    this.queued.set(key, entry);
  }

  private pumpChunkQueue(): void {
    if (this.disposed) {
      return;
    }

    while (this.pending.size < this.maxPendingLoads && this.queued.size > 0) {
      const reserveUrgentSlot = this.maxPendingLoads > 1 && this.pending.size >= this.maxPendingLoads - 1;
      const next = this.takeNextQueuedChunk(reserveUrgentSlot);
      if (!next) {
        return;
      }

      this.startChunkLoad(next);
    }
  }

  private takeNextQueuedChunk(urgentOnly: boolean): SsogChunkEntry | undefined {
    let bestKey = "";
    let bestEntry: SsogChunkEntry | undefined;
    let bestPriority: SsogChunkLoadPriority = 5;
    let bestCount = Number.POSITIVE_INFINITY;

    for (const [key, entry] of this.queued) {
      const priority = this.getChunkLoadPriority(key);
      if (priority >= 5) {
        this.queued.delete(key);
        this.chunkLoadAttempts.delete(key);
        this.chunkRetryReadyFrame.delete(key);
        this.debugBounds.dispose(key);
        continue;
      }

      if (urgentOnly && priority > 1) {
        continue;
      }
      if (!this.isRetryReady(key)) {
        continue;
      }

      if (priority < bestPriority || (priority === bestPriority && entry.count < bestCount)) {
        bestKey = key;
        bestEntry = entry;
        bestPriority = priority;
        bestCount = entry.count;
      }
    }

    if (!bestEntry) {
      return undefined;
    }

    this.queued.delete(bestKey);
    return bestEntry;
  }

  private startChunkLoad(entry: SsogChunkEntry): void {
    const key = chunkKey(entry);
    if (this.gpuLoaded.has(key) || this.pending.has(key) || this.decodedUploadQueue.has(key)) {
      return;
    }

    const cachedDecoded = this.decodedCache.get(key);
    if (cachedDecoded) {
      this.touchDecodedCache(key);
      this.reuploadedChunks++;
      this.rendererCommandQueue.enqueueChunkLoaded(key, cachedDecoded.entry, cachedDecoded.chunk, 0);
      return;
    }

    this.pendingEntries.set(key, entry);
    if (this.debugChunkBoundsVisible) {
      this.debugBounds.ensure(key, entry, "unloaded");
    }
    const loadStart = performance.now();
    const promise = this.loadChunk(entry)
      .then((chunk) => {
        if (this.disposed) {
          return;
        }

        this.rendererCommandQueue.enqueueChunkLoaded(key, entry, chunk, performance.now() - loadStart);
      })
      .catch((error) => {
        if (this.disposed) {
          return;
        }

        this.rendererCommandQueue.enqueueChunkLoadFailed(key, entry, error);
      })
      .finally(() => {
        if (this.disposed) {
          return;
        }

        this.rendererCommandQueue.enqueueChunkLoadSettled(key);
      });

    this.pending.set(key, promise);
  }

  private processDecodedUploadQueue(): number {
    if (this.disposed || this.decodedUploadQueue.size === 0) {
      return 0;
    }

    const uploadStart = performance.now();
    const queued = this.decodedUploadScratch;
    queued.length = 0;
    for (const decoded of this.decodedUploadQueue.values()) {
      queued.push(decoded);
    }
    queued.sort(
      (a, b) => this.getUploadPriority(a.key) - this.getUploadPriority(b.key) || a.bytes - b.bytes,
    );
    const diagnostics: SsogUploadFrameDiagnostics = {
      attemptedChunks: 0,
      uploadedChunks: 0,
      uploadedBytes: 0,
      skippedLoadedChunks: 0,
      deferredChunks: 0,
      deferredBytes: 0,
    };
    const budgetState: SsogUploadBudgetState = {
      uploadedChunks: 0,
      uploadedBytes: 0,
    };

    for (const decoded of queued) {
      this.processDecodedUpload(decoded, budgetState, diagnostics);
    }
    queued.length = 0;

    this.attemptedUploadChunksThisFrame = diagnostics.attemptedChunks;
    this.uploadedChunksThisFrame = diagnostics.uploadedChunks;
    this.uploadedBytesThisFrame = diagnostics.uploadedBytes;
    this.skippedUploadChunksThisFrame = diagnostics.skippedLoadedChunks;
    this.deferredUploadChunks = diagnostics.deferredChunks;
    this.deferredUploadBytes = diagnostics.deferredBytes;
    this.lastChunkUploadMs = diagnostics.uploadedChunks > 0 ? performance.now() - uploadStart : 0;
    return diagnostics.uploadedChunks;
  }

  private processDecodedUpload(
    decoded: DecodedChunk,
    budgetState: SsogUploadBudgetState,
    diagnostics: SsogUploadFrameDiagnostics,
  ): void {
    diagnostics.attemptedChunks++;

    if (this.getSchedulingPriority(decoded.key) >= 5) {
      this.decodedUploadQueue.delete(decoded.key);
      this.debugBounds.dispose(decoded.key);
      this.staleUploadChunksDropped++;
      return;
    }

    if (this.gpuLoaded.has(decoded.key)) {
      this.decodedUploadQueue.delete(decoded.key);
      diagnostics.skippedLoadedChunks++;
      return;
    }

    if (this.shouldDeferDecodedUpload(decoded, budgetState)) {
      diagnostics.deferredChunks++;
      diagnostics.deferredBytes += decoded.bytes;
      return;
    }

    this.writeDecodedChunkToGpu(decoded);
    this.decodedUploadQueue.delete(decoded.key);
    budgetState.uploadedChunks++;
    budgetState.uploadedBytes += decoded.bytes;
    diagnostics.uploadedChunks++;
    diagnostics.uploadedBytes += decoded.bytes;
  }

  private shouldDeferDecodedUpload(decoded: DecodedChunk, budgetState: SsogUploadBudgetState): boolean {
    return (
      Number.isFinite(this.uploadBudgetBytes) &&
      budgetState.uploadedChunks > 0 &&
      budgetState.uploadedBytes + decoded.bytes > this.uploadBudgetBytes
    );
  }

  private getDecodedUploadQueueBytes(): number {
    let bytes = 0;
    for (const decoded of this.decodedUploadQueue.values()) {
      bytes += decoded.bytes;
    }
    return bytes;
  }

  private getUploadPriority(key: string): number {
    return this.getSchedulingPriority(key);
  }

  private writeDecodedChunkToGpu(decoded: DecodedChunk): void {
    const { key, entry, chunk } = decoded;

    if (!this.decodedCache.has(key)) {
      this.decodedCache.set(key, {
        entry,
        chunk,
        bytes: decoded.bytes,
        lastUsedFrame: this.generation,
      });
      this.decodedCacheBytes += decoded.bytes;
      this.decodedCacheSplats += chunk.data.numSplats;
    }

    if (this.gpuLoaded.has(key)) {
      return;
    }

    this.evictGpuChunksForUpload(decoded);
    const buffers = new SogBuffers(this.scene.getEngine(), chunk.data, this.gpuBufferWriter);
    const pass = new PackedSogRenderPass(this.scene, buffers);
    pass.setVizMode(this.activeVizMode);
    const active = this.selectedKeys.has(key) || this.fallbackKeys.has(key);
    pass.setEnabled(this.globalSortMode === "off" && !this.mergedRendering && active);
    const pageAllocation = this.gpuPagePool.allocateChunk(key, chunk.data.numSplats);
    this.gpuLoaded.set(key, {
      buffers,
      pass,
      active,
      lastUsedFrame: this.generation,
      pageAllocation,
    });
    if (active && this.isChunkRepresentedByReadyRenderPath(key)) {
      this.debugBounds.dispose(key);
    } else if (this.debugChunkBoundsVisible) {
      this.debugBounds.ensure(key, entry, "loaded-waiting");
    }

    this.evictDecodedCache();
  }

  private evictInactiveChunks(): void {
    const initialPageStats = this.gpuPagePool.getStats();
    const pagePressure = initialPageStats.pressure > 0.98 || initialPageStats.overflowPages > 0;
    const inactive = Array.from(this.gpuLoaded.entries())
      .filter(([key, gpu]) => {
        const protectedChunk = this.isGpuChunkProtected(key, gpu);
        const oldEnough = this.generation - gpu.lastUsedFrame >= this.evictAfterFrames;
        return !protectedChunk && (oldEnough || pagePressure);
      })
      .sort((a, b) => {
        const priorityA = this.getGpuPageEvictionPriority(a[0]);
        const priorityB = this.getGpuPageEvictionPriority(b[0]);
        return priorityA - priorityB || a[1].lastUsedFrame - b[1].lastUsedFrame;
      });

    let evictedChunks = 0;
    let evictedPages = 0;
    for (const [key, gpu] of inactive) {
      const pageStats = this.gpuPagePool.getStats();
      const overCache = this.gpuLoaded.size > this.cacheChunkLimit;
      const overPages = pageStats.pressure > 0.98 || pageStats.overflowPages > 0;
      if (!overCache && !overPages) {
        break;
      }

      evictedPages += this.evictGpuResidentChunk(key, gpu);
      evictedChunks++;
    }

    if (evictedPages > 0) {
      this.gpuPageEvictedChunks += evictedChunks;
      this.gpuPageEvictedPages += evictedPages;
      this.repackGpuPagePool();
      this.evictDecodedCache();
    }

    if (this.globalSortMode === "packed") {
      this.updatePackedGlobalRuntime();
    } else if (this.globalSortMode === "expanded") {
      this.updateExpandedRuntime();
    } else {
      this.updateMergedRuntime();
    }
  }

  private evictGpuChunksForUpload(decoded: DecodedChunk): void {
    const pageStats = this.gpuPagePool.getStats();
    const requiredPages = Math.max(1, Math.ceil(decoded.chunk.data.numSplats / pageStats.pageCapacitySplats));
    const needsChunkRoom = Number.isFinite(this.cacheChunkLimit) && this.gpuLoaded.size >= this.cacheChunkLimit;
    const needsPageRoom = pageStats.freePages < requiredPages || pageStats.overflowPages > 0;
    if (!needsChunkRoom && !needsPageRoom) {
      return;
    }

    const candidates = Array.from(this.gpuLoaded.entries())
      .filter(([key, gpu]) => !this.isGpuChunkProtected(key, gpu))
      .sort((a, b) => {
        const priorityA = this.getGpuPageEvictionPriority(a[0]);
        const priorityB = this.getGpuPageEvictionPriority(b[0]);
        return priorityA - priorityB || a[1].lastUsedFrame - b[1].lastUsedFrame;
      });

    let evictedChunks = 0;
    let evictedPages = 0;
    for (const [key, gpu] of candidates) {
      const stats = this.gpuPagePool.getStats();
      const hasChunkRoom = !Number.isFinite(this.cacheChunkLimit) || this.gpuLoaded.size < this.cacheChunkLimit;
      const hasPageRoom = stats.freePages >= requiredPages && stats.overflowPages === 0;
      if (hasChunkRoom && hasPageRoom) {
        break;
      }

      evictedPages += this.evictGpuResidentChunk(key, gpu);
      evictedChunks++;
    }

    if (evictedChunks > 0) {
      this.gpuPreUploadEvictedChunks += evictedChunks;
      this.gpuPreUploadEvictedPages += evictedPages;
      this.gpuPageEvictedChunks += evictedChunks;
      this.gpuPageEvictedPages += evictedPages;
      this.evictDecodedCache();
    }
  }

  private evictGpuResidentChunk(key: string, gpu: GpuResidentChunk): number {
    const pages = gpu.pageAllocation.pages.length + gpu.pageAllocation.overflowPages;
    gpu.pass.dispose();
    gpu.buffers.dispose();
    this.gpuPagePool.freeChunk(key);
    this.gpuLoaded.delete(key);
    this.debugBounds.dispose(key);
    this.recentlyEvictedKeyFrames.set(key, this.generation);
    this.evictedChunks++;
    return pages;
  }

  private evictDecodedCache(): void {
    if (this.isDecodedCacheWithinBudget()) {
      return;
    }

    const evictable = Array.from(this.decodedCache.entries())
      .filter(([key]) => !this.gpuLoaded.has(key))
      .sort((a, b) => {
        const priorityA = this.getDecodedCacheEvictionPriority(a[0]);
        const priorityB = this.getDecodedCacheEvictionPriority(b[0]);
        return priorityA - priorityB || a[1].lastUsedFrame - b[1].lastUsedFrame || b[1].bytes - a[1].bytes;
      });

    for (const [key, cached] of evictable) {
      if (this.isDecodedCacheWithinBudget()) {
        break;
      }

      this.decodedCacheBytes -= cached.bytes;
      this.decodedCacheSplats -= cached.chunk.data.numSplats;
      this.decodedCache.delete(key);
      this.cpuEvictedChunks++;
    }
  }

  private isDecodedCacheWithinBudget(): boolean {
    return this.decodedCacheBytes <= this.decodedCacheBudget && this.decodedCacheSplats <= this.decodedCacheSplatLimit;
  }

  private getDecodedCacheEvictionPriority(key: string): number {
    switch (this.getCacheClass(key)) {
      case "inactive":
        return 0;
      case "idle-prefetch":
        return 1;
      case "near-prefetch":
        return 2;
      case "desired":
        return 3;
      case "selected":
        return 4;
      case "fallback":
        return 5;
    }
  }

  private touchDecodedCache(key: string): void {
    const cached = this.decodedCache.get(key);
    if (cached) {
      cached.lastUsedFrame = this.generation;
    }
  }

  private getGpuPageEvictionPriority(key: string): number {
    switch (this.getCacheClass(key)) {
      case "inactive":
        return 0;
      case "idle-prefetch":
        return 1;
      case "near-prefetch":
        return 2;
      case "desired":
        return 3;
      case "selected":
        return 4;
      case "fallback":
        return 5;
    }
  }

  private isGpuChunkProtected(key: string, gpu: GpuResidentChunk): boolean {
    return gpu.active || this.fallbackKeys.has(key) || this.selectedKeys.has(key) || this.desiredKeys.has(key);
  }

  private repackGpuPagePool(): void {
    const residents = Array.from(this.gpuLoaded.entries()).sort((a, b) => {
      const priorityA = this.getGpuPageRepackPriority(a[0]);
      const priorityB = this.getGpuPageRepackPriority(b[0]);
      return priorityA - priorityB || b[1].lastUsedFrame - a[1].lastUsedFrame;
    });

    this.gpuPagePool.clear();
    for (const [key, gpu] of residents) {
      const cached = this.decodedCache.get(key);
      if (!cached) {
        this.gpuLoaded.delete(key);
        gpu.pass.dispose();
        gpu.buffers.dispose();
        continue;
      }
      gpu.pageAllocation = this.gpuPagePool.allocateChunk(key, cached.chunk.data.numSplats);
    }
  }

  private getGpuPageRepackPriority(key: string): number {
    if (this.fallbackKeys.has(key)) {
      return 0;
    }
    if (this.selectedKeys.has(key)) {
      return 1;
    }
    if (this.desiredKeys.has(key)) {
      return 2;
    }
    if (this.prefetchKeys.has(key)) {
      return 3;
    }
    return 4;
  }

  private updateFallbackReasonStats(stableSelected: SelectedSsogItem[], selectedSplats: number): void {
    this.fallbackReasonChildMissing = 0;
    this.fallbackReasonUploadBudgetExceeded = 0;
    this.fallbackReasonGpuPageUnavailable = 0;
    this.fallbackReasonMemoryPressure = 0;
    this.fallbackReasonBudgetThrottled = 0;

    const evictionReasonCutoff = this.generation - FALLBACK_EVICTION_REASON_TTL_FRAMES;
    for (const [key, frame] of this.recentlyEvictedKeyFrames) {
      if (frame < evictionReasonCutoff) {
        this.recentlyEvictedKeyFrames.delete(key);
      }
    }

    for (const nodeId of this.coarseFallbackNodeIds) {
      const desiredItem = this.stableSelectedByNode.get(nodeId);
      if (!desiredItem || this.gpuLoaded.has(desiredItem.key)) {
        continue;
      }

      const desiredKey = desiredItem.key;
      if (this.decodedUploadQueue.has(desiredKey)) {
        this.fallbackReasonUploadBudgetExceeded++;
      } else if (this.recentlyEvictedKeyFrames.has(desiredKey)) {
        this.fallbackReasonMemoryPressure++;
      } else if (this.decodedCache.has(desiredKey)) {
        this.fallbackReasonGpuPageUnavailable++;
      } else {
        this.fallbackReasonChildMissing++;
      }
    }

    const budgetBound =
      Number.isFinite(this.splatBudget) && selectedSplats >= Math.max(1, this.splatBudget * this.lodUnderfillLimit);
    if (!budgetBound) {
      return;
    }

    for (const item of stableSelected) {
      const finestLod = this.finestLodByNode.get(item.nodeId);
      if (finestLod !== undefined && item.lod > finestLod) {
        this.fallbackReasonBudgetThrottled++;
      }
    }
  }

  private getCoarsestEntryForNode(nodeId: number): SsogChunkEntry | undefined {
    return this.entries
      .filter((entry) => entry.nodeId === nodeId)
      .sort((a, b) => b.lod - a.lod || a.count - b.count)[0];
  }

  private getBestResidentEntryForNode(nodeId: number, targetLod: number): SsogChunkEntry | undefined {
    const loadedEntries = Array.from(this.gpuLoaded.keys())
      .map((key) => this.decodedCache.get(key)?.entry)
      .filter((entry): entry is SsogChunkEntry => !!entry && entry.nodeId === nodeId);
    if (loadedEntries.length === 0) {
      return undefined;
    }

    return loadedEntries.sort((a, b) => {
      const aCoarser = a.lod >= targetLod ? 0 : 1;
      const bCoarser = b.lod >= targetLod ? 0 : 1;
      return aCoarser - bCoarser || a.lod - b.lod || a.count - b.count;
    })[0];
  }

  private resolveResidentSelection(selected: SelectedSsogItem[]): SelectedSsogItem[] {
    const fallbackNodes = new Set<number>();
    const resident = selected.map((item): SelectedSsogItem => {
      if (this.gpuLoaded.has(item.key)) {
        return item;
      }

      const fallback = this.getBestResidentEntryForNode(item.nodeId, item.lod);
      if (!fallback) {
        return item;
      }

      fallbackNodes.add(item.nodeId);
      return {
        ...item,
        value: fallback,
        key: chunkKey(fallback),
        lod: fallback.lod,
        count: fallback.count,
      };
    });

    this.pendingReplacementNodes = Math.max(this.pendingReplacementNodes, fallbackNodes.size);
    return resident;
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
      if (!previous || !previousKey || previousKey === item.key || !this.gpuLoaded.has(previousKey)) {
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

      if (!this.gpuLoaded.has(item.key)) {
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

    this.gpuLoaded.forEach((gpu, key) => {
      const cached = this.decodedCache.get(key);
      if (!cached) {
        return;
      }
      gpu.pass.setTransparentSortDepth(
        this.getChunkViewDepth(cached.entry, cameraPosition, cameraForward),
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

  private canRebuildGlobalRuntime(hasRuntime: boolean, force = false): boolean {
    if (force || !hasRuntime || this.globalRuntimeRebuildIntervalFrames <= 0) {
      return true;
    }

    const framesSinceRebuild = this.generation - this.lastGlobalRuntimeRebuildFrame;
    if (framesSinceRebuild >= this.globalRuntimeRebuildIntervalFrames) {
      return true;
    }

    this.globalSortBuildPending = true;
    return false;
  }

  private markGlobalRuntimeRebuilt(): void {
    this.lastGlobalRuntimeRebuildFrame = this.generation;
  }

  private updatePackedGlobalRuntime(): void {
    if (this.globalSortMode !== "packed") {
      this.disposePackedGlobalRuntime();
      return;
    }

    const activeEntries = Array.from(this.gpuLoaded.entries()).filter(([, gpu]) => gpu.active);
    activeEntries.forEach(([, gpu]) => gpu.pass.setEnabled(false));

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

    const signature = activeEntries.map(([key]) => key).sort().join("|");
    if (this.packedGlobalRuntime?.signature === signature) {
      this.packedGlobalRuntime.setEnabled(true);
      this.disposeExpandedRuntime();
      this.disposeMergedRuntimes();
      this.globalSortFallbackReason = "";
      this.lastGlobalSortBuildMs = 0;
      return;
    }

    if (!this.canRebuildGlobalRuntime(!!this.packedGlobalRuntime)) {
      return;
    }

    const buildStart = performance.now();
    this.disposeMergedRuntimes();
    this.disposePackedGlobalRuntime();
    this.disposeExpandedRuntime();
    const camera = this.scene.activeCamera;
    const cameraPosition = camera?.globalPosition ?? new Vector3(0, 0, 0);
    const cameraForward = camera?.getDirection(Vector3.Forward()) ?? Vector3.Forward();
    const depthSortedEntries = activeEntries
      .map(([key]): [string, CachedDecodedChunk | undefined] => [key, this.decodedCache.get(key)])
      .filter((entry): entry is [string, CachedDecodedChunk] => !!entry[1])
      .sort(
        (a, b) =>
          this.getChunkViewDepth(b[1].entry, cameraPosition, cameraForward) -
          this.getChunkViewDepth(a[1].entry, cameraPosition, cameraForward),
      );
    this.packedGlobalRuntime = new SsogGlobalPackedRenderPass(
      this.scene,
      depthSortedEntries.map(([key, cached]) => ({ key, data: cached.chunk.data })),
      { cameraPosition, cameraForward },
    );
    this.packedGlobalRuntime.setVizMode(this.activeVizMode);
    this.packedGlobalRuntime.setEnabled(true);
    this.globalSortFallbackReason = "";
    this.lastGlobalSortBuildMs = performance.now() - buildStart;
    this.markGlobalRuntimeRebuilt();
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
    const activeEntries = Array.from(this.gpuLoaded.entries()).filter(([, gpu]) => gpu.active);
    activeEntries.forEach(([, gpu]) => gpu.pass.setEnabled(false));

    if (!this.canBuildGlobalRuntime(activeEntries)) {
      this.globalSortBuildPending = true;
      return;
    }
    this.globalSortBuildPending = false;

    if (activeEntries.length === 0) {
      this.disposeExpandedRuntime();
      return;
    }

    const signature = activeEntries.map(([key]) => key).sort().join("|");
    if (this.expandedRuntime?.signature === signature) {
      this.expandedRuntime.pass.setEnabled(true);
      this.lastGlobalSortBuildMs = 0;
      return;
    }

    if (!this.canRebuildGlobalRuntime(!!this.expandedRuntime, force)) {
      return;
    }

    const buildStart = performance.now();
    this.disposeExpandedRuntime();
    const activeDecoded = activeEntries
      .map(([key]): [string, CachedDecodedChunk] | undefined => {
        const cached = this.decodedCache.get(key);
        return cached ? [key, cached] : undefined;
      })
      .filter((e): e is [string, CachedDecodedChunk] => !!e);
    const packed = expandSogChunks(activeDecoded.map(([, cached]) => cached.chunk.data));
    const buffers = new SplatBuffers(this.scene.getEngine(), packed);
    const pass = new SplatRenderPass(this.scene, buffers, { renderBudget: packed.indices.length });
    pass.setVizMode(this.activeVizMode);
    pass.setEnabled(true);
    this.expandedRuntime = { signature, buffers, pass };
    this.lastGlobalSortBuildMs = performance.now() - buildStart;
    this.markGlobalRuntimeRebuilt();
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

    const actives = Array.from(this.gpuLoaded.entries()).filter(([, gpu]) => gpu.active);
    if (actives.length === 0) {
      this.disposeMergedRuntimes();
      return;
    }

    const groups = new Map<string, Array<[string, GpuResidentChunk]>>();
    actives.forEach(([key, gpu]) => {
      const cached = this.decodedCache.get(key);
      if (!cached) return;
      const groupKey = String(cached.entry.fileIndex);
      const group = groups.get(groupKey) ?? [];
      group.push([key, gpu]);
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

      const chunkData = group
        .map(([key]) => this.decodedCache.get(key)?.chunk.data)
        .filter((d): d is SogPackedData => !!d);
      if (chunkData.length !== group.length) {
        this.disposeMergedRuntime(groupKey);
        continue;
      }

      const merged = this.mergePackedChunks(chunkData);
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

    actives.forEach(([key, gpu]) => gpu.pass.setEnabled(!mergedKeys.has(key)));
  }

  private canBuildGlobalRuntime(activeEntries: Array<[string, GpuResidentChunk]>): boolean {
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
    const chunks = Array.from(this.gpuLoaded.keys())
      .filter((key) => this.gpuLoaded.get(key)?.active)
      .map((key) => this.decodedCache.get(key)?.chunk.data)
      .filter((d): d is SogPackedData => !!d);

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

  private isChunkRepresentedByReadyRenderPath(key: string): boolean {
    const gpu = this.gpuLoaded.get(key);
    if (!gpu?.active) {
      return false;
    }

    if (this.packedGlobalRuntime) {
      return this.packedGlobalRuntime.signature.split("|").includes(key);
    }
    if (this.expandedRuntime) {
      return this.expandedRuntime.signature.split("|").includes(key);
    }
    for (const merged of this.mergedRuntimes.values()) {
      if (merged.keys.has(key)) {
        return true;
      }
    }
    return this.globalSortMode === "off";
  }

  private hasReadyRenderedNode(nodeId: number): boolean {
    for (const [key] of this.gpuLoaded) {
      const cached = this.decodedCache.get(key);
      if (cached && cached.entry.nodeId === nodeId && this.isChunkRepresentedByReadyRenderPath(key)) {
        return true;
      }
    }
    return false;
  }

  private disposeDebugChunkBoundsForReadyRenderedNodes(): void {
    if (!this.debugChunkBoundsVisible) {
      return;
    }

    for (const key of Array.from(this.entriesByKey.keys())) {
      if (this.debugBounds.has(key) && this.hasReadyRenderedNode(this.entriesByKey.get(key)!.nodeId)) {
        this.debugBounds.dispose(key);
      }
    }
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
