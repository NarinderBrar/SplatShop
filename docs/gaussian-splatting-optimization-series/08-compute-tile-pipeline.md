# 08 -- Compute Tile Pipeline

Once splats are sorted, we need to figure out which screen tiles each splat covers.
This is done entirely on the GPU using compute shaders.

---

## Screen Tiles

The screen is divided into tiles, typically 16x16 pixels each. A 1920x1080 screen has
120 x 68 = 8160 tiles. Each tile tracks which splats overlap it.

```
Screen (1920x1080)
+------+------+------+------+
|Tile  |Tile  |Tile  |Tile  |
| 0,0  | 1,0  | 2,0  | 3,0  |
+------+------+------+------+
|Tile  |Tile  |Tile  |Tile  |
| 0,1  | 1,1  | 2,1  | 3,1  |
+------+------+------+------+
```

### Why Tiles?

Each tile is rendered independently. This enables:
- Parallel processing (each tile is a separate work unit)
- Front-to-back ordering (tiles closer to camera are processed first)
- Per-tile statistics (how many splats per tile, depth range, etc.)

---

## GPU Depth-Key Generation

First, we project each splat center onto the screen and compute a depth key:

```wgsl
@compute @workgroup_size(256)
fn generateDepthKeys(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= splatCount) { return; }

  let worldPos = vec4<f32>(positions[gid.x], 1.0);
  let clipPos = mvp * worldPos;

  if (clipPos.w <= 0.0) {
    depthKeys[gid.x] = 0xFFFFFFFFu;
    return;
  }

  let depth = (clipPos.w - nearPlane) / (farPlane - nearPlane);
  depthKeys[gid.x] = u32(clamp(depth, 0.0, 1.0) * 1048575.0);
}
```

### What Is a Depth Key?

A depth key is a quantized representation of how far each splat is from the camera.
We use 20 bits, giving 1,048,576 distinct depth levels. This is precise enough for
correct sorting while fitting in a single 32-bit integer.

```
Splat at 5m:  depth = 5/near = 0.25  -> key = 0.25 * 1048575 = 262143
Splat at 10m: depth = 10/near = 0.5  -> key = 0.5 * 1048575 = 524287
Splat at 20m: depth = 20/near = 1.0  -> key = 1.0 * 1048575 = 1048575
```

---

## GPU Tile Binning

We scatter each splat into the tiles it covers:

```wgsl
@compute @workgroup_size(256)
fn binSplats(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= splatCount) { return; }

  let screenPos = projectedPositions[gid.x];
  let tileX = clamp(u32(screenPos.x / TILE_SIZE), 0u, tilesX - 1u);
  let tileY = clamp(u32(screenPos.y / TILE_SIZE), 0u, tilesY - 1u);

  let tileIndex = tileY * tilesX + tileX;

  let slot = atomicAdd(&tileCounts[tileIndex], 1u);
  if (slot < MAX_SPLATS_PER_TILE) {
    tileSplatLists[tileIndex * MAX_SPLATS_PER_TILE + slot] = gid.x;
  }
}
```

### How It Works

```
Splat at screen position (100, 50):
  tileX = 100 / 16 = 6
  tileY = 50 / 16 = 3
  tileIndex = 3 * 120 + 6 = 366

  -> Add splat to tile 366's list
```

Each splat is added to exactly one tile (the tile containing its center). The atomic
counter ensures thread-safe writes.

---

## GPU Tile Statistics

After binning, we compute per-tile statistics:

```wgsl
@compute @workgroup_size(256)
fn computeTileStats(@builtin(global_invocation_id) gid: vec3<u32>) {
  let tileIndex = gid.x;
  if (tileIndex >= tileCount) { return; }

  let count = tileCounts[tileIndex];

  // Skip empty tiles
  if (count == 0u) {
    tileStats[tileIndex] = TileStats(0u, 0u, 0u);
    return;
  }

  var behindCount = 0u;
  var overflowCount = 0u;

  for (var i = 0u; i < count; i++) {
    let splatIdx = tileSplatLists[tileIndex * MAX_SPLATS_PER_TILE + i];

    if (depthKeys[splatIdx] == 0xFFFFFFFFu) {
      behindCount++;
    }
    if (i >= MAX_SPLATS_PER_TILE) {
      overflowCount++;
    }
  }

  tileStats[tileIndex] = TileStats(count, behindCount, overflowCount);
}
```

---

## GPU Tile Depth Range

We compute the min and max depth per tile for front-to-back ordering:

```wgsl
@compute @workgroup_size(256)
fn computeTileDepthRange(@builtin(global_invocation_id) gid: vec3<u32>) {
  let tileIndex = gid.x;
  if (tileIndex >= tileCount) { return; }

  let count = tileCounts[tileIndex];
  if (count == 0u) { return; }

  var minDepth = 1e30;
  var maxDepth = 0.0;

  for (var i = 0u; i < count; i++) {
    let splatIdx = tileSplatLists[tileIndex * MAX_SPLATS_PER_TILE + i];
    let d = f32(depthKeys[splatIdx]);
    minDepth = min(minDepth, d);
    maxDepth = max(maxDepth, d);
  }

  tileMinDepth[tileIndex] = minDepth;
  tileMaxDepth[tileIndex] = maxDepth;
}
```

### Why Depth Range?

Tiles closer to the camera should be processed first (front-to-back). The depth range
tells us where each tile sits in depth space.

```
Tile A: depth range [100, 200]  (close)
Tile B: depth range [500, 800]  (far)

Process Tile A first, then Tile B
```

---

## GPU Tile Work Queue

We build an ordered work queue of tiles, sorted by depth. This is a multi-phase
process:

### Phase 1: Depth-Band Scatter

```wgsl
@compute @workgroup_size(256)
fn scatterToBands(@builtin(global_invocation_id) gid: vec3<u32>) {
  let tileIndex = gid.x;
  if (tileIndex >= tileCount) { return; }

  let count = tileCounts[tileIndex];
  if (count == 0u) { return; }

  let depth = tileMinDepth[tileIndex];
  let band = u32(depth * f32(depthBandCount));

  let slot = atomicAdd(&bandCounts[band], 1u);
  workQueue[band * maxTilesPerBand + slot] = tileIndex;
}
```

### Phase 2: Stable Sort Within Bands

Tiles within the same depth band are sorted by their exact depth:

```wgsl
@compute @workgroup_size(256)
fn sortWithinBands(@builtin(global_invocation_id) gid: vec3<u32>) {
  let band = gid.x;
  if (band >= depthBandCount) { return; }

  let count = bandCounts[band];
  if (count <= 1u) { return; }

  // Simple insertion sort for small arrays
  let start = band * maxTilesPerBand;
  for (var i = 1u; i < count; i++) {
    let key = workQueue[start + i];
    let keyDepth = tileMinDepth[key];
    var j = i;

    while (j > 0u && tileMinDepth[workQueue[start + j - 1u]] > keyDepth) {
      workQueue[start + j] = workQueue[start + j - 1u];
      j--;
    }

    workQueue[start + j] = key;
  }
}
```

### Phase 3: Compaction

We compact the band-based queue into a single ordered list:

```wgsl
@compute @workgroup_size(256)
fn compactQueue(@builtin(global_invocation_id) gid: vec3<u32>) {
  let band = gid.x;
  if (band >= depthBandCount) { return; }

  let count = bandCounts[band];
  var offset = 0u;

  // Compute offset from previous bands
  for (var b = 0u; b < band; b++) {
    offset += bandCounts[b];
  }

  // Copy tiles to final position
  let srcStart = band * maxTilesPerBand;
  for (var i = 0u; i < count; i++) {
    orderedQueue[offset + i] = workQueue[srcStart + i];
  }
}
```

### The Result

```
Before: [Tile B (far), Tile A (near), Tile D (mid), Tile C (near-mid)]
After:  [Tile A (near), Tile C (near-mid), Tile D (mid), Tile B (far)]
```

---

## GPU Tile Depth Ordering

An alternative to the work queue is a histogram-based ordering:

```wgsl
@compute @workgroup_size(256)
fn orderTilesByDepth(@builtin(global_invocation_id) gid: vec3<u32>) {
  let tileIndex = gid.x;
  if (tileIndex >= tileCount) { return; }

  let count = tileCounts[tileIndex];
  if (count == 0u) { return; }

  let depth = tileMinDepth[tileIndex];
  let bin = u32(depth * f32(orderBinCount));

  let slot = atomicAdd(&orderBinCounts[bin], 1u);
  orderedTileList[bin * maxTilesPerBin + slot] = tileIndex;
}
```

This uses histogram + prefix-sum + scatter for tile-level depth-binned order. It enables
both front-to-back and back-to-front tile processing.

---

## Color Segmentation

Splats with similar colors can be batched together for more efficient rendering:

```wgsl
@compute @workgroup_size(256)
fn segmentColors(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= splatCount) { return; }

  let color = colors[gid.x];

  // Quantize each channel to 4 bits (16 levels per channel)
  let r = u32(color.r * 15.0) << 8;
  let g = u32(color.g * 15.0) << 4;
  let b = u32(color.b * 15.0);

  colorSegments[gid.x] = r | g | b;  // 64 possible groups
}
```

### Why Color Segmentation?

When rendering, splats with the same color can share the same color uniform. This
reduces state changes between draw calls and improves GPU utilization.

```
Without segmentation:
  [red splat] [blue splat] [red splat] [green splat]
  -> 4 state changes

With segmentation:
  [red splat] [red splat] [blue splat] [green splat]
  -> 3 state changes (red batched)
```

---

## Tile Pipeline Throttling

The tile pipeline does not need to run every frame for static scenes:

```typescript
function shouldUpdateTiles(
  frameCount: number,
  cameraMoved: boolean
): boolean {
  if (!cameraMoved) return frameCount % 30 === 0;
  return frameCount % 3 === 0;
}
```

When the camera is stationary, tile binning runs every 30 frames. When moving, every 3rd
frame. This saves significant GPU compute time.

---

## Empty Tile Compaction

Many tiles have zero splats. We skip them entirely:

```wgsl
@compute @workgroup_size(256)
fn compactTiles(@builtin(global_invocation_id) gid: vec3<u32>) {
  let tileIndex = gid.x;
  if (tileIndex >= tileCount) { return; }

  if (tileCounts[tileIndex] > 0u) {
    let idx = atomicAdd(&compactCount, 1u);
    compactedTiles[idx] = tileIndex;
  }
}
```

For a 1920x1080 screen, roughly 30-50% of tiles are empty. Skipping them saves
30-50% of the tile processing work.

---

## Adaptive Tile Work Queue Budget

The work queue uses coverage targets and budget caps:

```typescript
class TileBudget {
  private explicitBudget: number;
  private coverageTarget: number;

  shouldProcessTile(tile: Tile): boolean {
    if (this.processedCount >= this.explicitBudget) return false;

    const coverage = tile.splatCount / this.totalSplats;
    if (coverage < this.coverageTarget) return false;

    return true;
  }
}
```

The budget prevents processing too many tiles per frame. The coverage target ensures
we only process tiles that have meaningful splat density.

---

## Key Takeaways

1. **Depth-key generation** -- project splat centers, quantize to 20-bit keys
2. **Tile binning** -- scatter splats into 16x16 pixel tiles with atomic counters
3. **Depth range** -- per-tile min/max depth for ordering
4. **Work queue** -- multi-phase: scatter, sort, compact
5. **Color segmentation** -- quantize colors for draw-call batching
6. **Throttling** -- run every N frames for static scenes
7. **Empty tile compaction** -- skip tiles with zero occupancy

---

[Previous: GPU Sorting](./07-gpu-sorting.md) | [Next: Streaming & Page Management](./09-streaming-page-management.md)
