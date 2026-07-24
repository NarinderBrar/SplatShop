# 02 -- Data Layout & CPU Optimization

Now that the data is loaded and decoded, we need to organize it for efficient processing.
The way you lay out data in memory has a massive impact on CPU and GPU performance.

---

## Chunk-Based Spatial Partitioning

We do not keep all millions of splats in one giant array. Instead, we split them into
fixed-size chunks -- typically 4096 splats per chunk. Each chunk has pre-computed axis-aligned
bounding box (AABB) bounds.

```
Scene (1,000,000 splats)
+-- Chunk 0 (splats 0-4095)      AABB: { min: [0,0,0], max: [10,10,10] }
+-- Chunk 1 (splats 4096-8191)   AABB: { min: [5,0,0], max: [15,10,10] }
+-- Chunk 2 (splats 8192-12287)  AABB: { min: [10,5,0], max: [20,15,10] }
+-- ...
+-- Chunk 243 (last chunk)
```

### Why Chunks?

Because culling and LOD decisions happen at the chunk level, not per-splat. If a chunk
is entirely off-screen, we skip all 4096 splats inside it with a single bounding box
test. That is 4096x cheaper than testing each splat individually.

```typescript
// One test skips thousands of splats
function isChunkVisible(chunk: Chunk, frustum: Plane[]): boolean {
  return isAabbInFrustum(chunk.aabb, frustum);
}
```

### Pre-Computed Bounds

The AABB bounds are computed once at load time, not every frame:

```typescript
function computeChunkAabb(splats: Splat[], start: number, end: number): AABB {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  for (let i = start; i < end; i++) {
    minX = Math.min(minX, splats[i].x);
    minY = Math.min(minY, splats[i].y);
    minZ = Math.min(minZ, splats[i].z);
    maxX = Math.max(maxX, splats[i].x);
    maxY = Math.max(maxY, splats[i].y);
    maxZ = Math.max(maxZ, splats[i].z);
  }

  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}
```

---

## Structure of Arrays (SoA)

This is one of the most important layout decisions in the entire renderer.

### Array of Structures (AoS) -- The Naive Approach

```typescript
interface Splat {
  x: number; y: number; z: number;
  r: number; g: number; b: number;
  opacity: number;
  scale: number;
}

const splats: Splat[] = [/* ... */];
```

In memory, this looks like:

```
[x, y, z, r, g, b, opacity, scale]  <- splat 0
[x, y, z, r, g, b, opacity, scale]  <- splat 1
[x, y, z, r, g, b, opacity, scale]  <- splat 2
...
```

### Structure of Arrays (SoA) -- The Optimized Approach

```typescript
const x = new Float32Array(count);
const y = new Float32Array(count);
const z = new Float32Array(count);
const r = new Float32Array(count);
const g = new Float32Array(count);
const b = new Float32Array(count);
const opacity = new Float32Array(count);
```

In memory, this looks like:

```
[x0, x1, x2, x3, ...]  <- all x values
[y0, y1, y2, y3, ...]  <- all y values
[z0, z1, z2, z3, ...]  <- all z values
[r0, r1, r2, r3, ...]  <- all red values
...
```

### Why SoA Wins

Most operations only touch one or two attributes. When you sort by depth, you only read
`x`, `y`, `z`. In AoS, loading one splat's coordinates pulls in color, opacity, and
scale too -- wasting cache lines. In SoA, loading depth values reads a contiguous block
of floats, filling every byte of each cache line with useful data.

```
AoS cache line (64 bytes = 8 floats):
[x0, y0, z0, r0, g0, b0, op0, sc0]  <- only x0, y0, z0 are useful
                                          5 floats wasted

SoA cache line (64 bytes = 16 floats):
[x0, x1, x2, x3, x4, x5, x6, x7,
 x8, x9, x10, x11, x12, x13, x14, x15]  <- all 16 floats useful
```

That is a 5x improvement in cache utilization for depth-only operations.

### Frame Data as SoA

For frame data (camera matrices, viewport dimensions), we use the same pattern:

```typescript
class FrameDataSoA {
  private data: Float32Array;
  private stride = 32;  // floats per frame

  getProjectionMatrix(frameIndex: number): Float32Array {
    const start = frameIndex * this.stride;
    return this.data.subarray(start, start + 16);
  }

  getCameraPosition(frameIndex: number): Float32Array {
    const start = frameIndex * this.stride + 16;
    return this.data.subarray(start, start + 3);
  }

  getCameraForward(frameIndex: number): Float32Array {
    const start = frameIndex * this.stride + 19;
    return this.data.subarray(start, start + 3);
  }
}
```

One flat array, accessed by frame index. No object allocation per frame.

---

## Bitfield State Packing

Each splat can be in various states: selected, hidden, locked, filtered, deleted. The
naive approach uses a boolean per state:

```typescript
// 5 bytes per splat
const selected = new Uint8Array(count);
const hidden = new Uint8Array(count);
const locked = new Uint8Array(count);
const filtered = new Uint8Array(count);
const deleted = new Uint8Array(count);

// For 1 million splats: 5 MB of state data
```

We pack all five flags into a single `Uint32`:

```typescript
const SELECTED  = 1 << 0;  // bit 0
const HIDDEN    = 1 << 1;  // bit 1
const LOCKED    = 1 << 2;  // bit 2
const FILTERED  = 1 << 3;  // bit 3
const DELETED   = 1 << 4;  // bit 4

// 4 bytes per splat (was 5 bytes)
const stateBuffer = new Uint32Array(count);

// For 1 million splats: 4 MB of state data (was 5 MB)
```

### Checking State

```typescript
function shouldRender(index: number): boolean {
  const bits = stateBuffer[index];
  return (bits & (HIDDEN | FILTERED | DELETED)) === 0;
}
```

A single bitwise AND checks three flags at once. The CPU evaluates this in one
instruction instead of three branches.

### Setting State

```typescript
function setSelected(index: number, value: boolean): void {
  if (value) {
    stateBuffer[index] |= SELECTED;
  } else {
    stateBuffer[index] &= ~SELECTED;
  }
}

function setHidden(index: number, value: boolean): void {
  if (value) {
    stateBuffer[index] |= HIDDEN;
  } else {
    stateBuffer[index] &= ~HIDDEN;
  }
}
```

This reduces state memory by 20% and makes GPU state checks a single bitwise operation.

---

## Inline MVP Projection

When projecting a splat from 3D world space to 2D screen space, the naive approach calls
a matrix library:

```typescript
// Slow: creates intermediate objects, multiple function calls
const viewPos = viewMatrix.multiply(worldPos);
const clipPos = projectionMatrix.multiply(viewPos);
const ndc = clipPos.divide(clipPos.w);
```

We do it inline with manual multiplication and add an early rejection:

```typescript
function projectSplat(
  px: number, py: number, pz: number,
  mvp: Float32Array
): { x: number; y: number; w: number } | null {
  // Manual 4x4 x 4x1 multiply (column-major)
  const w = mvp[3] * px + mvp[7] * py + mvp[11] * pz + mvp[15];

  // Splat is behind camera -- skip it
  if (w <= 0) return null;

  const x = mvp[0] * px + mvp[4] * py + mvp[8] * pz + mvp[12];
  const y = mvp[1] * px + mvp[5] * py + mvp[9] * pz + mvp[13];

  return { x: x / w, y: y / w, w };
}
```

### Why the w <= 0 Check Matters

Splats behind the camera have a negative or zero homogeneous coordinate. Without this
check, dividing by zero or negative `w` produces garbage screen positions. Rejecting them
early avoids wasted projection work and prevents division-by-zero errors.

### Performance Impact

For 1 million splats, this eliminates:
- 1 million object allocations (the intermediate vectors)
- 1 million function calls (matrix multiply)
- ~500,000 unnecessary projections (behind camera)

---

## Pre-Computed Sort Bin Weights

When doing CPU-based sorting (as a fallback), we use distance-based weight tiers to
prioritize nearby splats. Instead of computing weights on the fly, we pre-compute them
at initialization:

```typescript
const WEIGHTS = new Float32Array(5);

// Pre-compute at init time -- no branching during sort
WEIGHTS[0] = 40;  // closest bin
WEIGHTS[1] = 20;
WEIGHTS[2] = 8;
WEIGHTS[3] = 3;
WEIGHTS[4] = 1;   // farthest bin

function getSplatWeight(distanceIndex: number): number {
  return WEIGHTS[distanceIndex];
}
```

### Why Pre-Compute?

During sorting, we process millions of splats. A branch or multiplication per-splat
adds up:

```
Without pre-computation:
  for each splat:
    weight = computeWeight(distance)  // branch + multiply

With pre-computation:
  for each splat:
    weight = WEIGHTS[distanceIndex]   // single array lookup
```

Array lookup is always the same cost regardless of input. The branch predictor might
get it wrong sometimes, causing pipeline stalls. Pre-computation eliminates this entirely.

---

## Key Takeaways

1. **Chunk your data** -- 4096 splats per chunk with pre-computed AABBs
2. **Use SoA, not AoS** -- 5x better cache utilization for attribute-specific operations
3. **Pack state in bitfields** -- 5 flags in 4 bytes instead of 5 bytes
4. **Inline hot paths** -- manual MVP with early rejection, no library overhead
5. **Pre-compute what you can** -- avoid per-splat branching in tight loops

---

[Previous: File Loading & Decoding](./01-file-loading-decoding.md) | [Next: Memory & Buffer Management](./03-memory-management.md)
