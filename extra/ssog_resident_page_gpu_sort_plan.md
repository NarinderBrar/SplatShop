# Resident Page GPU-Sorted Global Render Plan

## Summary
Replace the current grouped resident renderer with a single GPU-sorted resident page path. The goal is packed-mode visual correctness without CPU global draw-index sorting and without rebuilding global packed attribute buffers.

## Key Changes
- Replace grouped resident meshes with one `SsogResidentPageRenderPass` mesh.
- Keep chunk attributes resident, but expose them through shared physical resident page buffers instead of per-storage-group bindings.
- Add resident GPU metadata:
  - `residentChunkTable`: chunk key/LOD/splat count/page span range/bounds/quantization metadata.
  - `residentPageTable`: physical page/span rows mapping logical chunk-local splats to physical attribute addresses.
  - `residentDrawRefs`: unsorted draw refs encoded as chunk ordinal + local splat index or page span + page-local index.
  - `residentDepthKeys`: GPU-generated sort keys.
  - `residentSortedRefs`: GPU radix output/gathered draw refs.
- Add resident compute stages:
  - depth-key pass: reads resident draw refs + page/chunk tables, decodes center, writes depth key.
  - radix sort: reuse `GpuRadixSortPass`.
  - gather pass: maps sorted ordinals to resident draw refs.
- Update resident vertex shader to resolve:
  `sorted draw ref -> chunk/page table -> physical attribute offset -> decode center/quat/scale/color`.
- Remove current grouped-resident correctness path from `ssogGlobalSort=resident`; keep packed/off/expanded unchanged.
- Fix resident debug stats to report only resident runtime stats, not hidden per-chunk pass GPU sort stats.

## Implementation Notes
- Do not CPU-sort resident splats.
- Do not allocate global packed `meansL/meansU/quats/scales/color/centers/scaleCodebook`.
- Reuse uploaded resident attributes; if current `SogBuffers` arena layout is not page-addressable enough, add a dedicated resident physical page buffer layer populated once when chunks enter GPU residency.
- On camera movement, update only compact active chunk/page/draw-ref metadata and dispatch GPU depth/radix/gather.
- Keep `canBuildGlobalRuntime(...)` readiness gating for resident mode to avoid partial-load holes.
- Preserve packed mode as the visual/performance comparison baseline.

## Test Plan
- Build: `npm run build`.
- Runtime compare:
  - `ssogGlobalSort=packed`
  - `ssogGlobalSort=resident`
  - `ssogGlobalSort=resident&ssogGpuSortVisible=radix&ssogGpuSortForce=true`
  - with and without `ssogGpuChunkVisibility=drive&ssogHiZOcclusion=drive`.
- Acceptance:
  - resident rendered splats equals selected splats when fully loaded.
  - no large black/missing regions compared with packed at same camera.
  - chunk color/debug views show resident chunks without per-group transparent ordering artifacts.
  - Firefox profile shows no `buildGlobalPackedArrays` during camera movement.
  - repeated global attribute buffer `createStorageBuffer` blocks are absent.
  - resident GPU radix stats are real resident stats, not per-chunk hidden-pass stats.

## Assumptions
- CPU global resident draw-index sorting is out of scope.
- Visual correctness takes priority over keeping the current grouped resident renderer.
- Packed mode remains the reference until resident GPU sort matches it closely enough.
