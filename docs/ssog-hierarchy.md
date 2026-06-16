# SSOG Node / Chunk / LOD Hierarchy

## Overview

SSOG (Streaming SOG) is a hierarchical LOD splat format. The scene is organized as a tree of spatial subdivisions (nodes), where each node has multiple LOD levels stored as chunk entries pointing to byte ranges in packed files.

## Data Model

```
SSOG Scene
 └── Tree root node (nodeId=0, depth=0)
      ├── Child node (nodeId=1, depth=1)
      │    ├── LOD 2 chunk (coarsest, fewest splats)
      │    ├── LOD 1 chunk
      │    └── LOD 0 chunk (finest, most splats)
      ├── Child node (nodeId=2, depth=1)
      │    ├── LOD 2 chunk
      │    ├── LOD 1 chunk
      │    └── LOD 0 chunk
      └── Child node (nodeId=3, depth=1)
           └── LOD 0 chunk (only one level)
```

## Concepts

### Node

A spatial subdivision of the scene with a bounding box (`SsogBound`). Nodes form a parent-child tree via `parentNodeId`. Assigned a unique `nodeId` during DFS traversal in `collectSsogEntries` (`src/io/read/loader.ts:317`).

Each node represents a fixed spatial region — its bounding box is the union of all splat positions within that region.

### LOD (Level of Detail)

Integer key on each node. `0` = finest detail (highest splat count), increasing integers = progressively coarser approximations of the same spatial region.

The scene may contain nodes with different LOD counts. Some nodes may only have LOD 0, others may have 2–3 levels.

LOD level is independent across nodes — one node's LOD 1 is not related to another node's LOD 1 except by convention.

### Chunk Entry

The concrete byte-range payload for one (nodeId, LOD) pair:

```
{ nodeId, parentNodeId?, depth, fileIndex, offset, count, lod, bound }
```

- `fileIndex`, `offset`, `count` — location in a packed binary file
- `bound` — the node's axis-aligned bounding box (shared by all LODs of that node)
- Each node can have 0+ chunk entries (one per LOD that exists)

## Relationships

| Relationship | Cardinality | Description |
|---|---|---|
| Scene → Node | 1:N | The metadata tree is traversed to produce a flat list of nodes |
| Node → LOD entries | 1:N | Each node may have multiple LOD entries (same `nodeId`, different `lod`) |
| Node ↔ Parent | N:1 | Child nodes reference `parentNodeId`; root has no parent |
| LOD entry → File slot | N:1 | Multiple entries can reference the same `fileIndex` |
| (nodeId, lod) → chunk | 1:1 | Each combination maps to exactly one byte range payload |

## How the Renderer Uses This

### LOD Selection (`selectSsogLod` in `src/splat/SsogLodSelector.ts`)

1. Groups all entries by `nodeId`
2. For each node, starts at the **coarsest** LOD (highest `lod` number)
3. Upgrades nodes to finer LODs as the splat budget allows
4. Produces a set of `(nodeId, lod)` pairs that fit within budget

### Fallback (`getCoarsestEntryForNode` in `src/rendering/StreamingSsogRenderPass.ts`)

```typescript
private getCoarsestEntryForNode(nodeId: number): SsogChunkEntry | undefined {
    return this.entries
      .filter((entry) => entry.nodeId === nodeId)
      .sort((a, b) => b.lod - a.lod || a.count - b.count)[0];
}
```

When a finer LOD chunk is selected but not yet loaded, the coarsest loaded entry for that `nodeId` stays active as a visible placeholder. This prevents holes during streaming.

### Frustum Culling

Chunk entries are culled by their `bound` (AABB). Since all LODs of a node share the same bound, they all pass or fail frustum culling together — LOD selection then decides which level to use within the visible set.

## Key Code Locations

| What | File |
|---|---|
| Entry collection from metadata tree | `src/io/read/loader.ts:307` |
| SsogChunkEntry type | `src/splat/SplatAsset.ts:71` |
| LOD selection algorithm | `src/splat/SsogLodSelector.ts:78` |
| Fallback by coarsest entry | `src/rendering/StreamingSsogRenderPass.ts:1157` |
| Stabilization (transition locks) | `src/rendering/StreamingSsogRenderPass.ts:977` |
