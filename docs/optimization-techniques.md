# SplatShop Optimization Techniques

~70+ distinct optimization techniques organized by pipeline stage (loading → rendering).

---

## 1. File Loading & Decoding

| Technique | File | Description |
|---|---|---|
| Decoded backing store cache | `loader.ts` | `SogDecodedBackingStore` caches decoded WebP data per filename. Deduplicates concurrent range requests for the same file. |
| Range-based SOG decoding | `loader.ts` | `createPackedSogDataRange()` extracts only the requested byte range from decoded backing data, avoiding full-file materialization. |
| Morton-order spatial sort | `loader.ts` | Non-SOG splats reordered into Morton curve order for improved spatial locality on GPU. |

---

## 2. Data Layout & CPU Optimization

| Technique | File | Description |
|---|---|---|
| Chunk-based spatial partitioning | `SplatLodManager.ts` | Splat data pre-partitioned into fixed-size chunks (default 4096 splats) with pre-computed AABB bounds. |
| SoA frame data | `FrameDataSoA.ts` | Per-frame camera/viewport data stored as Structure-of-Arrays for cache-friendly GPU upload. |
| SoA LOD candidates | `SsogLodSelector.ts` | LOD candidate data as parallel typed arrays (nodeIds, depths, lods, counts, flags, lodScales, bounds). |
| Splat state bitfield packing | `SplatStateBuffer.ts` | Per-splat state stored as single `Uint32` bitfield (SELECTED=bit0, HIDDEN=bit1, LOCKED=bit2, FILTERED=bit3, DELETED=bit4). |
| Inline MVP projection | `SelectionPass.ts` | `projectSplat()` performs MVP transform inline with early `clipW <= 0` rejection. No Matrix.multiply overhead. |
| Pre-computed sort bin weights | `splatSort.worker.ts` | Distance-based weight tiers pre-computed at worker init into Float32Arrays. Avoids per-sort branching. |

---

## 3. Memory & Buffer Management

| Technique | File | Description |
|---|---|---|
| GPU buffer arena | `GpuBufferArena.ts` | Power-of-two capacity rounding. Tracks reuse vs growth. Avoids frequent GPU buffer reallocation. |
| GPU uniform arena | `GpuUniformArena.ts` | Single shared uniform buffer with aligned sub-allocation cursor. Per-frame `begin()`/`end()` resets cursor. |
| GPU readback buffer pool | `GpuReadbackBufferPool.ts` | Pool with power-of-two sizing. Serial read queue avoids staging buffer contention. Lease/release pattern. |
| GPU buffer writer | `GpuBufferWriter.ts` | Upload helper with pooled scratch staging buffers. Arena allocation for sub-buffer ranges. |
| Typed array pool | `TypedArrayPool.ts` | CPU-side typed array pool with power-of-two sizing. Lease/release pattern tracks checked-out arrays. Tracks peak byte usage. |
| Dirty-range GPU state upload | `SplatStateBuffer.ts` | Tracks dirty range (min/max modified index) and only uploads changed slice to GPU storage buffer. |
| Buffer version tracking | `BufferVersionTracker.ts` | `rebindStorageBuffer()` compares resource versions; skips `setStorageBuffer` if unchanged. |
| Command queue serialization | `SplatStateCommandQueue.ts` | State-modifying operations serialized through single-threaded command queue to prevent race conditions. |

---

## 4. LOD Selection (CPU / WASM)

| Technique | File | Description |
|---|---|---|
| Hierarchical spatial LOD tree | `ssog-hierarchy.md` | Scene organized as tree of spatial nodes with multiple LOD levels (0=finest, N=coarsest). |
| Budget-aware LOD selection | `SsogLodSelector.ts` | Greedy algorithm: starts at coarsest LOD, upgrades to finer LODs within splat budget using screen-radius, view-dot, distance, foveation, and depth biases. |
| Foveated LOD weighting | `SsogLodSelector.ts` | `getFoveationWeight()` reduces priority for peripheral and behind-camera nodes with configurable `coneFoveate` and `behindFoveate`. |
| LOD selection hysteresis | `SsogLodSelector.ts` | `wasSelected` flag applies 1.15x hysteresis boost to prevent flickering LOD transitions. |
| Forced fine-detail upgrade | `SsogLodSelector.ts` | Screen-dominant nodes (above `forceFineScreenRatio`) forced to finest LOD for close-up quality. |
| Incremental LOD upgrade | `SsogLodSelector.ts` | Iterative budget-constrained upgrade loop with `cost^0.55` scaling to favor cheap upgrades. |
| Rust WASM LOD traversal | `ssogLodTraversal.worker.ts` | Core LOD selection compiled from Rust to WASM. Runs in Web Worker to keep main thread free. Lazy initialization. |
| Transferable output buffers | `ssogLodTraversal.worker.ts` | `postMessage(response, [selectedEntryIndices.buffer])` transfers result buffer without copying. |
| LOD selection throttling | `CompositeSplatRenderPass.ts` | Runs every 15 frames and only re-runs if camera moved/turned beyond thresholds. |
| Chunk fallback during streaming | `ssog-hierarchy.md` | When finer LOD chunk is not yet loaded, coarsest loaded entry remains visible as placeholder — no holes. |

---

## 5. Visibility & Culling

| Technique | File | Description |
|---|---|---|
| AABB frustum culling | `SsogFrustumCulling.ts` | Classic 6-plane frustum test using AABB. Tests max/min corners against plane normals with configurable safety margin. |
| GPU chunk frustum culling | `SsogGpuChunkVisibilityPass.ts` | Frustum culling accelerated on GPU via compute shader. Produces compacted visible chunk index list. |
| 3D Hi-Z occlusion culling | `SsogHiZOcclusionPass.ts` | Three passes: clear, build (min-depth reduction), test (chunk AABB occlusion). Rejects chunks fully behind known geometry. |
| Hi-Z hysteresis protection | `SsogHiZOcclusionPass.ts` | Occlusion results protected for multiple frames to prevent popping: visible chunks remain protected even if Hi-Z test would reject them. |
| GPU chunk visibility compaction | `SsogGpuChunkVisibilityPass.ts` | Visible chunk indices compacted into tight array on GPU, avoiding CPU-side filtering of culled chunks. |
| Prefetch frustum expansion | `StreamingSsogRenderPass.ts` | Prefetch uses expanded frustum beyond visible frustum to proactively load chunks about to enter view. |
| Adaptive frustum margin | `StreamingSsogRenderPass.ts` | Configurable margin prevents popping at screen edges. |

---

## 6. Quality Adaptation

| Technique | File | Description |
|---|---|---|
| Multi-tier quality presets | `qualityProfiles.ts` | 5 presets: `fast`, `balanced`, `full`, `idle`, `screenshot`. Each configures minAlpha, minPixelRadius, maxPixelRadius, maxStdDev, clipXY, blur, alphaClip, maxDPR, splatBudget. |
| Device tier detection | `qualityProfiles.ts` | Platform and device tier detection (`qualityPlatform`, `qualityDeviceTier`) for automatic quality selection. |
| Max DPR capping | `qualityProfiles.ts` + `createEngine.ts` | `maxDevicePixelRatio` from quality profile caps hardware scaling to limit GPU fill rate on high-DPI displays. |
| Adaptive quality scaling | `ViewerDebugStats.ts` | `adaptiveQualityScale` and `adaptiveInteractionScale` adjust quality based on frame time vs target. |
| View-context-aware budget | `SplatViewContext.ts` | `resolveSplatViewBudget()` selects budget based on view kind (interactive/screenshot/thumbnail/minimap/portal/offline). |
| Per-preset LOD chunk limit | `loader.ts` | Limits loaded chunks per preset: fast=4, balanced=8, full=16. |

---

## 7. GPU Sorting

| Technique | File | Description |
|---|---|---|
| Full GPU radix sort | `GpuRadixSortPass.ts` | Histogram → prefix-sum → scatter pipeline on 20-bit depth keys. Replaces CPU sort for large splat counts. |
| Adaptive bit-width radix sort | `GpuRadixSortPass.ts` | Configurable 10–20 sort bits. Auto-selects passes based on `Math.ceil(Math.log2(splatCount / 4))`. |
| Shadow/non-blocking sort mode | `renderControls.ts` | `GpuSortMode` can run in background without blocking rendering, or synchronously for full sort. |
| Sort interval culling | `renderControls.ts` | Sort runs every N frames (`getSortIntervalFrames()`, `getGpuSortIntervalFrames()`), avoiding per-frame cost. |
| Sort skip on camera stability | `renderControls.ts` | Movement epsilon (`sortMoveEpsilonSq`) and forward dot threshold (`sortForwardDotThreshold`) skip sort when camera is stationary. |
| CPU fallback sort worker | `splatSort.worker.ts` | Web Worker fallback using weighted depth bins (weights 40/20/8/3/1). Single-pass counting sort with transferable buffer output. |
| Adaptive CPU sort key bits | `splatSort.worker.ts` | Dynamically adjusts comparison bits based on `Math.max(10, Math.min(20, Math.round(Math.log2(splatCount / 4))))`. |
| Per-chunk GPU radix sort | `SsogResidentPageRenderPass.ts` | Each resident GPU page chunk gets its own GPU depth-key + radix sort pass for parallel sorting. |

---

## 8. Compute Tile Pipeline

| Technique | File | Description |
|---|---|---|
| GPU depth-key generation | `GpuDepthKeyPass.ts` | Projects splat centers onto camera forward axis on GPU. Computes min/max depth from scene AABB bounds. 256-thread workgroups. |
| GPU tile statistics binning | `ComputeTileStatsPass.ts` | Histogram-based tile binning: clears tile counters, then scatters splats into tile buckets. Produces per-tile occupancy counts. |
| GPU tile depth range | `ComputeTileDepthRangePass.ts` | Per-tile min/max depth computation on GPU. Produces depth-span stats for front-to-back ordering. |
| GPU tile work queue | `ComputeTileWorkQueuePass.ts` | Multi-phase GPU work queue: depth-band scatter, stable sort, compaction with atomic counters. Produces ordered tile list. |
| GPU tile depth ordering | `ComputeTileOrderPass.ts` | GPU histogram + prefix-sum + scatter for tile-level depth-binned order. Enables front-to-back or back-to-front processing. |
| GPU color segmentation | `ColorSegmentationPass.ts` | GPU quantization of splat colors into ~64 groups. Enables draw-call batching by grouping similar colors. |
| Tile update interval culling | `SplatRenderPass.ts` | Tile compute pipeline runs every N frames when scene is static. |
| Adaptive tile work queue budget | `ComputeTileWorkQueuePass.ts` | Coverage targets and budget caps limit per-frame work with adaptive scaling. |
| Empty tile compaction | `ComputeTileWorkQueuePass.ts` | Compacts only tiles with non-zero occupancy, skipping empty tiles entirely. |

---

## 9. Streaming & Page Management

| Technique | File | Description |
|---|---|---|
| GPU page pool (first-fit) | `SsogGpuPagePool.ts` | Fixed-size GPU page allocator. First-fit from free pages. Tracks fragmentation (largest free run, ratio). |
| Page eviction with pressure tracking | `SsogGpuPagePool.ts` | GPU pages evicted based on residency pressure. Tracks allocation requests, overflow, and freed pages. |
| Upload budget throttling | `StreamingSsogRenderPass.ts` | Per-frame GPU upload budget (bytes + chunk count) prevents frame stalls from large uploads. |
| Stale chunk dropping | `StreamingSsogRenderPass.ts` | Queued/pending/upload chunks no longer selected by LOD are dropped to free bandwidth. |
| Pre-upload GPU eviction | `StreamingSsogRenderPass.ts` | GPU pages evicted before uploading new chunks to ensure space, avoiding allocation failures. |
| Chunk load prioritization | `StreamingSsogRenderPass.ts` | Chunks sorted by priority (distance, screen size) with hysteresis to prevent thrashing. |
| LOD transition locking | `ssog-hierarchy.md` | Transition locks prevent rapid LOD thrashing at node boundaries. |

---

## 10. Rendering Pipeline

| Technique | File | Description |
|---|---|---|
| Reverse-Z depth buffer | `ReverseDepth.ts` | Uses reverse-Z (near=1, far=0) for improved float precision at large distances. Critical for large scenes. |
| Temporal jitter accumulation | `SplatTemporalAccumulation.ts` | Halton-sequence sub-pixel jitter with configurable max samples. Stability detection stops accumulation when camera is steady. |
| Custom WebGPU render pipeline | `WebGpuRenderPipeline.ts` | Bypasses Babylon.js default rendering. Directly controls GPU render pass encoder. |
| Instanced quad rendering | `WebGpuSplatRasterPass.ts` | Direct WebGPU instanced quad rendering (128 splats/instance, 6 vertices/splat). Alpha blending without depth write. |
| Bind group caching | `WebGpuSplatRasterPass.ts` | `ensureBindGroup()` compares native buffer pointers; skips `createBindGroup()` if unchanged. |
| Dummy storage buffer reuse | `WebGpuSplatRasterPass.ts` | Unused storage buffer slots use single pre-allocated dummy buffer instead of null. |
| MRT frame targets | `SplatFrameTargets.ts` | Multi-render target with color, motion, selection, revealage attachments. Half-float for color/motion, integer for selection. Allocation failure caching prevents repeated failed attempts. |
| Disabled camera inertia | `CameraManager.ts` | `camera.inertia = 0` prevents momentum from advancing visible view between sort frames. |
| Engine WebGPU limits negotiation | `createEngine.ts` | Requests 16 `maxStorageBuffersPerShaderStage` from adapter for compute pipeline bindings. |

---

## 11. Infrastructure & Error Handling

| Technique | File | Description |
|---|---|---|
| Compute capability probing | `GpuDepthKeyPass.ts` | `canCreateComputeShader()` checks `isWebGPU`, `supportComputeShaders`, and function availability. |
| Renderer backend selection | `renderControls.ts` | `resolveRendererBackend()` tries requested mode, falls back to CPU if WebGPU compute unavailable. Reports fallback reason. |
| WebGPU error scope validation | `WebGpuSplatRasterPass.ts` | Pipeline creation wrapped in `pushErrorScope("validation")` / `popErrorScope()` to catch validation errors. |
| WebGPU error deduplication | `RenderDiagnostics.ts` | Deduplicates repeated GPU errors by message normalization and count tracking. Caps at 128 unique errors. |
| Uncaptured error dedup | `RenderDiagnostics.ts` | `installWebGpuErrorDedupe()` hooks `device.addEventListener("uncapturederror")` with `preventDefault()` and routes through deduplication. |

---

## 12. Compute Pipeline Dirty Tracking

| Technique | File | Description |
|---|---|---|
| Dirty pass dispatch skip | `CompositeSplatRenderPass.ts` | Compute passes skipped when inputs have not changed. Tracks `dirtyPassDispatches` and `dirtyPassSkips`. |
| Resident signature change detection | `StreamingSsogRenderPass.ts` | GPU resident state rebuilds triggered only when signature (active set, LOD, splat count, page allocation) changes. |

---

## Summary

The pipeline flows: **Loading** → **Data Layout** → **Memory Management** → **LOD Selection** → **Visibility & Culling** → **Quality Adaptation** → **GPU Sorting** → **Tile Compute** → **Streaming** → **Rendering** → **Infrastructure**.

Most impactful:

1. **GPU radix sort pipeline** — replaces CPU sort entirely for large scenes
2. **Hierarchical streaming LOD with WASM traversal** — budget-aware, foveated, with hysteresis
3. **GPU frustum culling + Hi-Z occlusion culling** — aggressive visibility culling on GPU
4. **Tile-based compute binning with work queue compaction** — efficient GPU-driven tile processing
5. **GPU page pool with eviction/pressure management** — controlled memory for streaming
6. **Temporal jitter accumulation** — anti-aliasing via sub-pixel jitter across frames
7. **Aggressive buffer reuse** — arena allocators, pools, dirty-range uploads, bind-group caching
