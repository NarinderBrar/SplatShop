# 07 -- GPU Sorting

Gaussian Splatting must render splats back-to-front for correct alpha blending. Sorting
millions of splats is one of the most expensive operations. We do it entirely on the GPU.

---

## Why Sorting Matters

Gaussian Splatting uses alpha blending. Each splat is semi-transparent, so the order you
render them affects the final image:

```
Front-to-back:  [splat A] [splat B] [splat C]
Back-to-front:  [splat C] [splat B] [splat A]

If you render back-to-front:
  1. Draw splat C (background)
  2. Draw splat B on top of C (blends)
  3. Draw splat A on top of B (blends)
  -> Correct result

If you render front-to-back:
  1. Draw splat A (foreground)
  2. Draw splat B behind A (wrong -- B is hidden by A)
  3. Draw splat C behind B (wrong)
  -> Incorrect result
```

For 1 million splats, sorting on the CPU takes 50-100ms. Sorting on the GPU takes 1-2ms.

---

## Radix Sort

A **radix sort** works by sorting numbers digit-by-digit. For 20-bit depth keys, we
process 4 bits at a time, requiring 5 passes. Each pass has three phases:

```
Pass structure (per 4-bit digit):

1. Histogram:   Count how many splats fall into each of 16 buckets
2. Prefix Sum:  Compute cumulative counts (where each bucket starts)
3. Scatter:     Write each splat to its correct output position
```

### Phase 1: Histogram

```wgsl
@compute @workgroup_size(256)
fn histogram(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= splatCount) { return; }

  let depthKey = depthKeys[gid.x];
  let digit = (depthKey >> (passIndex * 4u)) & 0xFu;

  atomicAdd(&histograms[digit], 1u);
}
```

Each workgroup thread reads one splat's depth key, extracts the current 4-bit digit,
and atomically increments the corresponding bucket counter.

```
Splat depth keys: [10110100, 10110101, 10110110, 10110111]
Pass 0 (bits 0-3): buckets 4, 5, 6, 7 each get +1
```

### Phase 2: Prefix Sum

```wgsl
@compute @workgroup_size(2048)
fn prefixSum() {
  let idx = local_id.x;
  var val = histograms[idx];

  // Blelloch exclusive prefix sum
  for (var d = 1u; d < 2048u; d <<= 1) {
    if (idx >= d) {
      val += sharedMem[idx - d];
    }
    workgroupBarrier();
    sharedMem[idx] = val;
    workgroupBarrier();
  }

  offsets[idx] = sharedMem[idx];
}
```

The prefix sum converts bucket counts into starting offsets. If bucket 0 has 100 splats
and bucket 1 has 50 splats, then bucket 1 starts at offset 100.

### Phase 3: Scatter

```wgsl
@compute @workgroup_size(256)
fn scatter(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= splatCount) { return; }

  let depthKey = depthKeys[gid.x];
  let digit = (depthKey >> (passIndex * 4u)) & 0xFu;

  let pos = atomicAdd(&offsets[digit], 1u);
  outputIndices[pos] = inputIndices[gid.x];
}
```

Each splat reads its current position, computes which bucket it belongs to, and atomically
writes itself to the correct output position.

### Complete Sort

The entire sort runs in 5 passes (4 bits x 5 digits = 20 bits). Each pass dispatches
3 compute shaders. That is 15 compute dispatches total -- all on the GPU.

```
Pass 0: sort by bits 0-3
Pass 1: sort by bits 4-7
Pass 2: sort by bits 8-11
Pass 3: sort by bits 12-15
Pass 4: sort by bits 16-19

Result: fully sorted by 20-bit depth key
```

---

## Adaptive Bit Width

Not every scene needs 20 bits of depth precision. A small scene with shallow depth might
only need 10 bits:

```typescript
function getSortBitCount(splatCount: number): number {
  return Math.max(10, Math.min(20,
    Math.ceil(Math.log2(splatCount / 4))
  ));
}
```

### Bit Count vs Pass Count

| Splat Count | Bits Needed | Passes | Compute Dispatches |
|---|---|---|---|
| 1,000 | 10 | 3 | 9 |
| 10,000 | 13 | 4 | 12 |
| 100,000 | 16 | 4 | 12 |
| 1,000,000 | 19 | 5 | 15 |
| 10,000,000 | 20 | 5 | 15 |

Fewer bits means fewer passes. A 10-bit sort needs only 3 passes instead of 5 -- a 40%
reduction in sort cost.

---

## Shadow (Non-Blocking) Sort

Sometimes we do not need the sort to complete before rendering. A "shadow" sort runs in
the background and the renderer uses the previous frame's sort order:

```typescript
type GpuSortMode = "active" | "shadow" | "none";

function shouldBlockOnSort(mode: GpuSortMode): boolean {
  return mode === "active";
}
```

### Active vs Shadow

```
Active sort:
  Frame N: [sort complete] -> [render using new order]
  (blocks rendering until sort finishes)

Shadow sort:
  Frame N: [render using previous order] + [sort in background]
  Frame N+1: [render using Frame N sort] + [sort in background]
  (never blocks rendering)
```

In shadow mode, the sort runs asynchronously and results are used on the next frame.
This hides the sort latency completely.

---

## Sort Skip on Camera Stability

If the camera has not moved, the sort order from the previous frame is still correct.
We skip sorting entirely:

```typescript
const SORT_MOVE_EPSILON_SQ = 0.0001;
const SORT_FORWARD_DOT_THRESHOLD = 0.999;

function shouldSort(camera: Camera, lastCamera: Camera): boolean {
  const moved = distanceSq(camera.position, lastCamera.position)
              > SORT_MOVE_EPSILON_SQ;
  const turned = dotProduct(camera.forward, lastCamera.forward)
               < SORT_FORWARD_DOT_THRESHOLD;
  return moved || turned;
}
```

For a static scene, this reduces sort cost to zero. The sort only runs when the camera
actually moves.

---

## Sort Interval Culling

Even when the camera moves, we do not need to sort every single frame. Sorting every
3rd frame is usually enough:

```typescript
const GPU_SORT_INTERVAL = 3;

function shouldGpuSort(frameCount: number): boolean {
  return frameCount % GPU_SORT_INTERVAL === 0;
}
```

### Visual Impact

```
Sort every frame:   [sorted] [sorted] [sorted] [sorted] [sorted]
Sort every 3 frames: [sorted] [reuse]  [reuse]  [sorted] [reuse]

Between sorts, we use the previous sort order.
The visual difference is negligible at 60 FPS.
```

---

## CPU Fallback Sort

When WebGPU compute is not available (older browsers), we fall back to a CPU sort in a
Web Worker:

```typescript
self.onmessage = (e) => {
  const { positions, camera, count } = e.data;

  const weights = new Float32Array([40, 20, 8, 3, 1]);
  const bins = new Uint32Array(count);

  for (let i = 0; i < count; i++) {
    const dx = positions[i * 3] - camera.x;
    const dy = positions[i * 3 + 1] - camera.y;
    const dz = positions[i * 3 + 2] - camera.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

    const binIndex = Math.min(4, Math.floor(dist / 10));
    bins[i] = (binIndex << 28) | i;
  }

  countingSort(bins);

  const sorted = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    sorted[i] = bins[i] & 0x0FFFFFFF;
  }

  self.postMessage({ sorted }, [sorted.buffer]);
};
```

### How It Works

1. Compute distance from each splat to camera
2. Quantize distance into 5 bins (0-9m, 10-19m, 20-29m, 30-39m, 40m+)
3. Pack bin index + original index into a single 32-bit key
4. Counting sort on the packed keys
5. Extract sorted indices

The result is a rough back-to-front ordering. Not as precise as GPU radix sort, but
fast enough for interactive use on devices without compute shader support.

---

## Per-Chunk GPU Radix Sort

For streaming scenes, each GPU page chunk gets its own sort pass:

```typescript
for (const chunk of residentChunks) {
  generateDepthKeys(chunk);
  radixSort(chunk);
}
```

This enables parallel sorting of independent chunks. Multiple chunks can be sorted
simultaneously on different GPU command queues.

---

## Key Takeaways

1. **GPU radix sort** -- histogram, prefix-sum, scatter on 20-bit depth keys
2. **Adaptive bit width** -- 10-20 bits based on splat count
3. **Shadow mode** -- sort in background without blocking rendering
4. **Camera stability** -- skip sort when camera is stationary
5. **Interval culling** -- sort every N frames instead of every frame
6. **CPU fallback** -- weighted depth bins with counting sort in Web Worker

---

[Previous: Quality Adaptation](./06-quality-adaptation.md) | [Next: Compute Tile Pipeline](./08-compute-tile-pipeline.md)
