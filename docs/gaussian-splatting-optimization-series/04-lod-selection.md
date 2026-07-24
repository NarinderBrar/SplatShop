# 04 -- LOD Selection

A scene with 10 million Gaussians does not need to render all of them at once. If you are
zoomed out, you only need the coarse representation. If you are zoomed in, you need detail
in the center and can skip the edges. This is **Level of Detail (LOD)** selection.

---

## The Hierarchical LOD Tree

The scene is organized as a tree. At the top is the root node containing the entire scene.
It has children for spatial regions, and each child can have its own children. Each node
stores multiple LOD levels:

```
Root (LOD0: 50k splats, LOD1: 10k splats, LOD2: 2k splats)
+-- North Region
|   +-- North-East (LOD0: 8k, LOD1: 2k)
|   +-- North-West (LOD0: 7k, LOD1: 1.5k)
+-- South Region
    +-- South-East (LOD0: 9k, LOD1: 2.5k)
    +-- South-West (LOD0: 6k, LOD1: 1k)
```

LOD0 is the finest (most splats). LOD2 is the coarsest (fewest splats). The LOD selector
picks the right level for each node based on how much of the screen it covers and how many
splats the budget allows.

---

## Budget-Aware Greedy Selection

We have a splat budget -- say 500,000 splats for interactive rendering. The LOD selector
starts at the coarsest level for every node and iteratively upgrades nodes to finer LODs:

```typescript
function selectLod(
  nodes: LodNode[],
  budget: number,
  camera: Camera
): SelectedLod[] {
  const selected: SelectedLod[] = [];

  // Start at coarsest LOD for every node
  for (const node of nodes) {
    selected.push({
      node,
      lodLevel: node.lodLevels.length - 1,
      score: computeScore(node, camera),
    });
  }

  let remainingBudget = budget;

  // Iteratively upgrade the best candidate
  while (remainingBudget > 0) {
    let bestCandidate = null;
    let bestRatio = -Infinity;

    for (const entry of selected) {
      if (entry.lodLevel === 0) continue;

      const finerLod = entry.lodLevel - 1;
      const cost = entry.node.lodCounts[entry.lodLevel]
                 - entry.node.lodCounts[finerLod];
      const score = entry.score;
      const ratio = score / Math.pow(cost, 0.55);

      if (ratio > bestRatio && cost <= remainingBudget) {
        bestRatio = ratio;
        bestCandidate = entry;
      }
    }

    if (!bestCandidate) break;

    bestCandidate.lodLevel--;
    remainingBudget -= /* cost of upgrade */;
  }

  return selected;
}
```

### The cost^0.55 Scaling

The `cost^0.55` factor is important. It makes cheap upgrades (small increase in splats
for big quality gain) look more attractive than expensive ones:

```
Node A: cost=1000, score=5000  -> ratio = 5000 / 1000^0.55 = 132
Node B: cost=5000, score=8000  -> ratio = 8000 / 5000^0.55 = 71
```

Node A gets upgraded first despite having lower absolute score, because its cost/ratio
is better. This squeezes the most quality out of a fixed budget.

---

## Foveated Rendering

Humans only see sharp detail in the center of their vision (the fovea). Everything in the
periphery is blurry. We exploit this by giving lower priority to peripheral nodes:

```typescript
function getFoveationWeight(
  nodeCenter: Vec3,
  camera: Camera,
  coneAngle: number,
  behindAngle: number
): number {
  const toNode = normalize(subtract(nodeCenter, camera.position));
  const forward = camera.forward;
  const dot = dotProduct(toNode, forward);

  // Node is behind camera -- heavy penalty
  if (dot < 0) {
    return Math.max(0, 1 + dot / behindAngle);
  }

  // Node is in peripheral vision -- mild penalty
  const angle = Math.acos(dot);
  if (angle > coneAngle) {
    return Math.max(0.1, 1 - (angle - coneAngle) / (Math.PI / 2 - coneAngle));
  }

  return 1.0;
}
```

```
           Peripheral
              /
             /
            /  (reduced priority)
   --------*---------> Camera forward
            \
             \
              \
           Peripheral

Foveal cone: full priority
Outside cone: reduced priority
Behind camera: near-zero priority
```

Nodes directly in front of the camera get full priority. Nodes off to the side get reduced
priority. Nodes behind the camera get nearly zero priority. This means the budget is spent
on the splats you actually see, not on background details.

---

## Hysteresis to Prevent Flickering

Without hysteresis, LOD selection can flicker at boundaries. A node at the edge of the
budget alternates between LOD1 and LOD2 every frame, causing visible popping.

```typescript
const HYSTERESIS_BOOST = 1.15;

for (const entry of candidates) {
  if (entry.wasSelectedLastFrame) {
    entry.score *= HYSTERESIS_BOOST;
  }
}
```

A 15% boost is enough to prevent thrashing while still allowing transitions when the camera
moves significantly.

```
Without hysteresis:
Frame 1: Node at LOD1 (score 100 > budget threshold 95)
Frame 2: Node at LOD2 (score 90 < budget threshold 95)
Frame 3: Node at LOD1 (score 100 > budget threshold 95)
... flickering ...

With hysteresis:
Frame 1: Node at LOD1 (score 100 * 1.15 = 115 > 95)
Frame 2: Node at LOD1 (score 115 > 95) -- stays at LOD1
Frame 3: Node at LOD1 (score 115 > 95) -- stays at LOD1
... stable ...
```

---

## Forced Fine-Detail Upgrade

Some nodes dominate the screen -- you are looking right at them. Even if the budget is
tight, these nodes should get the finest LOD:

```typescript
const FORCE_FINE_RATIO = 0.3;

for (const entry of candidates) {
  const screenCoverage = computeScreenCoverage(entry.node, camera);

  if (screenCoverage > FORCE_FINE_RATIO) {
    entry.lodLevel = 0;
    budget -= entry.node.lodCounts[0];
  }
}
```

If a node covers more than 30% of the screen, it gets full detail. This ensures close-up
quality even in budget-constrained scenarios.

---

## Incremental LOD Upgrade

The upgrade loop picks the best candidate each iteration. But we can improve it by
considering how many iterations remain:

```typescript
while (remainingBudget > 0 && iterations < maxIterations) {
  let bestCandidate = null;
  let bestRatio = -Infinity;

  for (const entry of selected) {
    if (entry.lodLevel === 0) continue;

    const finerLod = entry.lodLevel - 1;
    const cost = entry.node.lodCounts[entry.lodLevel]
               - entry.node.lodCounts[finerLod];

    // cost^0.55 favors cheap upgrades
    const ratio = entry.score / Math.pow(cost, 0.55);

    if (ratio > bestRatio && cost <= remainingBudget) {
      bestRatio = ratio;
      bestCandidate = entry;
    }
  }

  if (!bestCandidate) break;

  bestCandidate.lodLevel--;
  remainingBudget -= /* cost */;
  iterations++;
}
```

The loop terminates when:
- Budget is exhausted
- All nodes are at LOD0 (finest)
- No upgrade fits the remaining budget

---

## WASM-Accelerated LOD Traversal

LOD selection for millions of splats across hundreds of nodes is CPU-intensive. We compile
the core algorithm from Rust to WebAssembly and run it in a Web Worker:

```typescript
class LodTraversalWorker {
  private wasmReady: Promise<typeof import("./ssog_lod_traversal")>;

  constructor() {
    this.wasmReady = initWasm("ssog_lod_traversal_bg.wasm");
  }

  async selectLod(params: LodParams): Promise<Uint32Array> {
    const wasm = await this.wasmReady;

    const inputPtr = wasm.allocate(params.serializedData);
    const outputPtr = wasm.select_ssog_lod(inputPtr, params.budget);
    const result = wasm.getOutput(outputPtr);

    return result;
  }
}
```

### Why WASM?

- **Near-native speed**: WASM runs at ~80-90% of native Rust speed
- **No main thread blocking**: The Web Worker keeps the UI responsive
- **Zero-copy transfer**: Results are transferred via `postMessage` with transferable buffers

```typescript
// In the worker
self.onmessage = (e) => {
  const result = selectLod(e.data);
  self.postMessage({ result }, [result.buffer]);  // Transfer, don't copy
};
```

---

## Transferable Output Buffers

When the Worker sends results back to the main thread, we use transferable buffers.
Instead of copying the data, ownership is transferred:

```
Without transfer:
  Worker: [result buffer]
  Main thread: [copy of result buffer]  <- expensive copy

With transfer:
  Worker: [result buffer] --transferred--> Main thread: [result buffer]
  Worker no longer has access
```

This is a zero-copy operation. For large result arrays (millions of indices), this
eliminates a significant copy cost.

---

## LOD Selection Throttling

LOD selection does not need to run every frame. If the camera has not moved, the same
LODs are still correct:

```typescript
const LOD_SELECT_INTERVAL = 15;
let framesSinceLastSelect = 0;
let lastCameraPosition: Vec3;
let lastCameraForward: Vec3;

function maybeRunLodSelection(camera: Camera): void {
  framesSinceLastSelect++;

  const moved = distance(camera.position, lastCameraPosition) > 0.01;
  const turned = dotProduct(camera.forward, lastCameraForward) < 0.999;

  if (framesSinceLastSelect >= LOD_SELECT_INTERVAL || moved || turned) {
    runLodSelection(camera);
    framesSinceLastSelect = 0;
    lastCameraPosition = camera.position.clone();
    lastCameraForward = camera.forward.clone();
  }
}
```

This runs LOD selection at most once every 15 frames, and only when the camera actually
moves. That is a 15x reduction in LOD computation cost for static scenes.

---

## Chunk Fallback During Streaming

When the LOD selector picks a fine-detail chunk that has not finished loading yet, we do
not show a hole. Instead, we display the coarsest already-loaded chunk as a placeholder:

```
Frame 1: LOD selector picks chunk A at LOD0 (finest)
Frame 2: Chunk A is still loading, show chunk A at LOD2 (coarsest loaded)
Frame 3: Chunk A finishes loading -- seamlessly switch to LOD0
```

This ensures the viewer always has something to show, even during streaming.

---

## Key Takeaways

1. **Hierarchical tree** -- organize splats into nodes with multiple LOD levels
2. **Budget-aware greedy** -- iteratively upgrade the best cost/ratio candidate
3. **Foveated weighting** -- prioritize what the user is looking at
4. **Hysteresis** -- prevent flickering at LOD boundaries
5. **WASM acceleration** -- offload heavy computation to a Worker at near-native speed
6. **Throttle** -- run selection every 15 frames, only on camera movement

---

[Previous: Memory & Buffer Management](./03-memory-management.md) | [Next: Visibility & Culling](./05-visibility-culling.md)
