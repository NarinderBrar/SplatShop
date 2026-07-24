# 13 -- Summary

The pipeline flows:

```
Loading -> Data Layout -> Memory -> LOD Selection -> Culling -> Quality
  -> GPU Sorting -> Tile Compute -> Streaming -> Rendering -> Infrastructure
```

Each stage feeds the next. Optimizations compound: a fast loader means data arrives
sooner, good data layout means sorting is faster, fast culling means fewer splats to
sort, and so on.

---

## The Most Impactful Optimizations

### 1. GPU Radix Sort

Replaces CPU sort entirely for large scenes. A 1 million splat sort goes from 50ms on
CPU to 1-2ms on GPU. The histogram, prefix-sum, and scatter pipeline runs in 5 passes
with 15 compute dispatches.

### 2. Hierarchical Streaming LOD with WASM Traversal

Reduces millions of splats to hundreds of thousands based on what the user actually sees.
The budget-aware greedy algorithm with foveated weighting and hysteresis ensures smooth
transitions. WASM acceleration keeps the main thread free.

### 3. GPU Frustum Culling + Hi-Z Occlusion

Removes off-screen and hidden chunks before they reach the sort. The GPU frustum test
processes thousands of chunks in microseconds. Hi-Z occlusion catches chunks hidden behind
rendered geometry.

### 4. Tile-Based Compute Binning

Efficiently distributes splats across screen tiles on the GPU. The multi-phase work queue
with depth-band scatter, stable sort, and compaction produces an ordered tile list for
front-to-back rendering.

### 5. GPU Page Pool with Eviction

Manages streaming of large scenes that do not fit in GPU memory. First-fit allocation,
pressure tracking, and priority-based eviction keep the most important data resident.

### 6. Temporal Jitter Accumulation

Anti-aliasing that improves quality over time without per-frame cost increase. Halton-sequence
sub-pixel jitter with stability detection produces smooth results after 8 frames.

### 7. Aggressive Buffer Reuse

Arena allocators, typed array pools, dirty-range uploads, and bind-group caching eliminate
per-frame allocation. Over time, allocation drops to zero and frame times stabilize.

---

## Technique Count by Category

| Category | Techniques |
|---|---|
| File Loading & Decoding | 3 |
| Data Layout & CPU Optimization | 6 |
| Memory & Buffer Management | 8 |
| LOD Selection | 10 |
| Visibility & Culling | 7 |
| Quality Adaptation | 6 |
| GPU Sorting | 8 |
| Compute Tile Pipeline | 9 |
| Streaming & Page Management | 7 |
| Rendering Pipeline | 9 |
| Infrastructure & Error Handling | 5 |
| Dirty Tracking | 2 |
| **Total** | **~70+** |

---

## The Core Principles

Across all 70+ techniques, the same principles appear again and again:

1. **Minimize work** -- skip passes when nothing changed, cull early, throttle updates
2. **Minimize memory allocation** -- pool everything, arena-allocate, dirty-range uploads
3. **Push work to the GPU** -- sort, cull, bin, and test on compute shaders
4. **Cache aggressively** -- bind groups, decoded data, sort results, error messages
5. **Adapt to the device** -- quality presets, DPR capping, adaptive scaling
6. **Prevent artifacts** -- hysteresis, transition locking, prefetch expansion

---

## Articles

| # | Article |
|---|---|
| 00 | [Introduction](./00-introduction.md) |
| 01 | [File Loading & Decoding](./01-file-loading-decoding.md) |
| 02 | [Data Layout & CPU Optimization](./02-data-layout.md) |
| 03 | [Memory & Buffer Management](./03-memory-management.md) |
| 04 | [LOD Selection](./04-lod-selection.md) |
| 05 | [Visibility & Culling](./05-visibility-culling.md) |
| 06 | [Quality Adaptation](./06-quality-adaptation.md) |
| 07 | [GPU Sorting](./07-gpu-sorting.md) |
| 08 | [Compute Tile Pipeline](./08-compute-tile-pipeline.md) |
| 09 | [Streaming & Page Management](./09-streaming-page-management.md) |
| 10 | [Rendering Pipeline](./10-rendering-pipeline.md) |
| 11 | [Infrastructure & Error Handling](./11-infrastructure.md) |
| 12 | [Dirty Tracking](./12-dirty-tracking.md) |
| 13 | [Summary](./13-summary.md) |
