import type { SplatCloud } from "../splat/SplatCloud";

const formatCount = (value: number): string => value.toLocaleString("en-US");

const formatMs = (value: number): string => (Number.isFinite(value) ? value.toFixed(1) : "0.0");

const formatRange = (min: number, max: number): string => `${min.toFixed(3)} .. ${max.toFixed(3)}`;

const formatVec = (value: readonly [number, number, number]): string =>
  value.map((item) => item.toFixed(2)).join(", ");

class ViewerDebugStats {
  private readonly root: HTMLDivElement;
  private readonly tileOverlay?: HTMLCanvasElement;
  private readonly tileOverlayContext?: CanvasRenderingContext2D;
  private readonly tileOverlayMode: "occupancy" | "depth";
  private splatCloud?: SplatCloud;
  private frameCount = 0;
  private fps = 0;
  private lastFpsTime = performance.now();

  constructor(private readonly mode: string) {
    this.root = document.createElement("div");
    this.root.id = "debug-stats";
    document.body.appendChild(this.root);
    const params = new URLSearchParams(window.location.search);
    this.tileOverlayMode = params.get("computeTileDepthOverlay") === "true" ? "depth" : "occupancy";
    if (params.get("computeTileOverlay") === "true" || params.get("computeTileDepthOverlay") === "true") {
      this.tileOverlay = document.createElement("canvas");
      this.tileOverlay.id = "compute-tile-overlay";
      this.tileOverlayContext = this.tileOverlay.getContext("2d") ?? undefined;
      document.body.appendChild(this.tileOverlay);
    }
    this.render();
  }

  setCloud(splatCloud: SplatCloud): void {
    this.splatCloud = splatCloud;
    this.render();
  }

  update(): void {
    this.frameCount++;
    const now = performance.now();
    const elapsed = now - this.lastFpsTime;
    if (elapsed < 500) {
      return;
    }

    this.fps = (this.frameCount * 1000) / elapsed;
    this.frameCount = 0;
    this.lastFpsTime = now;
    this.render();
  }

  private renderTileOverlay(renderStats: ReturnType<SplatCloud["renderPass"]["getStats"]>): void {
    if (!this.tileOverlay || !this.tileOverlayContext) {
      return;
    }

    const stats = renderStats as typeof renderStats & {
      computeTileOccupancy?: Uint32Array;
      computeTileDepthSpans?: Float32Array;
      computeTileCols?: number;
      computeTileRows?: number;
    };
    const occupancy = stats.computeTileOccupancy;
    const depthSpans = stats.computeTileDepthSpans;
    const cols = stats.computeTileCols ?? 0;
    const rows = stats.computeTileRows ?? 0;
    const useDepth = this.tileOverlayMode === "depth";
    const hasOccupancy = !!occupancy && renderStats.computeMaxTileOccupancy > 0;
    const hasDepth = !!depthSpans && renderStats.computeTileDepthMaxSpan > 0;
    if (cols <= 0 || rows <= 0 || (useDepth ? !hasDepth : !hasOccupancy)) {
      this.tileOverlayContext.clearRect(0, 0, this.tileOverlay.width, this.tileOverlay.height);
      return;
    }

    const width = window.innerWidth;
    const height = window.innerHeight;
    if (this.tileOverlay.width !== width || this.tileOverlay.height !== height) {
      this.tileOverlay.width = width;
      this.tileOverlay.height = height;
    }

    const ctx = this.tileOverlayContext;
    ctx.clearRect(0, 0, width, height);
    const tileWidth = width / cols;
    const tileHeight = height / rows;
    const max = useDepth ? renderStats.computeTileDepthMaxSpan : renderStats.computeMaxTileOccupancy;
    const values = useDepth ? depthSpans : occupancy;

    if (!values) {
      return;
    }

    for (let index = 0; index < values.length; index++) {
      const value = values[index];
      if (value <= 0) {
        continue;
      }
      const x = index % cols;
      const y = Math.floor(index / cols);
      const intensity = Math.min(1, Math.log2(value + 1) / Math.log2(max + 1));
      ctx.fillStyle = useDepth
        ? `rgba(${Math.round(90 + 165 * intensity)}, ${Math.round(80 * (1 - intensity))}, 255, ${0.12 + 0.42 * intensity})`
        : `rgba(${Math.round(255 * intensity)}, ${Math.round(220 * (1 - intensity))}, 40, ${0.1 + 0.38 * intensity})`;
      ctx.fillRect(x * tileWidth, y * tileHeight, Math.ceil(tileWidth), Math.ceil(tileHeight));
    }

    ctx.strokeStyle = "rgba(255,255,255,0.16)";
    ctx.lineWidth = 1;
    for (let x = 0; x <= cols; x++) {
      const px = Math.round(x * tileWidth) + 0.5;
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, height);
      ctx.stroke();
    }
    for (let y = 0; y <= rows; y++) {
      const py = Math.round(y * tileHeight) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, py);
      ctx.lineTo(width, py);
      ctx.stroke();
    }
  }

  private render(): void {
    const splatCloud = this.splatCloud;
    if (!splatCloud) {
      this.root.textContent = [`Mode: ${this.mode}`, `FPS: ${this.fps.toFixed(1)}`, "Waiting for splats"].join("\n");
      return;
    }

    const bufferStats = splatCloud.bufferStats;
    if (!bufferStats) {
      return;
    }
    const renderStats = splatCloud.renderPass.getStats();
    this.renderTileOverlay(renderStats);
    const streamingStats = renderStats as typeof renderStats & {
      loadedChunks?: number;
      pendingChunks?: number;
      queuedChunks?: number;
      prefetchedChunks?: number;
      evictedChunks?: number;
      cacheSplats?: number;
      qualityPreset?: string;
      cacheChunkPressure?: number;
      cacheSplatPressure?: number;
      selectedCacheRatio?: number;
      selectedNodes?: number;
      selectedSplats?: number;
      requestedChunks?: number;
      requestedSplats?: number;
      cacheChunkLimit?: number;
      cacheSplatLimit?: number;
      maxPendingLoads?: number;
      prefetchMultiplier?: number;
      chunkSortMode?: string;
      chunkSortScale?: number;
      chunkSortHysteresis?: number;
      globalSortRequested?: string;
      globalSortEffective?: string;
      globalSortFallbackReason?: string;
      globalSortBuildPending?: boolean;
      packedMetadataMode?: string;
      packedMetadataGroups?: number;
      packedMergeCompatible?: boolean;
      lastGlobalSortBuildMs?: number;
      lastChunkLoadMs?: number;
      lodTransitionCount?: number;
      pendingReplacementNodes?: number;
      finestSelectedNodes?: number;
      coarseFallbackNodes?: number;
    };
    const previewLimiterStats = renderStats as typeof renderStats & {
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
      computeRendererVisibility?: string;
      computeTileOrderTiles?: number;
      computeTileOrderTrackedTiles?: number;
      computeTileOrderTruncatedSplats?: number;
      computeTileOrderOverflowSplats?: number;
      computeTileOrderOverflowTiles?: number;
    };
    const assetStats = splatCloud.asset.stats;
    const lines = [
      `Mode: ${this.mode}`,
      `FPS: ${this.fps.toFixed(1)}`,
      `Asset: ${splatCloud.asset.kind} / ${assetStats.runtimeMode}`,
      `Renderer: ${renderStats.rendererMode}`,
      `Renderer requested: ${renderStats.rendererRequested}`,
      `Renderer effective: ${renderStats.rendererEffective}`,
      renderStats.rendererFallbackReason ? `Renderer fallback: ${renderStats.rendererFallbackReason}` : "",
      renderStats.computeRendererEnabled
        ? `Compute renderer: ${renderStats.computeRendererPhase}${previewLimiterStats.computeRendererVisibility ? ` / ${previewLimiterStats.computeRendererVisibility}` : ""}`
        : "",
      `Color mode: ${renderStats.colorMode}${renderStats.shNFileCount > 0 ? ` / shN files ${formatCount(renderStats.shNFileCount)} / codebook ${formatCount(renderStats.shNCodebookLength)} / bands ${formatCount(renderStats.shBands)} / coeffs ${formatCount(renderStats.shCoeffCount)} / palette ${formatCount(renderStats.shPaletteCount)}` : ""}`,
      renderStats.shRenderMode === "cpu"
        ? "SH render: CPU baked"
        : renderStats.shRenderMode === "loaded"
          ? "SH render: loaded / DC fallback"
          : "",
      renderStats.computeTileStatsEnabled
        ? `Compute tiles: ${renderStats.computeTileStatsDispatched ? "yes" : "pending"} / ${formatCount(renderStats.computeOccupiedTiles)} of ${formatCount(renderStats.computeTileCount)}`
        : "",
      renderStats.computeTileStatsEnabled
        ? `Compute tile max: ${formatCount(renderStats.computeMaxTileOccupancy)} @ ${formatCount(renderStats.computeTileSize)}px`
        : "",
      renderStats.computeTileStatsEnabled
        ? `Compute visible: ${formatCount(renderStats.computeVisibleSplats)} / clipped ${formatCount(renderStats.computeClippedSplats)} / behind ${formatCount(renderStats.computeBehindSplats)}`
        : "",
      renderStats.computeTileStatsEnabled
        ? `Compute offsets: ${renderStats.computeTileOffsetsDispatched ? "yes" : "pending"} / entries ${formatCount(renderStats.computeTileListEntries)}`
        : "",
      renderStats.computeTileStatsEnabled
        ? `Compute scatter: ${renderStats.computeTileListScatterDispatched ? "yes" : "pending"} / capacity ${formatCount(renderStats.computeTileListCapacity)}`
        : "",
      renderStats.computeTileStatsEnabled
        ? `Compute list valid: ${renderStats.computeTileListValidated ? "yes" : "pending"} / offsets ${formatCount(renderStats.computeTileOffsetEntries)} / cursors ${formatCount(renderStats.computeTileCursorEntries)}`
        : "",
      renderStats.computeTileStatsEnabled && renderStats.computeTileListMismatchedTiles > 0
        ? `Compute list mismatches: ${formatCount(renderStats.computeTileListMismatchedTiles)}`
        : "",
      renderStats.computeTileStatsEnabled
        ? `Compute binning: ${formatMs(renderStats.lastComputeTileStatsMs)} ms / offsets ${formatMs(renderStats.lastComputeTileOffsetMs)} ms / scatter ${formatMs(renderStats.lastComputeTileListScatterMs)} ms`
        : "",
      renderStats.computeTileStatsEnabled
        ? `Compute update interval: ${formatCount(renderStats.computeTileUpdateInterval)} frame${renderStats.computeTileUpdateInterval === 1 ? "" : "s"}`
        : "",
      renderStats.computeTileDepthEnabled
        ? `Compute depth: ${renderStats.computeTileDepthDispatched ? "yes" : "pending"} / tiles ${formatCount(renderStats.computeTileDepthTiles)} / ${formatMs(renderStats.lastComputeTileDepthMs)} ms`
        : "",
      renderStats.computeTileDepthEnabled
        ? `Compute depth range: ${formatRange(
            Number.isFinite(renderStats.computeTileDepthMin) ? renderStats.computeTileDepthMin : 0,
            renderStats.computeTileDepthMax,
          )} / span max ${renderStats.computeTileDepthMaxSpan.toFixed(3)} / avg ${renderStats.computeTileDepthAvgSpan.toFixed(3)}`
        : "",
      renderStats.computeTileWorkQueueEnabled
        ? `Compute work queue: ${renderStats.computeTileWorkQueueDispatched ? "yes" : "pending"} / items ${formatCount(renderStats.computeTileWorkQueueTiles)} / ${formatMs(renderStats.lastComputeTileWorkQueueMs)} ms`
        : "",
      renderStats.computeTileWorkQueueEnabled
        ? `Compute work config: ${renderStats.computeTileWorkQueueOrderMode}${renderStats.computeTileWorkQueueStableOrder ? " stable" : ""} / bands ${formatCount(renderStats.computeTileWorkQueueDepthBands)} / target ${((renderStats.computeTileWorkQueueCoverageTarget ?? 1) * 100).toFixed(0)}% / budget ${formatCount(renderStats.computeTileWorkQueueBudget)}${renderStats.computeTileWorkQueueExplicitBudget ? " fixed" : ` cap ${formatCount(renderStats.computeTileWorkQueueBudgetCap)}`} / batch ${formatCount(renderStats.computeTileWorkQueueMaxSplatsPerItemConfig)}`
        : "",
      renderStats.computeTileWorkQueueEnabled
        ? `Compute work splats: ${formatCount(renderStats.computeTileWorkQueueSplats)} / max item ${formatCount(renderStats.computeTileWorkQueueMaxTileSplats)} / avg ${renderStats.computeTileWorkQueueAvgTileSplats.toFixed(1)}`
        : "",
      renderStats.computeTileWorkQueueEnabled && renderStats.computeTileWorkQueueOverflowTiles > 0
        ? `Compute work overflow: ${formatCount(renderStats.computeTileWorkQueueOverflowTiles)}`
        : "",
      renderStats.computeTileOrderEnabled
        ? `Compute tile order: ${renderStats.computeTileOrderDispatched ? "yes" : "pending"} / buckets ${formatCount(renderStats.computeTileOrderBuckets)} / tiles ${formatCount(previewLimiterStats.computeTileOrderTrackedTiles ?? 0)} of ${formatCount(previewLimiterStats.computeTileOrderTiles ?? 0)} / splats ${formatCount(renderStats.computeTileOrderSplats)}${(previewLimiterStats.computeTileOrderTruncatedSplats ?? 0) > 0 ? ` / truncated ${formatCount(previewLimiterStats.computeTileOrderTruncatedSplats ?? 0)}` : ""}${(previewLimiterStats.computeTileOrderOverflowSplats ?? 0) > 0 ? ` / overflow ${formatCount(previewLimiterStats.computeTileOrderOverflowSplats ?? 0)}` : ""}${(previewLimiterStats.computeTileOrderOverflowTiles ?? 0) > 0 ? ` / tile overflow ${formatCount(previewLimiterStats.computeTileOrderOverflowTiles ?? 0)}` : ""} / ${formatMs(renderStats.lastComputeTileOrderMs)} ms`
        : "",
      renderStats.computeTileSplatPreviewEnabled
        ? `Compute splat preview: ${formatCount(renderStats.computeTileSplatPreviewSplats)} / items ${formatCount(renderStats.computeTileSplatPreviewActiveTiles)} / ${formatCount(renderStats.computeTileSplatPreviewWorkTiles)} / samples ${formatCount(renderStats.computeTileSplatPreviewSamplesPerTile)} / ${renderStats.computeTileSplatPreviewColorMode} / ${renderStats.computeTileSplatPreviewShapeMode}`
        : "",
      renderStats.computeTileRasterPreviewEnabled
        ? `Compute raster preview: ${formatCount(renderStats.computeTileRasterPreviewSplats)} / window ${formatCount(previewLimiterStats.computeTileRasterPreviewWindowSplats ?? 0)} / items ${formatCount(renderStats.computeTileRasterPreviewActiveTiles)} / ${formatCount(renderStats.computeTileRasterPreviewWorkTiles)} / coverage ${((renderStats.computeTileRasterPreviewSplats / Math.max(1, renderStats.computeTileWorkQueueSplats)) * 100).toFixed(1)}% / window ${((previewLimiterStats.computeTileRasterPreviewWindowCoverage ?? 0) * 100).toFixed(1)}% / ${previewLimiterStats.computeTileRasterPreviewCoverageMode ?? "sampled"} ${((previewLimiterStats.computeTileRasterPreviewSampledCoverage ?? 0) * 100).toFixed(1)}%${(previewLimiterStats.computeTileRasterPreviewTruncatedSplats ?? 0) > 0 ? ` / truncated ${formatCount(previewLimiterStats.computeTileRasterPreviewTruncatedSplats ?? 0)}` : ""} / samples ${formatCount(renderStats.computeTileRasterPreviewSamplesPerTile)} / ${renderStats.computeTileRasterPreviewColorMode} / ${renderStats.computeTileRasterPreviewShapeMode}`
        : "",
      renderStats.computeTileRasterPreviewEnabled && previewLimiterStats.computeTileRasterPreviewDrawLimit !== undefined
        ? `Compute raster limit: draw ${formatCount(previewLimiterStats.computeTileRasterPreviewDrawLimit ?? 0)}${previewLimiterStats.computeTileRasterPreviewDrawCoverageAdaptive ? ` req ${formatCount(previewLimiterStats.computeTileRasterPreviewRequestedDrawLimit ?? 0)} target ${((previewLimiterStats.computeTileRasterPreviewRuntimeDrawCoverageTarget ?? 0) * 100).toFixed(0)}% (${((previewLimiterStats.computeTileRasterPreviewDrawCoverageTarget ?? 0) * 100).toFixed(0)}/${((previewLimiterStats.computeTileRasterPreviewMotionDrawCoverageTarget ?? 0) * 100).toFixed(0)})` : ""} / order ${previewLimiterStats.computeTileRasterPreviewDrawOrder ?? "far"} / window ${previewLimiterStats.computeTileRasterPreviewWindowMode ?? "sampled"} +${((previewLimiterStats.computeTileRasterPreviewNearWindowMargin ?? 0) * 100).toFixed(0)}% / passes ${formatCount(previewLimiterStats.computeTileRasterPreviewSamplePasses ?? 1)} max ${formatCount(previewLimiterStats.computeTileRasterPreviewMaxUsefulSamplePasses ?? 1)} (${formatCount(previewLimiterStats.computeTileRasterPreviewStaticSamplePasses ?? 1)}/${formatCount(previewLimiterStats.computeTileRasterPreviewMotionSamplePasses ?? 1)}${previewLimiterStats.computeTileRasterPreviewSamplePassesAdaptive ? ` target ${((previewLimiterStats.computeTileRasterPreviewRuntimeSampleCoverageTarget ?? 1) * 100).toFixed(0)}% (${((previewLimiterStats.computeTileRasterPreviewSampleCoverageTarget ?? 1) * 100).toFixed(0)}/${((previewLimiterStats.computeTileRasterPreviewMotionSampleCoverageTarget ?? 1) * 100).toFixed(0)})` : ""}) / alpha x${(previewLimiterStats.computeTileRasterPreviewRuntimeSampleAlphaCompensation ?? 1).toFixed(1)} max ${(previewLimiterStats.computeTileRasterPreviewSampleAlphaCompensation ?? 1).toFixed(1)} / static ${formatCount(previewLimiterStats.computeTileRasterPreviewStaticDrawLimit ?? 0)} / motion ${formatCount(previewLimiterStats.computeTileRasterPreviewMotionDrawLimit ?? 0)} / ramp ${((previewLimiterStats.computeTileRasterPreviewStaticRamp ?? 1) * 100).toFixed(0)}% / adaptive ${((previewLimiterStats.computeTileRasterPreviewAdaptiveScale ?? 1) * 100).toFixed(0)}% / frame ${formatMs(previewLimiterStats.computeTileRasterPreviewFrameMs ?? 0)} ms / max ${formatCount(previewLimiterStats.computeTileRasterPreviewMaxMarkerPixels ?? 0)}px`
        : "",
      `Source splats: ${formatCount(bufferStats.numSplats)}`,
      `Rendered splats: ${formatCount(renderStats.renderSplats)}`,
      `Chunks: ${formatCount(renderStats.activeChunks)} / ${formatCount(renderStats.chunkCount)}`,
      streamingStats.selectedNodes !== undefined
        ? `Selected nodes: ${formatCount(streamingStats.selectedNodes)} / splats ${formatCount(streamingStats.selectedSplats ?? 0)}`
        : "",
      streamingStats.requestedChunks !== undefined
        ? `Requested chunks: ${formatCount(streamingStats.requestedChunks)} / splats ${formatCount(streamingStats.requestedSplats ?? 0)}`
        : "",
      streamingStats.loadedChunks !== undefined
        ? `Loaded chunks: ${formatCount(streamingStats.loadedChunks)}`
        : "",
      streamingStats.pendingChunks !== undefined
        ? `Pending chunks: ${formatCount(streamingStats.pendingChunks)}`
        : "",
      streamingStats.queuedChunks !== undefined
        ? `Queued chunks: ${formatCount(streamingStats.queuedChunks)}`
        : "",
      streamingStats.prefetchedChunks !== undefined
        ? `Prefetched chunks: ${formatCount(streamingStats.prefetchedChunks)}`
        : "",
      streamingStats.evictedChunks !== undefined
        ? `Evicted chunks: ${formatCount(streamingStats.evictedChunks)}`
        : "",
      streamingStats.cacheSplats !== undefined
        ? `Cache splats: ${formatCount(streamingStats.cacheSplats)}`
        : "",
      streamingStats.qualityPreset !== undefined ? `SSOG preset: ${streamingStats.qualityPreset}` : "",
      streamingStats.cacheChunkLimit !== undefined
        ? `SSOG cache: ${streamingStats.cacheChunkLimit < 0 ? "all" : formatCount(streamingStats.cacheChunkLimit)} chunks / ${formatCount(streamingStats.cacheSplatLimit ?? 0)} splats`
        : "",
      streamingStats.cacheChunkPressure !== undefined
        ? `SSOG cache pressure: chunks ${(streamingStats.cacheChunkPressure * 100).toFixed(0)}% / splats ${((streamingStats.cacheSplatPressure ?? 0) * 100).toFixed(0)}% / selected ${(streamingStats.selectedCacheRatio ?? 0).toFixed(2)}x`
        : "",
      streamingStats.maxPendingLoads !== undefined
        ? `SSOG loading: max pending ${formatCount(streamingStats.maxPendingLoads)} / prefetch ${streamingStats.prefetchMultiplier?.toFixed(2) ?? "0.00"}x`
        : "",
      streamingStats.chunkSortMode !== undefined
        ? `SSOG chunk sort: ${streamingStats.chunkSortMode} / scale ${formatCount(streamingStats.chunkSortScale ?? 0)} / hysteresis ${formatCount(streamingStats.chunkSortHysteresis ?? 0)}`
        : "",
      streamingStats.globalSortRequested !== undefined
        ? `SSOG global sort: ${streamingStats.globalSortRequested} -> ${streamingStats.globalSortEffective ?? "pending"}`
        : "",
      streamingStats.globalSortRequested !== undefined
        ? `SSOG global build: ${streamingStats.globalSortBuildPending ? "pending chunks" : formatMs(streamingStats.lastGlobalSortBuildMs ?? 0) + " ms"}`
        : "",
      streamingStats.packedMetadataMode !== undefined
        ? `SSOG packed metadata: ${streamingStats.packedMetadataMode} / groups ${formatCount(streamingStats.packedMetadataGroups ?? 0)} / merge ${streamingStats.packedMergeCompatible ? "yes" : "no"}`
        : "",
      streamingStats.lastChunkLoadMs !== undefined
        ? `SSOG chunk load: ${formatMs(streamingStats.lastChunkLoadMs)} ms`
        : "",
      streamingStats.lodTransitionCount !== undefined
        ? `SSOG LOD transitions: ${formatCount(streamingStats.lodTransitionCount)} / pending ${formatCount(streamingStats.pendingReplacementNodes ?? 0)}`
        : "",
      streamingStats.finestSelectedNodes !== undefined
        ? `SSOG LOD nodes: finest ${formatCount(streamingStats.finestSelectedNodes)} / coarse fallback ${formatCount(streamingStats.coarseFallbackNodes ?? 0)}`
        : "",
      streamingStats.globalSortFallbackReason ? `SSOG global fallback: ${streamingStats.globalSortFallbackReason}` : "",
      `LOD levels: ${formatCount(renderStats.selectedLods)}`,
      renderStats.gpuDepthKeyEnabled
        ? `GPU keys: ${renderStats.gpuDepthKeyDispatched ? "yes" : "pending"}`
        : "",
      renderStats.gpuDepthKeyEnabled ? `GPU sort mode: ${renderStats.gpuSortMode}` : "",
      renderStats.gpuDepthKeyEnabled ? `GPU visible sort: ${renderStats.gpuSortVisibleMode}` : "",
      renderStats.gpuDepthKeyEnabled ? `GPU visible effective: ${renderStats.gpuSortVisibleEffective}` : "",
      renderStats.gpuDepthKeyEnabled
        ? `GPU keygen: ${formatMs(renderStats.lastGpuDepthKeyMs)} ms / ${formatCount(renderStats.lastGpuDepthKeySplats)}`
        : "",
      renderStats.gpuSortHistogramEnabled
        ? `GPU histogram: ${renderStats.gpuSortHistogramDispatched ? "yes" : "pending"}`
        : "",
      renderStats.gpuSortHistogramEnabled
        ? `GPU buckets: ${formatMs(renderStats.lastGpuSortHistogramMs)} ms / ${formatCount(renderStats.gpuSortHistogramBuckets)}`
        : "",
      renderStats.gpuSortPrefixSumEnabled
        ? `GPU prefix: ${renderStats.gpuSortPrefixSumDispatched ? "yes" : "pending"}`
        : "",
      renderStats.gpuSortPrefixSumEnabled
        ? `GPU offsets: ${formatMs(renderStats.lastGpuSortPrefixSumMs)} ms / ${formatCount(renderStats.gpuSortPrefixSumBuckets)}`
        : "",
      renderStats.gpuSortScatterEnabled
        ? `GPU scatter: ${renderStats.gpuSortScatterDispatched ? "yes" : "pending"}`
        : "",
      renderStats.gpuSortScatterEnabled
        ? `GPU index write: ${formatMs(renderStats.lastGpuSortScatterMs)} ms / ${formatCount(renderStats.lastGpuSortScatterSplats)}`
        : "",
      renderStats.gpuRadixSortEnabled
        ? `GPU radix: ${renderStats.gpuRadixSortDispatched ? "yes" : "pending"}`
        : "",
      renderStats.gpuRadixSortEnabled
        ? `GPU radix sort: ${formatMs(renderStats.lastGpuRadixSortMs)} ms / ${formatCount(renderStats.lastGpuRadixSortSplats)}`
        : "",
      renderStats.gpuRadixSortEnabled
        ? `GPU radix bits: ${formatCount(renderStats.gpuRadixSortBits)} / passes ${formatCount(renderStats.gpuRadixSortPasses)}`
        : "",
      renderStats.gpuRadixValidationEnabled
        ? `GPU radix validation: ${renderStats.gpuRadixValidationPending ? "pending" : "ready"}`
        : "",
      renderStats.gpuRadixValidationEnabled
        ? `GPU radix asc violations: ${formatCount(renderStats.gpuRadixAscendingViolations)} / ${formatCount(renderStats.gpuRadixValidationSamples)}`
        : "",
      renderStats.gpuRadixValidationEnabled
        ? `GPU radix desc violations: ${formatCount(renderStats.gpuRadixDescendingViolations)} / ${formatCount(renderStats.gpuRadixValidationSamples)}`
        : "",
      renderStats.gpuRadixValidationEnabled
        ? `GPU radix bad indices: ${formatCount(renderStats.gpuRadixOutOfRangeIndices)} / dup ${formatCount(renderStats.gpuRadixDuplicateAdjacentIndices)}`
        : "",
      renderStats.gpuRadixValidationEnabled
        ? `GPU radix checksum: ${renderStats.gpuRadixChecksumValid ? "valid" : "invalid"} / ${formatCount(renderStats.gpuRadixValidatedIndexCount)}`
        : "",
      `Sort: ${formatMs(renderStats.lastSortMs)} ms`,
      `Upload: ${formatMs(renderStats.lastUploadMs)} ms`,
      `LOD build: ${formatMs(renderStats.lastLodBuildMs)} ms`,
      `Sort pending: ${renderStats.sortPending ? "yes" : "no"}`,
      `Bounds min: ${formatVec(bufferStats.boundsMin)}`,
      `Bounds max: ${formatVec(bufferStats.boundsMax)}`,
      "scaleLogMax" in bufferStats
        ? `Scale log: ${formatRange((bufferStats as unknown as { scaleLogMin: number }).scaleLogMin, bufferStats.scaleLogMax as number)}`
        : "",
      "opacityMax" in bufferStats
        ? `Opacity: ${formatRange((bufferStats as unknown as { opacityMin: number }).opacityMin, bufferStats.opacityMax as number)}`
        : "",
    ];
    this.root.textContent = lines.filter((line) => line.trim().length > 0).join("\n");
  }
}

export { ViewerDebugStats };
