import { Constants } from "@babylonjs/core/Engines/constants";
import { StorageBuffer } from "@babylonjs/core/Buffers/storageBuffer";
import { Vector2, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { Scene } from "@babylonjs/core/scene";

import type { SogBuffers } from "../splat/SogBuffers";
import { SogLodManager } from "../splat/SogLodManager";
import { ColorSegmentationPass } from "./ColorSegmentationPass";
import { ComputeTileDensityOverlayPass } from "./ComputeTileDensityOverlayPass";
import { ComputeTileDepthRangePass, type ComputeTileDepthRangeStats } from "./ComputeTileDepthRangePass";
import { ComputeTileOrderPass, type ComputeTileOrderStats } from "./ComputeTileOrderPass";
import { ComputeTilePreviewPass } from "./ComputeTilePreviewPass";
import { ComputeTileSplatPreviewPass, type ComputeTileSplatPreviewStats } from "./ComputeTileSplatPreviewPass";
import { ComputeTileStatsPass, type ComputeTileStats } from "./ComputeTileStatsPass";
import { ComputeTileWorkQueuePass, type ComputeTileWorkQueueStats } from "./ComputeTileWorkQueuePass";
import { canCreateComputeShader, GpuDepthKeyPass, type GpuDepthKeyStats } from "./GpuDepthKeyPass";
import { GpuRadixSortPass, type GpuRadixSortStats } from "./GpuRadixSortPass";
import { GpuSortHistogramPass, type GpuSortHistogramStats } from "./GpuSortHistogramPass";
import { GpuSortPrefixSumPass, type GpuSortPrefixSumStats } from "./GpuSortPrefixSumPass";
import { GpuSortScatterPass, type GpuSortScatterStats } from "./GpuSortScatterPass";
import {
  getGpuSortMode,
  getGpuSortVisibleMode,
  getGpuSortIntervalFrames,
  getSortForwardDotThreshold,
  getSortIntervalFrames,
  getSortMode,
  getSortMoveEpsilonSq,
  resolveRendererBackend,
  type EffectiveRendererMode,
  type RequestedRendererMode,
  type RendererBackend,
  type GpuSortMode,
  type GpuSortVisibleMode,
  type SortMode,
} from "./renderControls";
import { getQualitySplatBudget } from "./qualityProfiles";
import PackedSogRenderPass_WGSL_VERTEX_SOURCE_raw from "./shaders/packed-sog-render-pass.wgsl-vertex-source.wgsl?raw";
import PackedSogRenderPass_WGSL_FRAGMENT_SOURCE_raw from "./shaders/packed-sog-render-pass.wgsl-fragment-source.wgsl?raw";

const SPLATS_PER_INSTANCE = 128;
const LOD_REBUILD_INTERVAL_FRAMES = 30;
const LOD_CAMERA_POSITION_EPSILON = 0.08;
const MIN_PIXEL_RADIUS = 2.0;
const MAX_PIXEL_RADIUS = 96;
const ALPHA_CLIP = 1 / 255;
const getRenderSplatBudget = (sourceSplats: number): number => {
  const params = new URLSearchParams(window.location.search);
  if (params.get("sogQualityBudget") !== "true") {
    return sourceSplats;
  }
  return getQualitySplatBudget(sourceSplats);
};

const getPositiveNumberParam = (name: string, fallback: number): number => {
  const value = Number(new URLSearchParams(window.location.search).get(name));
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const getComputeTileUpdateInterval = (): number => {
  const params = new URLSearchParams(window.location.search);
  const explicit = Number(params.get("computeTileUpdateInterval"));
  if (Number.isFinite(explicit) && explicit > 0) {
    return Math.max(1, Math.floor(explicit));
  }
  if (
    params.get("computeTileSplatPreview") === "true" ||
    params.get("computeTileRasterPreview") === "true" ||
    params.get("computeTilePreview") === "true" ||
    params.get("computeTileDepthOverlay") === "true" ||
    params.get("computeTileDensityRender") === "true"
  ) {
    return 4;
  }
  return 1;
};

const getCpuShIntervalFrames = (): number => {
  const value = Number(new URLSearchParams(window.location.search).get("sogShInterval"));
  return Number.isFinite(value) && value > 0 ? Math.max(1, Math.floor(value)) : 30;
};

const isCpuShEnabled = (): boolean => {
  const value = new URLSearchParams(window.location.search).get("sogSh");
  return value === "cpu" || value === "true";
};

const WGSL_VERTEX_SOURCE = PackedSogRenderPass_WGSL_VERTEX_SOURCE_raw;

const WGSL_FRAGMENT_SOURCE = PackedSogRenderPass_WGSL_FRAGMENT_SOURCE_raw.replaceAll("__WGSL_FRAGMENT_SOURCE_EXPR_0__", String(ALPHA_CLIP.toFixed(10)));

type PackedSogRenderStats = {
  renderSplats: number;
  chunkCount: number;
  activeChunks: number;
  selectedLods: number;
  rendererMode: string;
  rendererRequested: RequestedRendererMode;
  rendererEffective: EffectiveRendererMode;
  rendererFallbackReason: string;
  computeRendererEnabled: boolean;
  computeRendererPhase: string;
  colorMode: "dc" | "sh";
  shNFileCount: number;
  shNCodebookLength: number;
  shBands: number;
  shCoeffCount: number;
  shPaletteCount: number;
  shRenderMode: "dc" | "loaded" | "cpu";
  computeTileStatsEnabled: boolean;
  computeTileStatsDispatched: boolean;
  computeTileSize: number;
  computeTileCount: number;
  computeTileCols: number;
  computeTileRows: number;
  computeOccupiedTiles: number;
  computeMaxTileOccupancy: number;
  computeTileOccupancy?: Uint32Array;
  computeVisibleSplats: number;
  computeBehindSplats: number;
  computeClippedSplats: number;
  computeOverflowSplats: number;
  computeTileOffsetsDispatched: boolean;
  computeTileListScatterDispatched: boolean;
  computeTileListValidated: boolean;
  computeTileListEntries: number;
  computeTileListCapacity: number;
  computeTileOffsetEntries: number;
  computeTileCursorEntries: number;
  computeTileListMismatchedTiles: number;
  lastComputeTileStatsMs: number;
  lastComputeTileOffsetMs: number;
  lastComputeTileListScatterMs: number;
  computeTileDepthEnabled: boolean;
  computeTileDepthDispatched: boolean;
  computeTileDepthTiles: number;
  computeTileDepthMin: number;
  computeTileDepthMax: number;
  computeTileDepthMaxSpan: number;
  computeTileDepthAvgSpan: number;
  computeTileDepthSpans?: Float32Array;
  lastComputeTileDepthMs: number;
  computeTileWorkQueueEnabled: boolean;
  computeTileWorkQueueDispatched: boolean;
  computeTileWorkQueueOrderMode: "compact" | "depth-band";
  computeTileWorkQueueDepthBands: number;
  computeTileWorkQueueStableOrder: boolean;
  computeTileWorkQueueMaxSplatsPerItemConfig: number;
  computeTileWorkQueueBudget: number;
  computeTileWorkQueueBudgetCap: number;
  computeTileWorkQueueCoverageTarget: number;
  computeTileWorkQueueExplicitBudget: boolean;
  computeTileWorkQueueTiles: number;
  computeTileWorkQueueSplats: number;
  computeTileWorkQueueMaxTileSplats: number;
  computeTileWorkQueueAvgTileSplats: number;
  computeTileWorkQueueOverflowTiles: number;
  lastComputeTileWorkQueueMs: number;
  computeTileOrderEnabled: boolean;
  computeTileOrderDispatched: boolean;
  computeTileOrderBuckets: number;
  computeTileOrderSplats: number;
  lastComputeTileOrderMs: number;
  computeTileSplatPreviewEnabled: boolean;
  computeTileSplatPreviewSamplesPerTile: number;
  computeTileSplatPreviewSplats: number;
  computeTileSplatPreviewActiveTiles: number;
  computeTileSplatPreviewWorkTiles: number;
  computeTileSplatPreviewColorMode: "asset" | "debug" | "opacity" | "depth";
  computeTileSplatPreviewShapeMode: "gaussian" | "marker";
  computeTileRasterPreviewEnabled: boolean;
  computeTileRasterPreviewSamplesPerTile: number;
  computeTileRasterPreviewSplats: number;
  computeTileRasterPreviewWindowSplats: number;
  computeTileRasterPreviewSampledCoverage: number;
  computeTileRasterPreviewWindowCoverage: number;
  computeTileRasterPreviewActiveTiles: number;
  computeTileRasterPreviewWorkTiles: number;
  computeTileRasterPreviewDrawLimit: number;
  computeTileRasterPreviewRequestedDrawLimit: number;
  computeTileRasterPreviewStaticDrawLimit: number;
  computeTileRasterPreviewMotionDrawLimit: number;
  computeTileRasterPreviewAdaptiveScale: number;
  computeTileRasterPreviewFrameMs: number;
  computeTileRasterPreviewMaxMarkerPixels: number;
  computeTileRasterPreviewStaticRamp: number;
  computeTileRasterPreviewColorMode: "asset" | "debug" | "opacity" | "depth";
  computeTileRasterPreviewShapeMode: "gaussian" | "marker";
  computeTileRasterPreviewDrawOrder: "coverage" | "far" | "near";
  computeTileRasterPreviewWindowMode: "sampled" | "full";
  computeTileRasterPreviewCoverageMode: "sampled" | "full";
  computeTileRasterPreviewTruncatedSplats: number;
  computeTileRasterPreviewNearWindowMargin: number;
  computeTileRasterPreviewSampleAlphaCompensation: number;
  computeTileRasterPreviewRuntimeSampleAlphaCompensation: number;
  computeTileRasterPreviewSamplePasses: number;
  computeTileRasterPreviewMaxUsefulSamplePasses: number;
  computeTileRasterPreviewStaticSamplePasses: number;
  computeTileRasterPreviewMotionSamplePasses: number;
  computeTileRasterPreviewSampleCoverageTarget: number;
  computeTileRasterPreviewMotionSampleCoverageTarget: number;
  computeTileRasterPreviewRuntimeSampleCoverageTarget: number;
  computeTileRasterPreviewSamplePassesAdaptive: boolean;
  computeTileRasterPreviewDrawCoverageTarget: number;
  computeTileRasterPreviewMotionDrawCoverageTarget: number;
  computeTileRasterPreviewRuntimeDrawCoverageTarget: number;
  computeTileRasterPreviewDrawCoverageAdaptive: boolean;
  computeTileUpdateInterval: number;
  sortMode: SortMode;
  sortPending: boolean;
  lastSortMs: number;
  lastUploadMs: number;
  lastLodBuildMs: number;
  gpuDepthKeyEnabled: boolean;
  gpuDepthKeyDispatched: boolean;
  lastGpuDepthKeyMs: number;
  lastGpuDepthKeySplats: number;
  gpuSortHistogramEnabled: boolean;
  gpuSortHistogramDispatched: boolean;
  lastGpuSortHistogramMs: number;
  lastGpuSortHistogramSplats: number;
  gpuSortHistogramBuckets: number;
  gpuSortPrefixSumEnabled: boolean;
  gpuSortPrefixSumDispatched: boolean;
  lastGpuSortPrefixSumMs: number;
  gpuSortPrefixSumBuckets: number;
  gpuSortMode: GpuSortMode;
  gpuSortScatterEnabled: boolean;
  gpuSortScatterDispatched: boolean;
  lastGpuSortScatterMs: number;
  lastGpuSortScatterSplats: number;
  gpuRadixSortEnabled: boolean;
  gpuRadixSortDispatched: boolean;
  lastGpuRadixSortMs: number;
  lastGpuRadixSortSplats: number;
  gpuRadixSortBits: number;
  gpuRadixSortPasses: number;
  gpuSortVisibleMode: GpuSortVisibleMode;
  gpuSortVisibleEffective: "cpu" | "radix" | "coarse";
  gpuRadixValidationEnabled: boolean;
  gpuRadixValidationPending: boolean;
  gpuRadixValidationSamples: number;
  gpuRadixAscendingViolations: number;
  gpuRadixDescendingViolations: number;
  gpuRadixOutOfRangeIndices: number;
  gpuRadixDuplicateAdjacentIndices: number;
  gpuRadixChecksumValid: boolean;
  gpuRadixValidatedIndexCount: number;
  gpuBufferArenaBuffers: number;
  gpuBufferArenaBytes: number;
  gpuBufferArenaPeakBytes: number;
  gpuBufferArenaAllocations: number;
  gpuBufferArenaReuses: number;
  gpuBufferArenaGrows: number;
  bindGroupGeneration: number;
};

class PackedSogRenderPass {
  private readonly mesh: Mesh;
  private readonly material: ShaderMaterial;
  private readonly renderBudget: number;
  private readonly lodRangeMin = getPositiveNumberParam("lodRangeMin", 0.0005);
  private readonly lodRangeMax = getPositiveNumberParam("lodRangeMax", 0.15);
  private readonly lodUnderfillLimit = getPositiveNumberParam("lodUnderfillLimit", 0.85);
  private readonly rendererBackend: RendererBackend;
  private readonly gpuDepthKeyPass?: GpuDepthKeyPass;
  private readonly gpuSortHistogramPass?: GpuSortHistogramPass;
  private readonly gpuSortPrefixSumPass?: GpuSortPrefixSumPass;
  private readonly gpuSortScatterPass?: GpuSortScatterPass;
  private readonly gpuRadixSortPass?: GpuRadixSortPass;
  private readonly computeTileStatsPass?: ComputeTileStatsPass;
  private readonly computeTileDepthRangePass?: ComputeTileDepthRangePass;
  private readonly computeTileWorkQueuePass?: ComputeTileWorkQueuePass;
  private readonly computeTileOrderPass?: ComputeTileOrderPass;
  private readonly computeTilePreviewPass?: ComputeTilePreviewPass;
  private readonly computeTileSplatPreviewPass?: ComputeTileSplatPreviewPass;
  private readonly computeTileRasterPreviewPass?: ComputeTileSplatPreviewPass;
  private readonly computeTileDensityOverlayPass?: ComputeTileDensityOverlayPass;
  private readonly colorSegmentationPass?: ColorSegmentationPass;
  private readonly gpuSortMode = getGpuSortMode();
  private readonly gpuSortVisibleMode = getGpuSortVisibleMode();
  private readonly cpuShEnabled = isCpuShEnabled();
  private readonly cpuShIntervalFrames = getCpuShIntervalFrames();
  private readonly sortMode = getSortMode();
  private readonly sortIntervalFrames = getSortIntervalFrames();
  private readonly gpuSortIntervalFrames = getGpuSortIntervalFrames();
  private readonly computeTileUpdateInterval = getComputeTileUpdateInterval();
  private readonly sortMoveEpsilonSq = getSortMoveEpsilonSq();
  private readonly sortForwardDotThreshold = getSortForwardDotThreshold();
  private readonly viewport = new Vector2(1, 1);
  private lastViewportWidth = 0;
  private lastViewportHeight = 0;
  private readonly updateViewport: () => void;
  private readonly lodManager: SogLodManager;
  private sortWorker?: Worker;
  private sortPending = false;
  private enabled = true;
  private sortFrame = 0;
  private gpuSortFrame = 0;
  private computeTileFrame = 0;
  private cpuShFrame = 0;
  private lodFrame = 0;
  private disposed = false;
  private lastCameraPosition = new Vector3(Number.POSITIVE_INFINITY, 0, 0);
  private lastCameraForward = new Vector3(0, 0, 0);
  private lastLodCameraPosition = new Vector3(Number.POSITIVE_INFINITY, 0, 0);
  private renderSplats = 0;
  private activeChunks = 0;
  private selectedLods = 0;
  private lastSortStart = 0;
  private lastSortMs = 0;
  private lastUploadMs = 0;
  private lastLodBuildMs = 0;
  private lastCpuShMs = 0;
  private lastTransparentSortIndex: number | undefined;
  private radixVisibleActive = false;

  constructor(scene: Scene, private readonly sogBuffers: SogBuffers) {
    if (!sogBuffers.storage || !scene.getEngine().isWebGPU) {
      throw new Error("Packed SOG rendering requires Babylon WebGPU storage buffers.");
    }

    this.mesh = new Mesh("PackedSogRenderPassQuads", scene);
    this.rendererBackend = resolveRendererBackend(scene);
    this.mesh.isPickable = false;
    this.mesh.hasVertexAlpha = true;
    this.mesh.material = this.material = this.createMaterial(scene);
    this.lodManager = new SogLodManager(sogBuffers.packed.centers);
    this.renderBudget = getRenderSplatBudget(sogBuffers.packed.numSplats);
    this.gpuDepthKeyPass = this.createGpuDepthKeyPass(scene);
    this.gpuSortHistogramPass = this.createGpuSortHistogramPass(scene);
    this.gpuSortPrefixSumPass = this.createGpuSortPrefixSumPass(scene);
    this.gpuSortScatterPass = this.createGpuSortScatterPass(scene);
    this.gpuRadixSortPass = this.createGpuRadixSortPass(scene);
    this.computeTileStatsPass = this.createComputeTileStatsPass(scene);
    this.computeTileDepthRangePass = this.createComputeTileDepthRangePass(scene);
    this.computeTileWorkQueuePass = this.createComputeTileWorkQueuePass(scene);
    this.computeTileOrderPass = this.createComputeTileOrderPass(scene);
    this.computeTilePreviewPass = this.createComputeTilePreviewPass(scene);
    this.computeTileSplatPreviewPass = this.createComputeTileSplatPreviewPass(scene);
    this.computeTileRasterPreviewPass = this.createComputeTileRasterPreviewPass(scene);
    this.computeTileDensityOverlayPass = this.createComputeTileDensityOverlayPass(scene);
    this.colorSegmentationPass = this.createColorSegmentationPass(scene);

    this.buildGeometry();
    this.bindStorageBuffers();
    this.initializeRenderSet();

    this.updateViewport = () => {
      const engine = scene.getEngine();
      const w = engine.getRenderWidth(true);
      const h = engine.getRenderHeight(true);
      if (w !== this.lastViewportWidth || h !== this.lastViewportHeight) {
        this.viewport.set(w, h);
        this.material.setVector2("viewport", this.viewport);
        this.lastViewportWidth = w;
        this.lastViewportHeight = h;
      }
      this.updateComputeTilePipeline(scene);
      this.computeTilePreviewPass?.update();
      this.computeTileSplatPreviewPass?.update(this.viewport.x, this.viewport.y);
      this.computeTileRasterPreviewPass?.update(this.viewport.x, this.viewport.y);
      this.computeTileDensityOverlayPass?.update();
      this.updateSort(scene);
    };
    scene.registerBeforeRender(this.updateViewport);
    this.updateViewport();
  }

  setSplatStateBuffer(buffer: StorageBuffer): void {
    this.sogBuffers.bufferVersions.rebindStorageBuffer(this.material, "splatStateBuffer", buffer);
  }

  dispose(): void {
    this.disposed = true;
    this.sortWorker?.terminate();
    this.gpuDepthKeyPass?.dispose();
    this.gpuSortHistogramPass?.dispose();
    this.gpuSortPrefixSumPass?.dispose();
    this.gpuSortScatterPass?.dispose();
    this.gpuRadixSortPass?.dispose();
    this.computeTileStatsPass?.dispose();
    this.computeTileDepthRangePass?.dispose();
    this.computeTileWorkQueuePass?.dispose();
		this.computeTileOrderPass?.dispose();
		this.computeTilePreviewPass?.dispose();
		this.computeTileSplatPreviewPass?.dispose();
		this.computeTileRasterPreviewPass?.dispose();
		this.computeTileDensityOverlayPass?.dispose();
		this.colorSegmentationPass?.dispose();
		this.mesh.getScene().unregisterBeforeRender(this.updateViewport);
		this.mesh.dispose();
		this.material.dispose();
	}

	private createColorSegmentationPass(scene: Scene): ColorSegmentationPass | undefined {
		if (!canCreateComputeShader(scene)) {
			return undefined;
		}
		const storage = this.sogBuffers.storage;
		if (!storage) {
			return undefined;
		}
		const pass = new ColorSegmentationPass(scene, storage.color, this.sogBuffers.packed.numSplats);
		pass.dispatch();
		return pass;
	}

	setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.mesh.setEnabled(enabled);
  }

  setTransparentSortDepth(depth: number, scale = 64, hysteresis = 2): void {
    const nextIndex = Number.isFinite(depth) ? Math.round(-depth * scale) : 0;
    const previousIndex = this.lastTransparentSortIndex;
    if (previousIndex !== undefined && Math.abs(nextIndex - previousIndex) < hysteresis) {
      return;
    }

    this.lastTransparentSortIndex = nextIndex;
    this.mesh.alphaIndex = nextIndex;
  }

  private lastVizMode = 0;

  setVizMode(mode: number): void {
    if (this.lastVizMode === mode) {
      return;
    }
    this.lastVizMode = mode;
    this.material.setFloat("vizMode", mode);
  }

  getStats(): PackedSogRenderStats {
    return {
      renderSplats: this.renderSplats,
      chunkCount: this.lodManager.chunks.length,
      activeChunks: this.activeChunks,
      selectedLods: this.selectedLods,
      rendererMode: `packed-sog-raster-${this.rendererBackend.effective}-sort-${this.sortMode}`,
      rendererRequested: this.rendererBackend.requested,
      rendererEffective: this.rendererBackend.effective,
      rendererFallbackReason: this.rendererBackend.fallbackReason,
      computeRendererEnabled: this.rendererBackend.effective === "compute",
      computeRendererPhase:
        this.rendererBackend.effective === "compute"
          ? this.computeTileRasterPreviewPass
            ? this.computeTileOrderPass
              ? "tile-raster-preview-depth-bucket"
              : "tile-raster-preview"
            : "scaffold-raster-output"
          : "disabled",
      colorMode: this.sogBuffers.stats.shMode,
      shNFileCount: this.sogBuffers.stats.shNFileCount,
      shNCodebookLength: this.sogBuffers.stats.shNCodebookLength,
      shBands: this.sogBuffers.stats.shBands,
      shCoeffCount: this.sogBuffers.stats.shCoeffCount,
      shPaletteCount: this.sogBuffers.stats.shPaletteCount,
      shRenderMode: this.sogBuffers.stats.shRenderMode,
      ...this.getComputeTileStats(),
      ...this.getComputeTileSplatPreviewStats(),
      ...this.getComputeTileRasterPreviewStats(),
      computeTileUpdateInterval: this.computeTileUpdateInterval,
      sortMode: this.sortMode,
      sortPending: this.sortPending,
      lastSortMs: this.lastSortMs,
      lastUploadMs: this.lastUploadMs,
      lastLodBuildMs: this.lastLodBuildMs,
      ...this.getGpuDepthKeyStats(),
      ...this.getGpuSortHistogramStats(),
      ...this.getGpuSortPrefixSumStats(),
      ...this.getGpuSortScatterStats(),
      ...this.getGpuRadixSortStats(),
      gpuSortVisibleMode: this.gpuSortVisibleMode,
      gpuSortVisibleEffective: this.getGpuSortVisibleEffective(),
      bindGroupGeneration: this.sogBuffers.bufferVersions.bindGroupGeneration,
    };
  }

  private getGpuSortVisibleEffective(): "cpu" | "radix" | "coarse" {
    if (this.gpuSortMode === "coarse" && this.gpuSortVisibleMode === "coarse") {
      return "coarse";
    }
    if (this.gpuSortMode === "active" && (this.gpuSortVisibleMode === "radix" || this.radixVisibleActive)) {
      return "radix";
    }
    return "cpu";
  }

  private createGpuDepthKeyPass(scene: Scene): GpuDepthKeyPass | undefined {
    const storage = this.sogBuffers.storage;
    if (
      !storage ||
      !canCreateComputeShader(scene) ||
      this.gpuSortMode === "off" ||
      (this.rendererBackend.effective !== "gpu" && this.rendererBackend.effective !== "compute")
    ) {
      return undefined;
    }

    return new GpuDepthKeyPass(
      scene,
      storage.centers,
      storage.depthKeys,
      this.sogBuffers.packed.numSplats,
      this.sogBuffers.packed.boundsMin,
      this.sogBuffers.packed.boundsMax,
    );
  }

  private createComputeTileStatsPass(scene: Scene): ComputeTileStatsPass | undefined {
    const storage = this.sogBuffers.storage;
    if (!storage || this.rendererBackend.effective !== "compute" || !ComputeTileStatsPass.isSupported(scene)) {
      return undefined;
    }
    return new ComputeTileStatsPass(scene, storage.centers, this.sogBuffers.packed.numSplats);
  }

  private createComputeTileDensityOverlayPass(scene: Scene): ComputeTileDensityOverlayPass | undefined {
    if (!this.computeTileStatsPass || !ComputeTileDensityOverlayPass.isEnabled()) {
      return undefined;
    }
    return new ComputeTileDensityOverlayPass(scene, this.computeTileStatsPass);
  }

  private createComputeTileDepthRangePass(scene: Scene): ComputeTileDepthRangePass | undefined {
    const storage = this.sogBuffers.storage;
    if (
      !storage ||
      !this.computeTileStatsPass ||
      this.rendererBackend.effective !== "compute" ||
      !ComputeTileDepthRangePass.isEnabled() ||
      !ComputeTileDepthRangePass.isSupported(scene)
    ) {
      return undefined;
    }
    return new ComputeTileDepthRangePass(
      scene,
      storage.centers,
      this.computeTileStatsPass,
      this.sogBuffers.packed.numSplats,
    );
  }

  private createComputeTileWorkQueuePass(scene: Scene): ComputeTileWorkQueuePass | undefined {
    if (
      !this.computeTileStatsPass ||
      !this.computeTileDepthRangePass ||
      this.rendererBackend.effective !== "compute" ||
      !ComputeTileWorkQueuePass.isEnabled() ||
      !ComputeTileWorkQueuePass.isSupported(scene)
    ) {
      return undefined;
    }
    return new ComputeTileWorkQueuePass(scene, this.computeTileStatsPass, this.computeTileDepthRangePass);
  }

  private createComputeTileOrderPass(scene: Scene): ComputeTileOrderPass | undefined {
    const storage = this.sogBuffers.storage;
    if (
      !storage ||
      !this.computeTileStatsPass ||
      this.rendererBackend.effective !== "compute" ||
      !ComputeTileOrderPass.isEnabled() ||
      !ComputeTileOrderPass.isSupported(scene)
    ) {
      return undefined;
    }
    return new ComputeTileOrderPass(
      scene,
      storage.centers,
      this.computeTileStatsPass,
      this.sogBuffers.packed.numSplats,
    );
  }

  private createComputeTilePreviewPass(scene: Scene): ComputeTilePreviewPass | undefined {
    if (!this.computeTileStatsPass || !this.computeTileWorkQueuePass || !ComputeTilePreviewPass.isEnabled()) {
      return undefined;
    }
    return new ComputeTilePreviewPass(scene, this.computeTileStatsPass, this.computeTileWorkQueuePass);
  }

  private createComputeTileSplatPreviewPass(scene: Scene): ComputeTileSplatPreviewPass | undefined {
    const storage = this.sogBuffers.storage;
    if (
      !storage ||
      !this.computeTileStatsPass ||
      !this.computeTileWorkQueuePass ||
      !ComputeTileSplatPreviewPass.isEnabled()
    ) {
      return undefined;
    }
    return new ComputeTileSplatPreviewPass(
      scene,
      {
        centerBuffer: storage.centers,
        sogQuatBuffer: storage.quats,
        colorBuffer: storage.color,
        sogScalesBuffer: storage.scales,
        sogScaleCodebookBuffer: storage.scaleCodebook,
        splatRadiusScale: 2.0,
      },
      this.computeTileStatsPass,
      this.computeTileWorkQueuePass,
    );
  }

  private createComputeTileRasterPreviewPass(scene: Scene): ComputeTileSplatPreviewPass | undefined {
    const storage = this.sogBuffers.storage;
    if (
      !storage ||
      !this.computeTileStatsPass ||
      !this.computeTileWorkQueuePass ||
      new URLSearchParams(window.location.search).get("computeTileRasterPreview") !== "true"
    ) {
      return undefined;
    }
    return new ComputeTileSplatPreviewPass(
      scene,
      {
        centerBuffer: storage.centers,
        tileSplatListBuffer: this.computeTileOrderPass?.getOrderedTileSplatListBuffer(),
        sogQuatBuffer: storage.quats,
        colorBuffer: storage.color,
        sogScalesBuffer: storage.scales,
        sogScaleCodebookBuffer: storage.scaleCodebook,
        splatRadiusScale: 2.0,
        coverageMode: "bounded",
        shapeMode:
          new URLSearchParams(window.location.search).get("computeTileRasterShape") === "gaussian"
            ? "gaussian"
            : "marker",
        alphaMode: "splat",
        maxMarkerPixels: 96.0,
      },
      this.computeTileStatsPass,
      this.computeTileWorkQueuePass,
    );
  }

  private updateComputeTileStats(scene: Scene): void {
    const camera = scene.activeCamera;
    if (!camera || !this.computeTileStatsPass) {
      return;
    }
    this.computeTileStatsPass.dispatch(
      scene.getTransformMatrix(),
      this.viewport.x,
      this.viewport.y,
      this.renderSplats,
    );
  }

  private updateComputeTileDepthRange(scene: Scene): void {
    const camera = scene.activeCamera;
    if (!camera || !this.computeTileDepthRangePass) {
      return;
    }
    this.computeTileDepthRangePass.dispatch(scene.getTransformMatrix(), this.renderSplats);
  }

  private updateComputeTileWorkQueue(): void {
    this.computeTileWorkQueuePass?.dispatch();
  }

  private updateComputeTilePipeline(scene: Scene): void {
    if (!this.computeTileStatsPass) {
      return;
    }
    const shouldUpdate = this.computeTileFrame === 0;
    this.computeTileFrame = (this.computeTileFrame + 1) % this.computeTileUpdateInterval;
    if (!shouldUpdate) {
      return;
    }
    this.updateComputeTileStats(scene);
    this.updateComputeTileDepthRange(scene);
    this.updateComputeTileWorkQueue();
    this.updateComputeTileOrder(scene);
  }

  private updateComputeTileOrder(scene: Scene): void {
    const camera = scene.activeCamera;
    const depthStats = this.computeTileDepthRangePass?.getStats();
    if (!camera || !this.computeTileOrderPass) {
      return;
    }
    this.computeTileOrderPass.dispatch(
      scene.getTransformMatrix(),
      this.viewport.x,
      this.viewport.y,
      this.renderSplats,
      depthStats?.minDepth ?? 0,
      depthStats?.maxDepth ?? 1,
    );
  }

  private getComputeTileStats(): Pick<
    PackedSogRenderStats,
    | "computeTileStatsEnabled"
    | "computeTileStatsDispatched"
    | "computeTileSize"
    | "computeTileCount"
    | "computeTileCols"
    | "computeTileRows"
    | "computeOccupiedTiles"
    | "computeMaxTileOccupancy"
    | "computeTileOccupancy"
    | "computeVisibleSplats"
    | "computeBehindSplats"
    | "computeClippedSplats"
    | "computeOverflowSplats"
    | "computeTileOffsetsDispatched"
    | "computeTileListScatterDispatched"
    | "computeTileListValidated"
    | "computeTileListEntries"
    | "computeTileListCapacity"
    | "computeTileOffsetEntries"
    | "computeTileCursorEntries"
    | "computeTileListMismatchedTiles"
    | "lastComputeTileStatsMs"
    | "lastComputeTileOffsetMs"
    | "lastComputeTileListScatterMs"
    | "computeTileDepthEnabled"
    | "computeTileDepthDispatched"
    | "computeTileDepthTiles"
    | "computeTileDepthMin"
    | "computeTileDepthMax"
    | "computeTileDepthMaxSpan"
    | "computeTileDepthAvgSpan"
    | "computeTileDepthSpans"
    | "lastComputeTileDepthMs"
    | "computeTileWorkQueueEnabled"
    | "computeTileWorkQueueDispatched"
    | "computeTileWorkQueueOrderMode"
    | "computeTileWorkQueueDepthBands"
    | "computeTileWorkQueueStableOrder"
    | "computeTileWorkQueueMaxSplatsPerItemConfig"
    | "computeTileWorkQueueBudget"
    | "computeTileWorkQueueBudgetCap"
    | "computeTileWorkQueueCoverageTarget"
    | "computeTileWorkQueueExplicitBudget"
    | "computeTileWorkQueueTiles"
    | "computeTileWorkQueueSplats"
    | "computeTileWorkQueueMaxTileSplats"
    | "computeTileWorkQueueAvgTileSplats"
      | "computeTileWorkQueueOverflowTiles"
      | "lastComputeTileWorkQueueMs"
      | "computeTileOrderEnabled"
      | "computeTileOrderDispatched"
      | "computeTileOrderBuckets"
      | "computeTileOrderSplats"
      | "lastComputeTileOrderMs"
    > {
    const stats: ComputeTileStats | undefined = this.computeTileStatsPass?.getStats();
    const depthStats: ComputeTileDepthRangeStats | undefined = this.computeTileDepthRangePass?.getStats();
      const workQueueStats: ComputeTileWorkQueueStats | undefined = this.computeTileWorkQueuePass?.getStats();
      const orderStats: ComputeTileOrderStats | undefined = this.computeTileOrderPass?.getStats();
    return {
      computeTileStatsEnabled: stats?.enabled ?? false,
      computeTileStatsDispatched: stats?.dispatched ?? false,
      computeTileSize: stats?.tileSize ?? 0,
      computeTileCount: stats?.tileCount ?? 0,
      computeTileCols: stats?.tileCols ?? 0,
      computeTileRows: stats?.tileRows ?? 0,
      computeOccupiedTiles: stats?.occupiedTiles ?? 0,
      computeMaxTileOccupancy: stats?.maxTileOccupancy ?? 0,
      computeTileOccupancy: stats?.tileOccupancy,
      computeVisibleSplats: stats?.visibleSplats ?? 0,
      computeBehindSplats: stats?.behindSplats ?? 0,
      computeClippedSplats: stats?.clippedSplats ?? 0,
      computeOverflowSplats: stats?.overflowSplats ?? 0,
      computeTileOffsetsDispatched: stats?.tileOffsetsDispatched ?? false,
      computeTileListScatterDispatched: stats?.tileListScatterDispatched ?? false,
      computeTileListValidated: stats?.tileListValidated ?? false,
      computeTileListEntries: stats?.tileListEntries ?? 0,
      computeTileListCapacity: stats?.tileListCapacity ?? 0,
      computeTileOffsetEntries: stats?.tileOffsetEntries ?? 0,
      computeTileCursorEntries: stats?.tileCursorEntries ?? 0,
      computeTileListMismatchedTiles: stats?.tileListMismatchedTiles ?? 0,
      lastComputeTileStatsMs: stats?.lastDispatchMs ?? 0,
      lastComputeTileOffsetMs: stats?.lastTileOffsetMs ?? 0,
      lastComputeTileListScatterMs: stats?.lastTileListScatterMs ?? 0,
      computeTileDepthEnabled: depthStats?.enabled ?? false,
      computeTileDepthDispatched: depthStats?.dispatched ?? false,
      computeTileDepthTiles: depthStats?.depthTiles ?? 0,
      computeTileDepthMin: depthStats?.minDepth ?? 0,
      computeTileDepthMax: depthStats?.maxDepth ?? 0,
      computeTileDepthMaxSpan: depthStats?.maxDepthSpan ?? 0,
      computeTileDepthAvgSpan: depthStats?.avgDepthSpan ?? 0,
      computeTileDepthSpans: depthStats?.depthSpans,
      lastComputeTileDepthMs: depthStats?.lastDispatchMs ?? 0,
      computeTileWorkQueueEnabled: workQueueStats?.enabled ?? false,
      computeTileWorkQueueDispatched: workQueueStats?.dispatched ?? false,
      computeTileWorkQueueOrderMode: workQueueStats?.orderMode ?? "compact",
      computeTileWorkQueueDepthBands: workQueueStats?.depthBandCount ?? 0,
      computeTileWorkQueueStableOrder: workQueueStats?.stableOrder ?? false,
      computeTileWorkQueueMaxSplatsPerItemConfig: workQueueStats?.maxSplatsPerWorkItem ?? 0,
      computeTileWorkQueueBudget: workQueueStats?.workItemBudget ?? 0,
      computeTileWorkQueueBudgetCap: workQueueStats?.workItemBudgetCap ?? 0,
      computeTileWorkQueueCoverageTarget: workQueueStats?.coverageTarget ?? 1,
      computeTileWorkQueueExplicitBudget: workQueueStats?.explicitWorkItemBudget ?? false,
      computeTileWorkQueueTiles: workQueueStats?.workTiles ?? 0,
      computeTileWorkQueueSplats: workQueueStats?.queuedSplats ?? 0,
      computeTileWorkQueueMaxTileSplats: workQueueStats?.maxTileSplats ?? 0,
      computeTileWorkQueueAvgTileSplats: workQueueStats?.avgTileSplats ?? 0,
        computeTileWorkQueueOverflowTiles: workQueueStats?.overflowTiles ?? 0,
        lastComputeTileWorkQueueMs: workQueueStats?.lastDispatchMs ?? 0,
        computeTileOrderEnabled: orderStats?.enabled ?? false,
        computeTileOrderDispatched: orderStats?.dispatched ?? false,
        computeTileOrderBuckets: orderStats?.bucketCount ?? 0,
        computeTileOrderSplats: orderStats?.orderedSplats ?? 0,
        lastComputeTileOrderMs: orderStats?.lastDispatchMs ?? 0,
      };
    }

  private getComputeTileSplatPreviewStats(): Pick<
    PackedSogRenderStats,
    | "computeTileSplatPreviewEnabled"
    | "computeTileSplatPreviewSamplesPerTile"
    | "computeTileSplatPreviewSplats"
    | "computeTileSplatPreviewActiveTiles"
    | "computeTileSplatPreviewWorkTiles"
    | "computeTileSplatPreviewColorMode"
    | "computeTileSplatPreviewShapeMode"
  > {
    const stats: ComputeTileSplatPreviewStats | undefined = this.computeTileSplatPreviewPass?.getStats();
    return {
      computeTileSplatPreviewEnabled: stats?.enabled ?? false,
      computeTileSplatPreviewSamplesPerTile: stats?.samplesPerTile ?? 0,
      computeTileSplatPreviewSplats: stats?.previewSplats ?? 0,
      computeTileSplatPreviewActiveTiles: stats?.activeTiles ?? 0,
      computeTileSplatPreviewWorkTiles: stats?.workTiles ?? 0,
      computeTileSplatPreviewColorMode: stats?.colorMode ?? "debug",
      computeTileSplatPreviewShapeMode: stats?.shapeMode ?? "marker",
    };
  }

  private getComputeTileRasterPreviewStats(): Pick<
    PackedSogRenderStats,
    | "computeTileRasterPreviewEnabled"
    | "computeTileRasterPreviewSamplesPerTile"
    | "computeTileRasterPreviewSplats"
    | "computeTileRasterPreviewWindowSplats"
    | "computeTileRasterPreviewSampledCoverage"
    | "computeTileRasterPreviewWindowCoverage"
    | "computeTileRasterPreviewActiveTiles"
    | "computeTileRasterPreviewWorkTiles"
    | "computeTileRasterPreviewDrawLimit"
    | "computeTileRasterPreviewRequestedDrawLimit"
    | "computeTileRasterPreviewStaticDrawLimit"
    | "computeTileRasterPreviewMotionDrawLimit"
    | "computeTileRasterPreviewAdaptiveScale"
    | "computeTileRasterPreviewFrameMs"
    | "computeTileRasterPreviewMaxMarkerPixels"
    | "computeTileRasterPreviewStaticRamp"
    | "computeTileRasterPreviewColorMode"
    | "computeTileRasterPreviewShapeMode"
    | "computeTileRasterPreviewDrawOrder"
    | "computeTileRasterPreviewWindowMode"
    | "computeTileRasterPreviewCoverageMode"
    | "computeTileRasterPreviewTruncatedSplats"
    | "computeTileRasterPreviewNearWindowMargin"
    | "computeTileRasterPreviewSampleAlphaCompensation"
    | "computeTileRasterPreviewRuntimeSampleAlphaCompensation"
    | "computeTileRasterPreviewSamplePasses"
    | "computeTileRasterPreviewMaxUsefulSamplePasses"
    | "computeTileRasterPreviewStaticSamplePasses"
    | "computeTileRasterPreviewMotionSamplePasses"
    | "computeTileRasterPreviewSampleCoverageTarget"
    | "computeTileRasterPreviewMotionSampleCoverageTarget"
    | "computeTileRasterPreviewRuntimeSampleCoverageTarget"
    | "computeTileRasterPreviewSamplePassesAdaptive"
    | "computeTileRasterPreviewDrawCoverageTarget"
    | "computeTileRasterPreviewMotionDrawCoverageTarget"
    | "computeTileRasterPreviewRuntimeDrawCoverageTarget"
    | "computeTileRasterPreviewDrawCoverageAdaptive"
  > {
    const stats: ComputeTileSplatPreviewStats | undefined = this.computeTileRasterPreviewPass?.getStats();
    return {
      computeTileRasterPreviewEnabled: stats?.enabled ?? false,
      computeTileRasterPreviewSamplesPerTile: stats?.samplesPerTile ?? 0,
      computeTileRasterPreviewSplats: stats?.previewSplats ?? 0,
      computeTileRasterPreviewWindowSplats: stats?.windowSplats ?? 0,
      computeTileRasterPreviewSampledCoverage: stats?.sampledCoverage ?? 0,
      computeTileRasterPreviewWindowCoverage: stats?.windowCoverage ?? 0,
      computeTileRasterPreviewActiveTiles: stats?.activeTiles ?? 0,
      computeTileRasterPreviewWorkTiles: stats?.workTiles ?? 0,
      computeTileRasterPreviewDrawLimit: stats?.drawLimit ?? 0,
      computeTileRasterPreviewRequestedDrawLimit: stats?.requestedDrawLimit ?? 0,
      computeTileRasterPreviewStaticDrawLimit: stats?.staticDrawLimit ?? 0,
      computeTileRasterPreviewMotionDrawLimit: stats?.motionDrawLimit ?? 0,
      computeTileRasterPreviewAdaptiveScale: stats?.adaptiveDrawScale ?? 1,
      computeTileRasterPreviewFrameMs: stats?.smoothedFrameMs ?? 0,
      computeTileRasterPreviewMaxMarkerPixels: stats?.maxMarkerPixels ?? 0,
      computeTileRasterPreviewStaticRamp: stats?.staticRamp ?? 1,
      computeTileRasterPreviewColorMode: stats?.colorMode ?? "debug",
      computeTileRasterPreviewShapeMode: stats?.shapeMode ?? "marker",
      computeTileRasterPreviewDrawOrder: stats?.drawOrder ?? "far",
      computeTileRasterPreviewWindowMode: stats?.windowMode ?? "sampled",
      computeTileRasterPreviewCoverageMode: stats?.rasterCoverageMode ?? "sampled",
      computeTileRasterPreviewTruncatedSplats: stats?.truncatedSplats ?? 0,
      computeTileRasterPreviewNearWindowMargin: stats?.nearWindowMargin ?? 0,
      computeTileRasterPreviewSampleAlphaCompensation: stats?.sampleAlphaCompensation ?? 1,
      computeTileRasterPreviewRuntimeSampleAlphaCompensation:
        stats?.runtimeSampleAlphaCompensation ?? 1,
      computeTileRasterPreviewSamplePasses: stats?.samplePasses ?? 1,
      computeTileRasterPreviewMaxUsefulSamplePasses: stats?.maxUsefulSamplePasses ?? 1,
      computeTileRasterPreviewStaticSamplePasses: stats?.staticSamplePasses ?? 1,
      computeTileRasterPreviewMotionSamplePasses: stats?.motionSamplePasses ?? 1,
      computeTileRasterPreviewSampleCoverageTarget: stats?.sampleCoverageTarget ?? 1,
      computeTileRasterPreviewMotionSampleCoverageTarget: stats?.motionSampleCoverageTarget ?? 1,
      computeTileRasterPreviewRuntimeSampleCoverageTarget: stats?.runtimeSampleCoverageTarget ?? 1,
      computeTileRasterPreviewSamplePassesAdaptive: stats?.samplePassesAdaptive ?? false,
      computeTileRasterPreviewDrawCoverageTarget: stats?.drawCoverageTarget ?? 0,
      computeTileRasterPreviewMotionDrawCoverageTarget: stats?.motionDrawCoverageTarget ?? 0,
      computeTileRasterPreviewRuntimeDrawCoverageTarget: stats?.runtimeDrawCoverageTarget ?? 0,
      computeTileRasterPreviewDrawCoverageAdaptive: stats?.drawCoverageAdaptive ?? false,
    };
  }

  private getGpuDepthKeyStats(): Pick<
    PackedSogRenderStats,
    "gpuDepthKeyEnabled" | "gpuDepthKeyDispatched" | "lastGpuDepthKeyMs" | "lastGpuDepthKeySplats"
  > {
    const stats: GpuDepthKeyStats | undefined = this.gpuDepthKeyPass?.getStats();
    return {
      gpuDepthKeyEnabled: stats?.enabled ?? false,
      gpuDepthKeyDispatched: stats?.dispatched ?? false,
      lastGpuDepthKeyMs: stats?.lastDispatchMs ?? 0,
      lastGpuDepthKeySplats: stats?.lastDispatchSplats ?? 0,
    };
  }

  private createGpuSortHistogramPass(scene: Scene): GpuSortHistogramPass | undefined {
    const storage = this.sogBuffers.storage;
    if (
      !storage ||
      !GpuSortHistogramPass.isSupported(scene) ||
      this.gpuSortMode === "off" ||
      this.gpuSortMode === "active" ||
      (this.rendererBackend.effective !== "gpu" && this.rendererBackend.effective !== "compute")
    ) {
      return undefined;
    }

    return new GpuSortHistogramPass(
      scene,
      storage.depthKeys,
      storage.sortBucketCounts,
      this.sogBuffers.packed.numSplats,
    );
  }

  private getGpuSortHistogramStats(): Pick<
    PackedSogRenderStats,
    | "gpuSortHistogramEnabled"
    | "gpuSortHistogramDispatched"
    | "lastGpuSortHistogramMs"
    | "lastGpuSortHistogramSplats"
    | "gpuSortHistogramBuckets"
  > {
    const stats: GpuSortHistogramStats | undefined = this.gpuSortHistogramPass?.getStats();
    return {
      gpuSortHistogramEnabled: stats?.enabled ?? false,
      gpuSortHistogramDispatched: stats?.dispatched ?? false,
      lastGpuSortHistogramMs: stats?.lastDispatchMs ?? 0,
      lastGpuSortHistogramSplats: stats?.lastDispatchSplats ?? 0,
      gpuSortHistogramBuckets: stats?.bucketCount ?? 0,
    };
  }

  private createGpuSortPrefixSumPass(scene: Scene): GpuSortPrefixSumPass | undefined {
    const storage = this.sogBuffers.storage;
    if (
      !storage ||
      !GpuSortPrefixSumPass.isSupported(scene) ||
      this.gpuSortMode === "off" ||
      this.gpuSortMode === "active" ||
      (this.rendererBackend.effective !== "gpu" && this.rendererBackend.effective !== "compute")
    ) {
      return undefined;
    }

    return new GpuSortPrefixSumPass(scene, storage.sortBucketCounts, storage.sortBucketOffsets);
  }

  private getGpuSortPrefixSumStats(): Pick<
    PackedSogRenderStats,
    | "gpuSortPrefixSumEnabled"
    | "gpuSortPrefixSumDispatched"
    | "lastGpuSortPrefixSumMs"
    | "gpuSortPrefixSumBuckets"
  > {
    const stats: GpuSortPrefixSumStats | undefined = this.gpuSortPrefixSumPass?.getStats();
    return {
      gpuSortPrefixSumEnabled: stats?.enabled ?? false,
      gpuSortPrefixSumDispatched: stats?.dispatched ?? false,
      lastGpuSortPrefixSumMs: stats?.lastDispatchMs ?? 0,
      gpuSortPrefixSumBuckets: stats?.bucketCount ?? 0,
    };
  }

  private createGpuSortScatterPass(scene: Scene): GpuSortScatterPass | undefined {
    const storage = this.sogBuffers.storage;
    if (
      !storage ||
      !GpuSortScatterPass.isSupported(scene) ||
      this.gpuSortMode === "off" ||
      this.gpuSortMode === "active" ||
      (this.rendererBackend.effective !== "gpu" && this.rendererBackend.effective !== "compute")
    ) {
      return undefined;
    }

    return new GpuSortScatterPass(
      scene,
      storage.depthKeys,
      storage.sortBucketOffsets,
      this.gpuSortMode === "coarse" ? storage.indices : storage.sortScratchIndices,
      this.sogBuffers.packed.numSplats,
    );
  }

  private getGpuSortScatterStats(): Pick<
    PackedSogRenderStats,
    | "gpuSortMode"
    | "gpuSortScatterEnabled"
    | "gpuSortScatterDispatched"
    | "lastGpuSortScatterMs"
    | "lastGpuSortScatterSplats"
  > {
    const stats: GpuSortScatterStats | undefined = this.gpuSortScatterPass?.getStats();
    return {
      gpuSortMode: this.gpuSortMode,
      gpuSortScatterEnabled: stats?.enabled ?? false,
      gpuSortScatterDispatched: stats?.dispatched ?? false,
      lastGpuSortScatterMs: stats?.lastDispatchMs ?? 0,
      lastGpuSortScatterSplats: stats?.lastDispatchSplats ?? 0,
    };
  }

  private canUseGpuSortForDraw(): boolean {
    return (
      ((this.gpuSortMode === "coarse" && this.gpuSortVisibleMode === "coarse" && !!this.gpuSortScatterPass) ||
        (this.gpuSortMode === "active" &&
          (this.gpuSortVisibleMode === "radix" || this.radixVisibleActive) &&
          !!this.gpuRadixSortPass)) &&
      this.renderSplats === this.sogBuffers.packed.numSplats
    );
  }

  private createGpuRadixSortPass(scene: Scene): GpuRadixSortPass | undefined {
    const storage = this.sogBuffers.storage;
    if (
      !storage ||
      !GpuRadixSortPass.isSupported(scene) ||
      this.gpuSortMode !== "active" ||
      (this.rendererBackend.effective !== "gpu" && this.rendererBackend.effective !== "compute")
    ) {
      return undefined;
    }

    return new GpuRadixSortPass(
      scene,
      storage.depthKeys,
      this.gpuSortVisibleMode === "radix" ? storage.indices : storage.sortScratchIndices,
      this.sogBuffers.packed.numSplats,
    );
  }

  private useCpuVisibleSort(): void {
    if (!this.radixVisibleActive) {
      return;
    }
    const storage = this.sogBuffers.storage;
    if (!storage) {
      return;
    }
    this.sogBuffers.bufferVersions.rebindStorageBuffer(this.material, "indexBuffer", storage.indices);
    this.radixVisibleActive = false;
  }

  private updateAutoRadixVisibility(): void {
    if (this.gpuSortVisibleMode !== "auto" || !this.gpuRadixSortPass || this.radixVisibleActive) {
      return;
    }
    if (this.renderSplats !== this.sogBuffers.packed.numSplats) {
      return;
    }
    const stats = this.gpuRadixSortPass.getStats();
    const isValidAscending =
      stats.dispatched &&
      !stats.validationPending &&
      stats.validationSamples > 0 &&
      stats.ascendingViolations === 0 &&
      stats.outOfRangeIndices === 0 &&
      stats.duplicateAdjacentIndices === 0 &&
      stats.checksumValid;
    if (!isValidAscending) {
      return;
    }
    const storage = this.sogBuffers.storage;
    if (!storage) {
      return;
    }
    this.sogBuffers.bufferVersions.rebindStorageBuffer(this.material, "indexBuffer", storage.sortScratchIndices);
    this.radixVisibleActive = true;
  }

  private getGpuRadixSortStats(): Pick<
    PackedSogRenderStats,
    | "gpuRadixSortEnabled"
    | "gpuRadixSortDispatched"
    | "lastGpuRadixSortMs"
    | "lastGpuRadixSortSplats"
    | "gpuRadixSortBits"
    | "gpuRadixSortPasses"
    | "gpuRadixValidationEnabled"
    | "gpuRadixValidationPending"
    | "gpuRadixValidationSamples"
    | "gpuRadixAscendingViolations"
    | "gpuRadixDescendingViolations"
    | "gpuRadixOutOfRangeIndices"
    | "gpuRadixDuplicateAdjacentIndices"
    | "gpuRadixChecksumValid"
    | "gpuRadixValidatedIndexCount"
    | "gpuBufferArenaBuffers"
    | "gpuBufferArenaBytes"
    | "gpuBufferArenaPeakBytes"
    | "gpuBufferArenaAllocations"
    | "gpuBufferArenaReuses"
    | "gpuBufferArenaGrows"
  > {
    const stats: GpuRadixSortStats | undefined = this.gpuRadixSortPass?.getStats();
    return {
      gpuRadixSortEnabled: stats?.enabled ?? false,
      gpuRadixSortDispatched: stats?.dispatched ?? false,
      lastGpuRadixSortMs: stats?.lastDispatchMs ?? 0,
      lastGpuRadixSortSplats: stats?.lastDispatchSplats ?? 0,
      gpuRadixSortBits: stats?.sortBits ?? 0,
      gpuRadixSortPasses: stats?.passes ?? 0,
      gpuRadixValidationEnabled: stats?.validationEnabled ?? false,
      gpuRadixValidationPending: stats?.validationPending ?? false,
      gpuRadixValidationSamples: stats?.validationSamples ?? 0,
      gpuRadixAscendingViolations: stats?.ascendingViolations ?? 0,
      gpuRadixDescendingViolations: stats?.descendingViolations ?? 0,
      gpuRadixOutOfRangeIndices: stats?.outOfRangeIndices ?? 0,
      gpuRadixDuplicateAdjacentIndices: stats?.duplicateAdjacentIndices ?? 0,
      gpuRadixChecksumValid: stats?.checksumValid ?? false,
      gpuRadixValidatedIndexCount: stats?.validatedIndexCount ?? 0,
      gpuBufferArenaBuffers: stats?.gpuBufferArenaBuffers ?? 0,
      gpuBufferArenaBytes: stats?.gpuBufferArenaBytes ?? 0,
      gpuBufferArenaPeakBytes: stats?.gpuBufferArenaPeakBytes ?? 0,
      gpuBufferArenaAllocations: stats?.gpuBufferArenaAllocations ?? 0,
      gpuBufferArenaReuses: stats?.gpuBufferArenaReuses ?? 0,
      gpuBufferArenaGrows: stats?.gpuBufferArenaGrows ?? 0,
    };
  }

  private updateGpuSortStages(cameraPosition: Vector3, cameraForward: Vector3, forceDepth = false): void {
    const depthStats = this.gpuDepthKeyPass?.getStats();
    const histogramStats = this.gpuSortHistogramPass?.getStats();
    const radixStats = this.gpuRadixSortPass?.getStats();
    const sortAlreadyDispatched = this.gpuRadixSortPass ? radixStats?.dispatched : histogramStats?.dispatched;
    if (!this.gpuDepthKeyPass || (!forceDepth && depthStats?.dispatched && sortAlreadyDispatched)) {
      this.updateAutoRadixVisibility();
      return;
    }
    if (forceDepth && depthStats?.dispatched) {
      this.gpuSortFrame = (this.gpuSortFrame + 1) % this.gpuSortIntervalFrames;
      if (this.gpuSortFrame !== 1) {
        this.updateAutoRadixVisibility();
        return;
      }
    }
    if (forceDepth && this.gpuSortVisibleMode === "auto") {
      this.useCpuVisibleSort();
    }

    const depthDispatched = forceDepth || !depthStats?.dispatched
      ? this.gpuDepthKeyPass.dispatch(cameraPosition, cameraForward)
      : true;
    if (depthDispatched && this.gpuSortHistogramPass && (forceDepth || !histogramStats?.dispatched)) {
      const histogramDispatched = this.gpuSortHistogramPass.dispatch();
      if (histogramDispatched) {
        const prefixDispatched = this.gpuSortPrefixSumPass?.dispatch() ?? false;
        if (prefixDispatched) {
          this.gpuSortScatterPass?.dispatch();
        }
      }
    }
    if (depthDispatched && this.gpuRadixSortPass && (forceDepth || !this.gpuRadixSortPass.getStats().dispatched)) {
      this.gpuRadixSortPass.dispatch();
    }
    this.updateAutoRadixVisibility();
  }

  private createMaterial(scene: Scene): ShaderMaterial {
    const material = new ShaderMaterial(
      "PackedSogRenderPassMaterial",
      scene,
      {
        vertexSource: WGSL_VERTEX_SOURCE,
        fragmentSource: WGSL_FRAGMENT_SOURCE,
      },
      {
        attributes: ["position"],
        uniforms: [
          "worldViewProjection",
          "view",
          "world",
          "projection",
          "viewport",
          "minPixelRadius",
          "maxPixelRadius",
          "renderSplatCount",
          "vizMode",
          "meansMin",
          "meansMax",
        ],
        storageBuffers: [
          "meansLBuffer",
          "meansUBuffer",
          "quatsBuffer",
          "scalesBuffer",
          "colorBuffer",
          "colorGroupBuffer",
          "splatStateBuffer",
          "scaleCodebookBuffer",
          "indexBuffer",
        ],
        needAlphaBlending: true,
        shaderLanguage: ShaderLanguage.WGSL,
      },
    );

    material.backFaceCulling = false;
    material.alphaMode = Constants.ALPHA_PREMULTIPLIED;
    material.disableDepthWrite = true;
    material.setFloat("minPixelRadius", MIN_PIXEL_RADIUS);
    material.setFloat("maxPixelRadius", MAX_PIXEL_RADIUS);
    material.setFloat("renderSplatCount", 0);
    material.setFloat("vizMode", 0);
    material.setVector3("meansMin", Vector3.FromArray(this.sogBuffers.packed.meansMins));
    material.setVector3("meansMax", Vector3.FromArray(this.sogBuffers.packed.meansMaxs));
    return material;
  }

  private bindStorageBuffers(): void {
    const storage = this.sogBuffers.storage;
    if (!storage) {
      return;
    }
    this.sogBuffers.bufferVersions.rebindStorageBuffer(this.material, "meansLBuffer", storage.meansL);
    this.sogBuffers.bufferVersions.rebindStorageBuffer(this.material, "meansUBuffer", storage.meansU);
    this.sogBuffers.bufferVersions.rebindStorageBuffer(this.material, "quatsBuffer", storage.quats);
    this.sogBuffers.bufferVersions.rebindStorageBuffer(this.material, "scalesBuffer", storage.scales);
    this.sogBuffers.bufferVersions.rebindStorageBuffer(this.material, "colorBuffer", storage.color);
    if (this.colorSegmentationPass) {
      this.sogBuffers.bufferVersions.rebindStorageBuffer(this.material, "colorGroupBuffer", this.colorSegmentationPass.getColorGroupBuffer());
    }
    this.sogBuffers.bufferVersions.rebindStorageBuffer(this.material, "splatStateBuffer", storage.state);
    this.sogBuffers.bufferVersions.rebindStorageBuffer(this.material, "scaleCodebookBuffer", storage.scaleCodebook);
    this.sogBuffers.bufferVersions.rebindStorageBuffer(this.material, "indexBuffer", storage.indices);
  }

  private buildGeometry(): void {
    const positions = new Float32Array(SPLATS_PER_INSTANCE * 4 * 3);
    const geometryIndices = new Uint32Array(SPLATS_PER_INSTANCE * 6);
    const quadCorners = [-1, -1, 1, -1, 1, 1, -1, 1];

    for (let splat = 0; splat < SPLATS_PER_INSTANCE; splat++) {
      for (let cornerIndex = 0; cornerIndex < 4; cornerIndex++) {
        const positionOffset = (splat * 4 + cornerIndex) * 3;
        positions[positionOffset + 0] = quadCorners[cornerIndex * 2 + 0];
        positions[positionOffset + 1] = quadCorners[cornerIndex * 2 + 1];
        positions[positionOffset + 2] = splat;
      }

      const baseVertex = splat * 4;
      const indexOffset = splat * 6;
      geometryIndices[indexOffset + 0] = baseVertex + 0;
      geometryIndices[indexOffset + 1] = baseVertex + 1;
      geometryIndices[indexOffset + 2] = baseVertex + 2;
      geometryIndices[indexOffset + 3] = baseVertex + 0;
      geometryIndices[indexOffset + 4] = baseVertex + 2;
      geometryIndices[indexOffset + 5] = baseVertex + 3;
    }

    this.mesh.setVerticesData("position", positions, false, 3);
    this.mesh.setIndices(geometryIndices);
    this.mesh.alwaysSelectAsActiveMesh = true;
    this.mesh.doNotSyncBoundingInfo = true;
  }

  private initializeRenderSet(): void {
    const selection = this.lodManager.select({
      budget: this.renderBudget,
      lodRangeMin: this.lodRangeMin,
      lodRangeMax: this.lodRangeMax,
      lodUnderfillLimit: this.lodUnderfillLimit,
    });
    const { centers, indices, activeChunks, selectedLods } = selection;
    this.activeChunks = activeChunks;
    this.selectedLods = selectedLods;
    this.setRenderCount(indices.length);
    if (this.sogBuffers.storage) {
      this.sogBuffers.storage.indices.update(indices, 0, indices.byteLength);
      this.sogBuffers.bufferVersions.bump(this.sogBuffers.storage.indices);
    }
    this.initializeSortWorker(centers, indices);
  }

  private setRenderCount(renderCount: number): void {
    if (this.renderSplats === renderCount) {
      return;
    }
    this.renderSplats = renderCount;
    this.mesh.forcedInstanceCount = Math.ceil(renderCount / SPLATS_PER_INSTANCE);
    this.material.setFloat("renderSplatCount", renderCount);
  }

  private initializeSortWorker(centers: Float32Array, indices: Uint32Array): void {
    if (!this.sortWorker) {
      this.sortWorker = new Worker(new URL("../workers/splatSort.worker.ts", import.meta.url), {
        type: "module",
      });
      this.sortWorker.onmessage = (event: MessageEvent<{ type: "sorted"; indices: ArrayBuffer }>) => {
        if (this.disposed || event.data.type !== "sorted") {
          return;
        }

        this.sortPending = false;
        this.lastSortMs = this.lastSortStart > 0 ? performance.now() - this.lastSortStart : 0;
        const sortedIndices = new Uint32Array(event.data.indices);
        const uploadStart = performance.now();
        if (this.sogBuffers.storage) {
          this.sogBuffers.storage.indices.update(sortedIndices, 0, sortedIndices.byteLength);
          this.sogBuffers.bufferVersions.bump(this.sogBuffers.storage.indices);
        }
        this.lastUploadMs = performance.now() - uploadStart;
      };
    }

    this.sortPending = false;
    this.sortWorker.postMessage({ type: "init", centers: centers.buffer, indices: indices.buffer }, [
      centers.buffer,
      indices.buffer,
    ]);
  }

  private updateSort(scene: Scene): void {
    const gpuSortOwnsDraw = this.canUseGpuSortForDraw();
    if (!this.enabled || (!gpuSortOwnsDraw && !this.sortWorker)) {
      return;
    }

    const camera = scene.activeCamera;
    if (!camera) {
      return;
    }

    const cameraPosition = camera.globalPosition;
    const cameraForward = camera.getDirection(Vector3.Forward());
    this.updateCpuShColors(cameraPosition);
    this.updateLod(cameraPosition);

    const initialSort = !Number.isFinite(this.lastCameraPosition.x);
    const moved = Vector3.DistanceSquared(cameraPosition, this.lastCameraPosition) > this.sortMoveEpsilonSq;
    const turned = Vector3.Dot(cameraForward, this.lastCameraForward) < this.sortForwardDotThreshold;
    const shouldSortView = initialSort || moved || turned;

    if (shouldSortView && this.gpuSortVisibleMode === "auto") {
      this.useCpuVisibleSort();
    }

    if (this.sortPending) {
      return;
    }

    this.updateGpuSortStages(cameraPosition, cameraForward);

    if (this.sortMode === "static" && !initialSort) {
      return;
    }

    if (!shouldSortView && this.sortMode !== "continuous") {
      return;
    }

    this.sortFrame = (this.sortFrame + 1) % this.sortIntervalFrames;
    if (!initialSort && this.sortFrame !== 1) {
      return;
    }

    this.lastCameraPosition.copyFrom(cameraPosition);
    this.lastCameraForward.copyFrom(cameraForward);
    this.updateGpuSortStages(cameraPosition, cameraForward, true);
    if (this.canUseGpuSortForDraw()) {
      this.lastSortMs = 0;
      this.lastUploadMs = 0;
      this.sortPending = false;
      return;
    }

    const sortWorker = this.sortWorker;
    if (!sortWorker) {
      return;
    }
    this.sortPending = true;
    this.lastSortStart = performance.now();
    sortWorker.postMessage({
      type: "sort",
      cameraPosition: [cameraPosition.x, cameraPosition.y, cameraPosition.z],
      cameraForward: [cameraForward.x, cameraForward.y, cameraForward.z],
    });
  }

  private updateCpuShColors(cameraPosition: Vector3): void {
    if (!this.cpuShEnabled || !this.sogBuffers.packed.shN) {
      return;
    }

    this.cpuShFrame = (this.cpuShFrame + 1) % this.cpuShIntervalFrames;
    if (this.cpuShFrame !== 1 && this.lastCpuShMs > 0) {
      return;
    }

    this.lastCpuShMs = this.sogBuffers.updateCpuShColors(cameraPosition);
  }

  private updateLod(cameraPosition: Vector3): void {
    if (this.sogBuffers.packed.numSplats <= this.renderBudget) {
      return;
    }

    this.lodFrame = (this.lodFrame + 1) % LOD_REBUILD_INTERVAL_FRAMES;
    const moved = Vector3.DistanceSquared(cameraPosition, this.lastLodCameraPosition) > LOD_CAMERA_POSITION_EPSILON;
    if (this.lodFrame !== 1 && !moved) {
      return;
    }

    const lodStart = performance.now();
    const { centers, indices, activeChunks, selectedLods } = this.lodManager.select({
      budget: this.renderBudget,
      cameraPosition,
      lodRangeMin: this.lodRangeMin,
      lodRangeMax: this.lodRangeMax,
      lodUnderfillLimit: this.lodUnderfillLimit,
    });
    this.lastLodBuildMs = performance.now() - lodStart;
    this.lastLodCameraPosition.copyFrom(cameraPosition);
    this.activeChunks = activeChunks;
    this.selectedLods = selectedLods;
    this.setRenderCount(indices.length);
    if (this.sogBuffers.storage) {
      this.sogBuffers.storage.indices.update(indices, 0, indices.byteLength);
      this.sogBuffers.bufferVersions.bump(this.sogBuffers.storage.indices);
    }
    this.initializeSortWorker(centers, indices);
  }
}

export { PackedSogRenderPass };
export type { PackedSogRenderStats };
