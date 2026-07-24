# 09 -- Streaming & Page Management

For large scenes, not all data fits in GPU memory. We stream chunks on demand and manage
GPU memory pages to keep everything running smoothly.

---

## The Problem

A large scene might have 50 million Gaussians stored on disk. The GPU can only hold
maybe 5 million in memory at once. We need to:

1. Load chunks from disk as the camera moves
2. Unload chunks that are no longer visible
3. Manage GPU memory like an operating system manages RAM

```
Disk: [50 million splats across 12,000 chunks]
GPU:  [500 chunks resident in memory]
User: looking at a small region -> only 200 chunks are visible
```

---

## GPU Page Pool

GPU memory is divided into fixed-size pages. A page pool manages allocation:

```typescript
class GpuPagePool {
  private pages: GPUBuffer[];
  private free: boolean[];
  private pageSize: number;

  allocate(): number {
    for (let i = 0; i < this.free.length; i++) {
      if (this.free[i]) {
        this.free[i] = false;
        return i;
      }
    }
    return this.evict();
  }

  freePage(pageIndex: number): void {
    this.free[pageIndex] = true;
  }

  private evict(): number {
    const victim = this.findEvictionTarget();
    this.free[victim] = false;
    return victim;
  }
}
```

### First-Fit Allocation

First-fit scans the free list and returns the first available page. It is simple and
fast:

```
Pages: [used] [free] [used] [free] [free] [used]
                    ^
                    first-fit returns this one
```

### Fragmentation Tracking

Over time, free pages can become scattered. We track fragmentation:

```typescript
getFragmentationStats(): {
  largestFreeRun: number;
  fragmentationRatio: number;
} {
  let largestRun = 0;
  let currentRun = 0;

  for (const isFree of this.free) {
    if (isFree) {
      currentRun++;
      largestRun = Math.max(largestRun, currentRun);
    } else {
      currentRun = 0;
    }
  }

  const totalFree = this.free.filter(f => f).length;
  const fragmentationRatio = 1 - (largestRun / totalFree);

  return { largestFreeRun: largestRun, fragmentationRatio };
}
```

---

## Page Eviction with Pressure Tracking

When the pool runs out of free pages, we evict old pages. Eviction targets are chosen
based on residency pressure:

```typescript
class PageEviction {
  private allocationRequests = 0;
  private overflowRequests = 0;
  private freedPages = 0;

  recordAllocation(): void {
    this.allocationRequests++;
  }

  recordOverflow(): void {
    this.overflowRequests++;
  }

  recordFree(): void {
    this.freedPages++;
  }

  getPressure(): number {
    if (this.allocationRequests === 0) return 0;
    return this.overflowRequests / this.allocationRequests;
  }

  findEvictionTarget(pages: Page[]): number {
    // Find the page with lowest priority
    let minPriority = Infinity;
    let victim = -1;

    for (let i = 0; i < pages.length; i++) {
      if (!pages[i].isFree && pages[i].priority < minPriority) {
        minPriority = pages[i].priority;
        victim = i;
      }
    }

    return victim;
  }
}
```

### Pressure Metrics

```
allocationRequests: 1000  (total allocation attempts)
overflowRequests:   100   (times we had to evict)
freedPages:         50    (times pages were voluntarily freed)

Pressure: 100/1000 = 0.1  (10% of allocations required eviction)
```

High pressure means the GPU memory is undersized for the current view. The quality
system can use this to reduce the splat budget.

---

## Upload Budget Throttling

Uploading too much data in one frame causes a stall. We limit uploads to a budget:

```typescript
class UploadBudget {
  private maxBytesPerFrame: number;
  private maxChunksPerFrame: number;
  private bytesThisFrame = 0;
  private chunksThisFrame = 0;

  canUpload(chunkSize: number): boolean {
    if (this.bytesThisFrame + chunkSize > this.maxBytesPerFrame) return false;
    if (this.chunksThisFrame >= this.maxChunksPerFrame) return false;

    this.bytesThisFrame += chunkSize;
    this.chunksThisFrame++;
    return true;
  }

  reset(): void {
    this.bytesThisFrame = 0;
    this.chunksThisFrame = 0;
  }
}
```

### Budget Examples

```
Typical budget: 4 MB per frame, 8 chunks per frame

Frame 1: upload 3 chunks (2.5 MB) -> OK
Frame 2: upload 8 chunks (4 MB) -> at limit
Frame 3: upload 0 chunks (waiting for budget reset)
Frame 4: upload 5 chunks (3.2 MB) -> OK
```

This ensures uploads spread across multiple frames, avoiding hitches.

---

## Stale Chunk Dropping

While chunks are queued for upload, the LOD selector might decide they are no longer
needed. We drop them to free bandwidth:

```typescript
function dropStaleChunks(
  queue: ChunkUpload[],
  currentLodSelection: Set<number>
): ChunkUpload[] {
  return queue.filter(upload => {
    return currentLodSelection.has(upload.chunkId);
  });
}
```

### When Chunks Become Stale

```
Frame 1: LOD selector picks chunks A, B, C for upload
Frame 2: Camera moves, LOD selector now picks B, C, D
Frame 3: Chunk A is stale -> drop it from upload queue
```

If a chunk was queued but the camera moved away, we skip the upload entirely. This
prevents wasted bandwidth on chunks that would immediately be replaced.

---

## Pre-Upload GPU Eviction

Before uploading new chunks, we ensure there is space by evicting old pages:

```typescript
function ensureSpace(pool: GpuPagePool, needed: number): void {
  let freeCount = pool.freeCount;

  while (freeCount < needed) {
    pool.evict();
    freeCount++;
  }
}
```

### Why Evict Before Upload?

If we try to upload without checking for space, we might run out mid-upload:

```
Without pre-eviction:
  Upload chunk 1: OK
  Upload chunk 2: OK
  Upload chunk 3: OUT OF MEMORY -> corrupt state

With pre-eviction:
  Ensure 3 free pages: evict old pages if needed
  Upload chunk 1: OK
  Upload chunk 2: OK
  Upload chunk 3: OK
```

---

## Chunk Load Prioritization

Chunks are not all equally important. Nearby, large, screen-dominant chunks matter more
than distant, small ones:

```typescript
function prioritizeChunks(
  chunks: Chunk[],
  camera: Camera
): Chunk[] {
  return chunks.sort((a, b) => {
    return computePriority(b, camera) - computePriority(a, camera);
  });
}

function computePriority(chunk: Chunk, camera: Camera): number {
  const distance = chunk.aabb.distanceTo(camera.position);
  const screenSize = chunk.aabb.screenArea(camera);
  return screenSize / (distance + 1);
}
```

### Priority Formula

```
priority = screenSize / (distance + 1)

Chunk A: screenArea=1000, distance=5m  -> priority = 167
Chunk B: screenArea=500, distance=2m   -> priority = 167
Chunk C: screenArea=100, distance=50m  -> priority = 2
```

Chunks that are close and cover a large screen area are loaded first. This ensures the
most visually important data arrives before less important data.

### Hysteresis in Prioritization

We add hysteresis to prevent thrashing:

```typescript
function prioritizeWithHysteresis(
  chunks: Chunk[],
  camera: Camera,
  previouslyLoaded: Set<number>
): Chunk[] {
  return chunks.sort((a, b) => {
    let scoreA = computePriority(a, camera);
    let scoreB = computePriority(b, camera);

    // Boost already-loaded chunks
    if (previouslyLoaded.has(a.id)) scoreA *= 1.1;
    if (previouslyLoaded.has(b.id)) scoreB *= 1.1;

    return scoreB - scoreA;
  });
}
```

Already-loaded chunks get a 10% boost, preventing them from being evicted and reloaded
at the boundary.

---

## LOD Transition Locking

When the camera moves near a node boundary, the LOD selector might rapidly switch
between LOD levels of adjacent nodes. This causes visible thrashing:

```
Without locking:
Frame 1: Node A at LOD0, Node B at LOD2
Frame 2: Node A at LOD2, Node B at LOD0  (swapped!)
Frame 3: Node A at LOD0, Node B at LOD2  (swapped back!)
... thrashing ...
```

We lock transitions:

```typescript
class TransitionLock {
  private lockUntil = 0;

  lock(durationMs: number): void {
    this.lockUntil = performance.now() + durationMs;
  }

  isLocked(): boolean {
    return performance.now() < this.lockUntil;
  }
}
```

During a lock, LOD selections are frozen. This gives the streaming system time to load
the new LOD level before the transition happens.

---

## The Streaming Pipeline

```
1. LOD selector picks chunks
         |
2. Prioritize by distance and screen size
         |
3. Drop stale chunks from upload queue
         |
4. Check upload budget (bytes + chunk count)
         |
5. Ensure GPU space (evict if needed)
         |
6. Upload chunk data to GPU
         |
7. Update page residency tracking
```

Each step is throttled and prioritized to prevent frame stalls.

---

## Key Takeaways

1. **Page pool** -- fixed-size GPU memory allocator with first-fit
2. **Eviction** -- remove low-priority pages when memory is full
3. **Upload budget** -- limit bytes and chunks per frame
4. **Stale dropping** -- skip uploads for chunks no longer needed
5. **Prioritization** -- load close, large, screen-dominant chunks first
6. **Transition locking** -- prevent LOD thrashing at node boundaries

---

[Previous: Compute Tile Pipeline](./08-compute-tile-pipeline.md) | [Next: Rendering Pipeline](./10-rendering-pipeline.md)
