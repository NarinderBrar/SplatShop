# Gaussian Splatting Rendering Optimizations: A Deep Dive

A practical guide to building a high-performance Gaussian Splatting renderer in the browser.
We walk through every optimization stage -- from loading files off disk to drawing pixels on screen.

---

## What Is Gaussian Splatting?

Traditional 3D rendering uses triangles. You model a chair as thousands of flat surfaces,
light bounces off them, and you get an image. Gaussian Splatting throws that model away.

Instead of triangles, the scene is stored as millions of tiny colored blobs called
**Gaussians**. Each Gaussian has:

- A **position** in 3D space (x, y, z)
- A **covariance** (an ellipsoid shape -- how stretched and rotated it is)
- A **color** (what it looks like)
- An **opacity** (how transparent it is)

To render, you project every Gaussian onto the screen, sort them back-to-front, and
blend them together. The result looks photorealistic -- because each Gaussian was
optimized from real photographs to reconstruct the scene.

A typical scene might contain **1 to 10 million Gaussians**. That is a lot of blobs to
project, sort, and blend every single frame. Without optimization, you get maybe 2 frames
per second on a good GPU. With optimization, you get 60.

---

## The Rendering Pipeline

The core rendering loop for Gaussian Splatting looks like this:

```
for each frame:
    1. Load splat data from disk (if streaming)
    2. Organize data into cache-friendly layouts
    3. Decide which splats to show (LOD selection)
    4. Remove splats outside the view (frustum culling)
    5. Remove splats hidden behind other geometry (occlusion culling)
    6. Sort remaining splats back-to-front
    7. Bin splats into screen tiles
    8. Rasterize each tile
    9. Composite the final image
```

Every one of these steps is a bottleneck at scale. This article series tackles each one.

---

## Optimization Techniques Overview

We cover ~70+ distinct optimization techniques across 12 pipeline stages.

### Stage 1: File Loading & Decoding

| Technique | Description |
|---|---|
| Range-based SOG decoding | Extract only the byte range needed from a decoded file, not the whole thing |
| Decoded backing store cache | Cache decoded data per filename, deduplicate concurrent requests |
| Morton-order spatial sort | Reorder splats by spatial locality at load time for GPU cache efficiency |

### Stage 2: Data Layout & CPU Optimization

| Technique | Description |
|---|---|
| Chunk-based spatial partitioning | Split splats into fixed-size chunks (4096) with pre-computed AABB bounds |
| Structure of Arrays (SoA) | Parallel typed arrays instead of object arrays for cache-friendly access |
| Bitfield state packing | 5 boolean flags packed into a single Uint32 (80% memory reduction) |
| Inline MVP projection | Manual matrix multiply with early clip rejection, no library overhead |
| Pre-computed sort bin weights | Distance weight tiers pre-computed at init, no per-sort branching |

### Stage 3: Memory & Buffer Management

| Technique | Description |
|---|---|
| GPU buffer arena | Power-of-two arena allocator for GPU buffers, reset each frame |
| GPU uniform arena | Single shared uniform buffer with aligned sub-allocation cursor |
| GPU readback buffer pool | Pooled staging buffers with serial read queue |
| GPU buffer writer | Upload helper with pooled scratch staging |
| Typed array pool | CPU-side typed array pool with lease/release pattern |
| Dirty-range GPU state upload | Track min/max modified index, upload only changed slice |
| Buffer version tracking | Skip bind group recreation when buffer versions unchanged |
| Command queue serialization | Serialize state-modifying operations to prevent race conditions |

### Stage 4: LOD Selection

| Technique | Description |
|---|---|
| Hierarchical spatial LOD tree | Tree of nodes with multiple LOD levels per node |
| Budget-aware greedy LOD selection | Iterative upgrade algorithm with cost^0.55 scaling |
| Foveated LOD weighting | Reduce priority for peripheral and behind-camera nodes |
| LOD selection hysteresis | 1.15x boost to previously-selected nodes, prevent flickering |
| Forced fine-detail upgrade | Screen-dominant nodes forced to finest LOD |
| Rust WASM LOD traversal | Core algorithm in Rust/WASM running in Web Worker |
| Transferable output buffers | Zero-copy result transfer from Worker |
| LOD selection throttling | Run every 15 frames, only on camera movement |
| Chunk fallback during streaming | Show coarsest loaded chunk while finer data loads |

### Stage 5: Visibility & Culling

| Technique | Description |
|---|---|
| AABB frustum culling | Classic 6-plane test with configurable safety margin |
| GPU chunk frustum culling | Frustum culling on GPU via compute shader with compaction |
| 3D Hi-Z occlusion culling | Hierarchical Z-buffer: clear, build, test |
| Hi-Z hysteresis protection | Protect recently-visible chunks for multiple frames |
| Prefetch frustum expansion | Load chunks before they enter view |
| Adaptive frustum margin | Configurable margin prevents popping at screen edges |

### Stage 6: Quality Adaptation

| Technique | Description |
|---|---|
| Multi-tier quality presets | fast, balanced, full, idle, screenshot |
| Device tier detection | Platform and GPU detection for automatic preset selection |
| Max DPR capping | Limit device pixel ratio on high-DPI displays |
| Adaptive quality scaling | Adjust quality based on frame time vs target |
| View-context-aware budget | Different budgets for interactive, minimap, thumbnail, screenshot |
| Per-preset LOD chunk limits | fast=4, balanced=8, full=16 loaded chunks |

### Stage 7: GPU Sorting

| Technique | Description |
|---|---|
| Full GPU radix sort | Histogram, prefix-sum, scatter on 20-bit depth keys |
| Adaptive bit-width radix sort | 10-20 bits auto-selected based on splat count |
| Shadow/non-blocking sort mode | Background sort that does not block rendering |
| Sort interval culling | Sort every N frames instead of every frame |
| Sort skip on camera stability | Skip sort when camera is stationary |
| CPU fallback sort worker | Web Worker with weighted depth bins and transferable output |
| Per-chunk GPU radix sort | Each GPU page chunk gets its own sort pass |

### Stage 8: Compute Tile Pipeline

| Technique | Description |
|---|---|
| GPU depth-key generation | Project splat centers to screen, compute 20-bit depth keys |
| GPU tile histogram binning | Scatter splats into tile buckets with atomic counters |
| GPU tile depth range | Per-tile min/max depth for front-to-back ordering |
| GPU tile work queue | Multi-phase: depth-band scatter, stable sort, compaction |
| GPU tile depth ordering | Histogram, prefix-sum, scatter for tile-level depth order |
| GPU color segmentation | Quantize colors into ~64 groups for draw-call batching |
| Tile pipeline throttling | Run every N frames for static scenes |
| Adaptive tile work queue budget | Coverage targets and budget caps |
| Empty tile compaction | Skip tiles with zero occupancy |

### Stage 9: Streaming & Page Management

| Technique | Description |
|---|---|
| GPU page pool (first-fit) | Fixed-size allocator with fragmentation tracking |
| Page eviction with pressure tracking | Evict based on residency pressure |
| Upload budget throttling | Per-frame byte and chunk count limits |
| Stale chunk dropping | Drop chunks no longer selected by LOD |
| Pre-upload GPU eviction | Evict before uploading to ensure space |
| Chunk load prioritization | Sort by distance and screen size with hysteresis |
| LOD transition locking | Lock transitions to prevent thrashing at node boundaries |

### Stage 10: Rendering Pipeline

| Technique | Description |
|---|---|
| Reverse-Z depth buffer | Near=1, far=0 for improved float precision at distance |
| Temporal jitter accumulation | Halton-sequence sub-pixel jitter with stability detection |
| Custom WebGPU render pipeline | Bypass Babylon.js defaults, direct GPU control |
| Instanced quad rendering | 128 splats per instance, 6 vertices per splat |
| Bind group caching | Skip recreate when native buffer pointers unchanged |
| Dummy storage buffer reuse | Single pre-allocated buffer for unused slots |
| MRT frame targets | Color, motion, selection, revealage with half-float |
| Camera inertia disabled | Prevent momentum from advancing view between sort frames |
| WebGPU limits negotiation | Request 16 maxStorageBuffersPerShaderStage |

### Stage 11: Infrastructure & Error Handling

| Technique | Description |
|---|---|
| Compute capability probing | Check WebGPU, compute shaders, function availability |
| Renderer backend selection | Try requested mode, fall back to CPU |
| WebGPU error scope validation | pushErrorScope/popErrorScope for pipeline creation |
| WebGPU error deduplication | Deduplicate repeated errors, cap at 128 unique |
| Uncaptured error dedup | Hook device error event with preventDefault |

### Stage 12: Dirty Tracking

| Technique | Description |
|---|---|
| Dirty pass dispatch skip | Skip compute passes when inputs unchanged |
| Resident signature change detection | Rebuild only when active set, LOD, count, or pages change |

---

## Articles

| # | Article | Focus |
|---|---|---|
| 01 | [File Loading & Decoding](./01-file-loading-decoding.md) | Range-based decode, backing store cache, Morton sort |
| 02 | [Data Layout & CPU Optimization](./02-data-layout.md) | SoA, chunks, bitfield packing, inline MVP |
| 03 | [Memory & Buffer Management](./03-memory-management.md) | Arenas, pools, dirty-range upload, version tracking |
| 04 | [LOD Selection](./04-lod-selection.md) | Hierarchical tree, budget-aware greedy, foveation, WASM |
| 05 | [Visibility & Culling](./05-visibility-culling.md) | Frustum, GPU culling, Hi-Z occlusion, prefetch |
| 06 | [Quality Adaptation](./06-quality-adaptation.md) | Presets, DPR capping, adaptive scaling, view-context |
| 07 | [GPU Sorting](./07-gpu-sorting.md) | Radix sort, adaptive bits, shadow mode, camera skip |
| 08 | [Compute Tile Pipeline](./08-compute-tile-pipeline.md) | Depth-key, binning, work queue, color segmentation |
| 09 | [Streaming & Page Management](./09-streaming-page-management.md) | Page pool, upload budget, eviction, prioritization |
| 10 | [Rendering Pipeline](./10-rendering-pipeline.md) | Reverse-Z, temporal jitter, instanced quads, MRT |
| 11 | [Infrastructure & Error Handling](./11-infrastructure.md) | Capability probing, fallback, error deduplication |
| 12 | [Dirty Tracking](./12-dirty-tracking.md) | Pass skip, resident signature detection |
| 13 | [Summary](./13-summary.md) | Key takeaways |

---

## Pipeline Flow

```
Loading -> Data Layout -> Memory -> LOD Selection -> Culling -> Quality
  -> GPU Sorting -> Tile Compute -> Streaming -> Rendering -> Infrastructure
```

Each stage feeds the next. Optimizations compound: a fast loader means data arrives
sooner, good data layout means sorting is faster, fast culling means fewer splats to
sort, and so on.
