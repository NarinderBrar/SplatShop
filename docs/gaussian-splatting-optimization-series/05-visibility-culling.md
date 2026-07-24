# 05 -- Visibility & Culling

Even after LOD selection, many chunks are not visible. They might be behind the camera,
outside the view frustum, or hidden behind other geometry. Culling removes them early
so we do not waste sorting and rendering work on them.

---

## Frustum Culling

The camera sees a pyramid-shaped region of space called the **view frustum**. Any chunk
whose bounding box is entirely outside this pyramid can be safely skipped.

### What Is a Frustum?

```
        Near plane
       /----------\
      /            \
     /              \
    /                \
   /                  \
  /                    \
 /                      \
Far plane
```

A frustum is defined by 6 planes (left, right, top, bottom, near, far). For each plane,
we test the chunk's AABB:

### The AABB Test

```typescript
function isChunkInFrustum(chunk: Chunk, frustum: Plane[]): boolean {
  for (const plane of frustum) {
    // Find the "most positive" corner of the AABB relative to this plane
    const px = plane.normal.x >= 0 ? chunk.aabb.max.x : chunk.aabb.min.x;
    const py = plane.normal.y >= 0 ? chunk.aabb.max.y : chunk.aabb.min.y;
    const pz = plane.normal.z >= 0 ? chunk.aabb.max.z : chunk.aabb.min.z;

    const dist = plane.normal.x * px
               + plane.normal.y * py
               + plane.normal.z * pz
               + plane.distance;

    if (dist < 0) {
      return false;  // Entire AABB is outside this plane
    }
  }
  return true;
}
```

### How It Works

For each plane, we find the corner of the AABB that is most likely to be on the positive
side (the side the camera is on). If even that corner is on the negative side, the entire
AABB is outside the frustum.

```
Frustum plane:  [-------|-------]
AABB:           [===]           <- entirely on negative side -> CULLED

Frustum plane:  [-------|-------]
AABB:               [===]      <- spans the plane -> VISIBLE

Frustum plane:  [-------|-------]
AABB:                    [===] <- entirely on positive side -> VISIBLE
```

This is the classic separating axis test. If any single plane rejects the AABB, the chunk
is entirely outside the frustum. The test is fast -- 6 dot products per chunk.

### Adaptive Frustum Margin

We add a configurable margin to the frustum test to prevent chunks from popping in and
out at screen edges:

```typescript
function isChunkInFrustumWithMargin(
  chunk: Chunk,
  frustum: Plane[],
  margin: number
): boolean {
  for (const plane of frustum) {
    // Expand the plane outward by the margin
    const expandedPlane = {
      normal: plane.normal,
      distance: plane.distance - margin,
    };

    // Test with expanded plane
    if (!isAabbOnPositiveSide(chunk.aabb, expandedPlane)) {
      return false;
    }
  }
  return true;
}
```

A margin of 0.5 meters means chunks 0.5m outside the view are still considered visible.
This prevents popping when the camera moves and chunks near the edge alternate between
visible and culled.

---

## GPU Frustum Culling

For scenes with thousands of chunks, even the fast AABB test can be slow on the CPU. We
move it to the GPU using a compute shader:

```wgsl
@group(0) @binding(0) var<storage, read> chunkAabbs: array<vec4<f32>>;
@group(0) @binding(1) var<storage, read> chunkAabbs2: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> visibleChunks: array<u32>;
@group(0) @binding(3) var<uniform> frustum: FrustumPlanes;
@group(0) @binding(4) var<storage, read_write> visibleCount: atomic<u32>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= arrayLength(&chunkAabbs)) { return; }

  let min = chunkAabbs[i].xyz;
  let max = vec3<f32>(chunkAabbs[i].w, chunkAabbs2[i].xy);

  for (var p = 0u; p < 6u; p++) {
    let plane = frustum.planes[p];
    let px = select(min.x, max.x, plane.x >= 0.0);
    let py = select(min.y, max.y, plane.y >= 0.0);
    let pz = select(min.z, max.z, plane.z >= 0.0);

    let d = plane.x * px + plane.y * py + plane.z * pz + plane.w;
    if (d < 0.0) { return; }
  }

  // Chunk is visible -- add to compacted list
  let idx = atomicAdd(&visibleCount, 1u);
  visibleChunks[idx] = i;
}
```

### Why GPU?

The GPU runs this for all chunks in parallel with 256-thread workgroups. For 10,000
chunks, that is ~40 workgroups, each processing 256 chunks. The entire culling pass
completes in microseconds.

### Compaction

The output is a compacted list of visible chunk indices. No gaps, no wasted space. The
CPU does not need to filter or compress anything.

```
Input:  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]  (10 chunks)
Cull:   [V, C, V, C, C, V, C, V, C, C]  (V=visible, C=culled)
Output: [0, 2, 5, 7]                     (compacted indices)
```

---

## Hi-Z Occlusion Culling

Frustum culling catches chunks outside the view. But what about chunks that are *inside*
the view but hidden behind other geometry? That is occlusion culling.

### What Is Hi-Z?

A **Hi-Z buffer** (hierarchical Z-buffer) is a mipmap of the depth buffer. Each level
stores the minimum depth in a 2x2 region of the level below:

```
Level 0 (full resolution):
[d00 d01 d02 d03]
[d10 d11 d12 d13]
[d20 d21 d22 d23]
[d30 d31 d32 d33]

Level 1 (2x reduction):
[min(d00,d01,d10,d11)  min(d02,d03,d12,d13)]
[min(d20,d21,d30,d31)  min(d22,d23,d32,d33)]

Level 2 (4x reduction):
[min(all)]
```

### Building the Hi-Z

```wgsl
@compute @workgroup_size(8, 8)
fn buildHiZ(@builtin(global_invocation_id) gid: vec3<u32>) {
  let level = gid.z;
  let x = gid.x;
  let y = gid.y;

  let childX = x * 2;
  let childY = y * 2;

  let d0 = textureLoad(hiZ, vec2<u32>(childX,     childY),     level - 1);
  let d1 = textureLoad(hiZ, vec2<u32>(childX + 1, childY),     level - 1);
  let d2 = textureLoad(hiZ, vec2<u32>(childX,     childY + 1), level - 1);
  let d3 = textureLoad(hiZ, vec2<u32>(childX + 1, childY + 1), level - 1);

  let minDepth = min(min(d0, d1), min(d2, d3));
  textureStore(hiZ, vec2<u32>(x, y), level, minDepth);
}
```

### Testing Occlusion

To test if a chunk is occluded, we project its AABB onto the screen, find which Hi-Z
level covers it, and compare its depth against the stored minimum:

```wgsl
fn testOcclusion(chunkMin: vec3<f32>, chunkMax: vec3<f32>) -> bool {
  let center = (chunkMin + chunkMax) * 0.5;
  let screenPos = projectToScreen(center);

  // Choose Hi-Z level based on screen-space size
  let screenSize = length(projectToScreen(chunkMax) - projectToScreen(chunkMin));
  let level = clamp(u32(log2(screenSize)), 0u, MAX_LEVEL);

  // Sample minimum depth in the region
  let minVisibleDepth = sampleHiZ(screenPos, level);

  // If the chunk's nearest point is farther, it is hidden
  let chunkNearest = projectDepth(chunkMin);
  return chunkNearest <= minVisibleDepth;
}
```

### The Three Passes

1. **Clear**: Reset the Hi-Z buffer
2. **Build**: Reduce the depth buffer into a mipmap (min-depth at each level)
3. **Test**: For each chunk, project to screen and compare against Hi-Z

```
Pass 1: Clear    -> [empty]
Pass 2: Build    -> [min depth mipmap]
Pass 3: Test     -> [visible chunks, occluded chunks rejected]
```

---

## Hi-Z Hysteresis

Occlusion culling can cause popping when the camera moves. A chunk that was occluded one
frame might become visible the next, causing a sudden appearance.

We protect recently-visible chunks:

```typescript
class HiZOcclusionState {
  private protectionFrames = new Map<number, number>();

  setProtected(chunkIndex: number, frames: number): void {
    this.protectionFrames.set(chunkIndex, frames);
  }

  isProtected(chunkIndex: number): boolean {
    const remaining = this.protectionFrames.get(chunkIndex) ?? 0;
    if (remaining > 0) {
      this.protectionFrames.set(chunkIndex, remaining - 1);
      return true;
    }
    return false;
  }
}
```

```
Frame 1: Chunk A is visible -> protected for 3 frames
Frame 2: Hi-Z says chunk A is occluded -> but still protected
Frame 3: Hi-Z says chunk A is occluded -> but still protected
Frame 4: Hi-Z says chunk A is occluded -> protection expired, now culled
```

This gives the streaming system time to load finer detail before the chunk fully appears,
preventing visual popping.

---

## Prefetch Frustum Expansion

When the user is about to turn or move, chunks just outside the view will soon become
visible. If we wait until they enter the view to start loading them, there will be a
visible delay.

We expand the frustum for prefetching:

```typescript
function getPrefetchChunks(
  chunks: Chunk[],
  camera: Camera,
  visibleMargin: number,
  prefetchMargin: number
): Chunk[] {
  const prefetch = [];

  for (const chunk of chunks) {
    const isVisible = isInFrustum(chunk, camera, visibleMargin);
    const isPrefetchable = isInFrustum(chunk, camera, prefetchMargin);

    if (isPrefetchable && !isVisible) {
      prefetch.push(chunk);
    }
  }

  return prefetch;
}
```

```
Visible frustum:  [=====]
Prefetch frustum: [===========]
                  ^   ^       ^
                  |   |       |
                  |   visible | prefetch zone
                  |           |
                  camera
```

The prefetch margin is larger than the visible margin, so we start loading chunks before
they appear on screen. By the time the user looks at them, they are already in memory.

---

## GPU Chunk Visibility Compaction

After frustum and occlusion culling, we need a compacted list of visible chunks. The GPU
does this automatically using atomic counters:

```wgsl
@compute @workgroup_size(256)
fn compactVisible(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= chunkCount) { return; }

  if (isVisible[gid.x] && !isOccluded[gid.x]) {
    let idx = atomicAdd(&visibleCount, 1u);
    compactedIndices[idx] = gid.x;
  }
}
```

No CPU-side filtering. No array compacting. The GPU produces a tight, gap-free list of
visible chunk indices ready for the next pipeline stage.

---

## Key Takeaways

1. **Frustum culling** -- reject chunks outside the camera view with 6-plane AABB test
2. **GPU frustum culling** -- move the test to compute shaders for thousands of chunks
3. **Hi-Z occlusion** -- reject chunks hidden behind rendered geometry using depth mipmap
4. **Hysteresis** -- protect recently-visible chunks to prevent popping
5. **Prefetch expansion** -- load chunks before they enter the view
6. **GPU compaction** -- produce gap-free visible index list on the GPU

---

[Previous: LOD Selection](./04-lod-selection.md) | [Next: Quality Adaptation](./06-quality-adaptation.md)
