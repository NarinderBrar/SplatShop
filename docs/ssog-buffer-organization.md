# SSOG Buffer Organization

How GPU/CPU buffers are organized when rendering splats on the SSOG path.

## Overview

SSOG rendering is **chunk-based**. Splats are never one flat global array on disk; they stream as packed chunks, each with its own `SogPackedData`, then get uploaded into GPU storage depending on `ssogGlobalSort` mode.

---

## 1. Per-chunk packed layout (`SogPackedData` → `SogBuffers`)

Each decoded chunk stores **SoA packed attributes**, not expanded floats:

| Field | Type | Role |
|---|---|---|
| `meansL` / `meansU` | `Uint32Array` (1 u32/splat each) | Quantized XYZ, low/high bytes |
| `quats` | `Uint32Array` | Packed rotation (RGBA-style) |
| `scales` | `Uint32Array` | Scale indices into codebook |
| `sh0` | `Uint32Array` | DC color indices |
| `scaleCodebook` / `sh0Codebook` | `Float32Array` | Shared decode tables |
| `centers` | `Float32Array` (xyz) | Decoded centers for sort/cull |
| `meansMins` / `meansMaxs` | vec3 | Dequantization range |
| optional `shN` | centroids/labels/codebook | Higher SH bands |

On GPU, `SogBuffers` (`src/splat/SogBuffers.ts`) turns that into storage buffers (often via `GpuBufferWriter` arena under pool key `"ssog-streaming-chunk"`):

```text
meansL, meansU, quats, scales, sh0, color, state,
scaleCodebook, sh0Codebook, centers,
depthKeys, sortBucketCounts/Offsets, sortScratchIndices, indices
(+ optional shN*)
```

Arena allocations can share large backing buffers; `storageOffsets` tracks each attribute’s element offset into that arena.

### Related types

- `SogPackedData` — `src/splat/SplatAsset.ts`
- `SogBuffers` — `src/splat/SogBuffers.ts`

---

## 2. Streaming layer: who owns what

`StreamingSsogRenderPass` (`src/rendering/StreamingSsogRenderPass.ts`) keeps resident GPU chunks in `gpuLoaded`:

```text
GpuResidentChunk {
  buffers: SogBuffers          // per-chunk attributes on GPU
  pass: PackedSogRenderPass?   // standalone path (global sort off)
  resident: ChunkGpuResident?  // page-pool metadata when no standalone pass
  pageAllocation               // pages/spans from SsogGpuPagePool
  active, lastUsedFrame
}
```

### Page pool

`SsogGpuPagePool` (`src/rendering/SsogGpuPagePool.ts`) tracks residency only (not the actual pixel data layout for draw):

- Fixed page capacity (splats/page)
- Chunk → list of page indices + spans `{ page, pageOffset, chunkOffset, count }`
- Used for pressure, eviction, and “how many pages does this chunk need?”

### Upload path (simplified)

```text
decode chunk
  → new SogBuffers(engine, chunk.data, writer, "ssog-streaming-chunk")
  → gpuPagePool.allocateChunk(key, numSplats)
  → either PackedSogRenderPass (standalone) or ChunkGpuResident
  → store in gpuLoaded
```

---

## 3. How draw buffers are organized (by global-sort mode)

Controlled by `ssogGlobalSort`: `"off" | "packed" | "expanded" | "resident"`.

### A. `off` — per-chunk buffers

Each active chunk keeps its own `SogBuffers` + `PackedSogRenderPass`.
Draw uses that chunk’s storage directly. Sort/order is local to the chunk.

### B. `packed` — rebuild one mega packed buffer

`SsogGlobalPackedRenderPass` (`src/rendering/SsogGlobalPackedRenderPass.ts`) **concatenates all active chunks** into one set of global buffers:

```text
SsogGlobalMeansL / MeansU / Quats / Scales / Color / State
SsogGlobalScaleCodebook
SsogGlobalChunkInfo          // per-chunk metadata for decode
SsogGlobalIndices            // draw order
(+ centers, depthKeys, gpuSortIndices, ordinalToPacked for GPU sort)
```

Active set change → `buildGlobalPackedArrays` → allocate + upload large buffers. Expensive on camera/LOD churn (this is the path the resident plan replaces).

### C. `resident` — keep attributes, update compact metadata (preferred path)

`SsogResidentPageRenderPass` (`src/rendering/SsogResidentPageRenderPass.ts`) uses **two tiers**:

#### Physical attribute pools (append-only, reused across frames)

```text
physicalMeansL / MeansU / Quats / Scales / State / Color
physicalScaleCodebook
```

New chunks are **appended** at `splatOffset` / `scaleCodebookOffset`. Existing chunks are not repacked when the camera moves.

#### Compact metadata / sort tables (cheap to rebuild)

```text
chunkTable     // 16 floats per active chunk (4× vec4)
drawRefs       // u32 per draw splat: (chunkOrdinal << 20) | localIndex
sortedOrdinals // radix sort output
sortedRefs     // gathered drawRefs in depth order
depthKeys      // sort keys
depthParams / gatherParams
```

#### Chunk table row (16 floats)

| Offset | Content |
|---|---|
| 0–2 | meansMin |
| 3 | splatCount |
| 4–6 | meansMax |
| 7 | lod |
| 8 | physical splatOffset |
| 9 | scaleCodebookOffset |
| 10 | page span count |
| 11 | ordinal |
| 12–14 | boundsMin |
| 15 | pageAllocation.splats |

#### Vertex shader indirection

Vertex shader (`ssog-resident-page-render-pass.wgsl-vertex-source.wgsl`):

1. `sortedRefs[drawIndex]` → `(chunk, localIndex)`
2. `physicalIndex = chunkTable[chunk].splatOffset + localIndex`
3. Decode center/rot/scale from physical SoA + chunk means range / codebook offset

```text
draw order (sortedRefs)
        │
        ▼
  chunkOrdinal + localIndex
        │
        ▼
  chunkTable → splatOffset, meansMin/Max, codebookOffset
        │
        ▼
  physicalBuffers[splatOffset + local]
```

Camera motion only re-runs **depth key → radix sort → gather** on the refs, not attribute uploads.

---

## 4. Mental model

```text
Disk SSOG pages (webp means/quats/scales/sh0 per node)
        │ decode
        ▼
Per-chunk SogPackedData (SoA packed)
        │ upload once
        ▼
┌─────────────────────────────────────────────┐
│  Resident path                              │
│  Physical SoA pools  (attributes stick)     │
│  Chunk table + drawRefs  (active set)       │
│  Sort buffers  (view-dependent only)        │
└─────────────────────────────────────────────┘
        │
        ▼
Instanced quads (128 splats/instance) via
  resident-sog vertex shader / WebGpuSplatRasterPass
```

---

## Summary

SSOG always stores splats as **packed per-chunk SoA**. For rendering, either:

| Mode | Attribute buffers | On camera / LOD change |
|---|---|---|
| `off` | Per-chunk `SogBuffers` | Local sort only |
| `packed` | One rebuilt global packed set | Repack + re-upload attributes |
| `resident` | Stable physical SoA pools | Update chunk table + sorted draw refs only |

---

## Key source files

| File | Role |
|---|---|
| `src/splat/SplatAsset.ts` | `SogPackedData`, `SsogPackedChunk` types |
| `src/splat/SogBuffers.ts` | Per-chunk GPU storage buffers |
| `src/rendering/StreamingSsogRenderPass.ts` | Streaming, cache, mode routing |
| `src/rendering/SsogGpuPagePool.ts` | Page residency allocation |
| `src/rendering/SsogResidentPageRenderPass.ts` | Resident global draw path |
| `src/rendering/SsogGlobalPackedRenderPass.ts` | Packed global draw path |
| `src/rendering/PackedSogRenderPass.ts` | Per-chunk / standalone packed draw |
| `src/rendering/shaders/ssog-resident-page-render-pass.wgsl-vertex-source.wgsl` | Resident decode + draw |

## Related docs

- `docs/ssog-hierarchy.md`
- `extra/2.ssog_resident_page_global_render_plan.md`
- `docs/gaussian-splatting-optimization-series/02-data-layout.md`
- `docs/gaussian-splatting-optimization-series/09-streaming-page-management.md`
- `docs/gaussian-splatting-optimization-series/10-rendering-pipeline.md`
