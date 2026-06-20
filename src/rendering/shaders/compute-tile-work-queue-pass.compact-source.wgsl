@group(0) @binding(0) var<storage, read> tileCounters: array<u32>;
@group(0) @binding(1) var<storage, read> tileOffsets: array<u32>;
@group(0) @binding(2) var<storage, read> depthRanges: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> workQueue: array<vec4u>;
@group(0) @binding(4) var<storage, read_write> workDepthRanges: array<vec4f>;
@group(0) @binding(5) var<storage, read_write> metadata: array<atomic<u32>>;
@group(0) @binding(6) var<storage, read> paramsBuffer: array<u32>;

@compute @workgroup_size(__COMPACT_SOURCE_EXPR_0__)
fn main(@builtin(global_invocation_id) globalId: vec3u) {
  let tileIndex = globalId.x;
  let tileCount = paramsBuffer[0];
  if (tileIndex >= tileCount || tileIndex >= __COMPACT_SOURCE_EXPR_1__u) {
    return;
  }

  let splatCount = tileCounters[tileIndex];
  let depth = depthRanges[tileIndex];
  if (splatCount == 0u || depth.w <= 0.0) {
    return;
  }

  let maxBatchSplats = paramsBuffer[1];
  let batchSize = select(splatCount, min(splatCount, maxBatchSplats), maxBatchSplats > 0u);
  let maxWorkItems = paramsBuffer[2];
  let batchCount = (splatCount + batchSize - 1u) / batchSize;
  let tileOffset = tileOffsets[tileIndex];
  for (var batch = 0u; batch < batchCount; batch = batch + 1u) {
    let batchOffset = batch * batchSize;
    let batchSplats = min(batchSize, splatCount - batchOffset);
    let slot = atomicAdd(&metadata[0], 1u);
    if (slot >= maxWorkItems || slot >= __COMPACT_SOURCE_EXPR_2__u) {
      atomicAdd(&metadata[3], 1u);
      continue;
    }

    workQueue[slot] = vec4u(tileIndex, tileOffset + batchOffset, batchSplats, 0u);
    workDepthRanges[slot] = depth;
    atomicAdd(&metadata[1], batchSplats);
    atomicMax(&metadata[2], batchSplats);
  }
}
