# 12 -- Compute Pipeline Dirty Tracking

The compute pipeline has multiple stages (depth-key generation, tile binning, sorting,
etc.). Running all of them every frame is wasteful if nothing changed.

---

## The Problem

A typical frame runs these compute passes:

```
1. Depth-key generation
2. Tile binning
3. Tile depth range
4. Tile work queue
5. Frustum culling
6. Occlusion testing
7. Sorting
```

If the camera has not moved and no splats changed, every one of these passes produces
the same output as the previous frame. Running them again is pure waste.

---

## Dirty Pass Dispatch Skip

Each compute pass tracks whether its inputs changed. If not, the pass is skipped:

```typescript
class DirtyTracker {
  private dirtyFlags = new Map<string, boolean>();

  markDirty(passName: string): void {
    this.dirtyFlags.set(passName, true);
  }

  markClean(passName: string): void {
    this.dirtyFlags.set(passName, false);
  }

  isDirty(passName: string): boolean {
    return this.dirtyFlags.get(passName) ?? true;
  }
}
```

### What Triggers Dirtiness?

| Pass | Dirty When |
|---|---|
| Depth-key generation | Camera moved or rotated |
| Tile binning | Camera moved or splats changed |
| Tile depth range | Camera moved |
| Tile work queue | Camera moved or tile binning changed |
| Frustum culling | Camera moved |
| Occlusion testing | Camera moved or depth buffer changed |
| Sorting | Camera moved or splat positions changed |

### The Render Loop

```typescript
function renderFrame(frame: FrameData): void {
  if (dirtyTracker.isDirty("depthKey")) {
    runDepthKeyPass();
    dirtyTracker.markClean("depthKey");
  } else {
    stats.depthKeySkips++;
  }

  if (dirtyTracker.isDirty("tileBinning")) {
    runTileBinningPass();
    dirtyTracker.markClean("tileBinning");
  } else {
    stats.tileBinningSkips++;
  }

  if (dirtyTracker.isDirty("frustumCulling")) {
    runFrustumCullingPass();
    dirtyTracker.markClean("frustumCulling");
  } else {
    stats.frustumCullingSkips++;
  }

  // ... more passes ...

  renderSplats();
}
```

### The Impact

```
Camera moving:
  depthKey: DIRTY  -> run pass
  tileBinning: DIRTY -> run pass
  frustumCulling: DIRTY -> run pass
  Total: 3 passes run

Camera stationary, splats selected:
  depthKey: CLEAN -> skip pass
  tileBinning: DIRTY -> run pass (selection changed)
  frustumCulling: CLEAN -> skip pass
  Total: 1 pass run

Camera stationary, nothing changed:
  depthKey: CLEAN -> skip
  tileBinning: CLEAN -> skip
  frustumCulling: CLEAN -> skip
  Total: 0 passes run
```

---

## Resident Signature Change Detection

The streaming system rebuilds GPU-resident state when the "signature" changes. The
signature is a hash of the active set:

```typescript
function computeResidentSignature(
  activeChunks: Set<number>,
  lodLevels: Map<number, number>,
  splatCount: number,
  pageCount: number
): string {
  return [
    activeChunks.size,
    Array.from(activeChunks).sort().join(","),
    Array.from(lodLevels.entries()).sort().toString(),
    splatCount,
    pageCount,
  ].join("|");
}

const newSignature = computeResidentSignature(...);
if (newSignature !== lastSignature) {
  rebuildGpuResidentState();
  lastSignature = newSignature;
} else {
  stats.signatureSkips++;
}
```

### What Changes the Signature?

| Change | Signature Updates |
|---|---|
| New chunk loaded | Active chunks change |
| Chunk evicted | Active chunks change |
| LOD level changed | LOD levels change |
| Splat count changed | Count changes |
| Page allocation changed | Page count changes |

### What Does NOT Change the Signature?

| No Change | Signature Stays Same |
|---|---|
| Camera moves | Same chunks, same LODs |
| Splat selection changes | Same chunks, same LODs |
| Splat state changes | Same chunks, same LODs |

This is a powerful optimization: if the same chunks are loaded at the same LODs, the
GPU state does not need to be rebuilt, even if the camera moved.

---

## Combining Both Techniques

The two techniques work together:

```
Frame 1 (camera moves):
  Dirty tracking: depthKey DIRTY -> run depth-key pass
  Signature: same chunks, same LODs -> skip resident state rebuild
  Total: 1 compute pass + 0 rebuilds

Frame 2 (camera moves):
  Dirty tracking: depthKey DIRTY -> run depth-key pass
  Signature: same chunks, same LODs -> skip resident state rebuild
  Total: 1 compute pass + 0 rebuilds

Frame 3 (new chunk loaded):
  Dirty tracking: depthKey DIRTY -> run depth-key pass
  Signature: different chunks -> rebuild resident state
  Total: 1 compute pass + 1 rebuild
```

---

## Key Takeaways

1. **Dirty flags** -- track which passes have changed inputs
2. **Skip clean passes** -- do not run compute when nothing changed
3. **Resident signature** -- hash of active set, LODs, count, pages
4. **Rebuild only on change** -- skip GPU state rebuild when signature is same
5. **Combine both** -- dirty tracking skips individual passes, signature skips rebuilds

---

[Previous: Infrastructure & Error Handling](./11-infrastructure.md) | [Next: Summary](./13-summary.md)
