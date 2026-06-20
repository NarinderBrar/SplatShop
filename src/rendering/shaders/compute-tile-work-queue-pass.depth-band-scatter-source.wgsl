@group(0) @binding(0) var<storage, read> tileCounters: array<u32>;
@group(0) @binding(1) var<storage, read> tileOffsets: array<u32>;
@group(0) @binding(2) var<storage, read> depthRanges: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> workQueue: array<vec4u>;
@group(0) @binding(4) var<storage, read_write> metadata: array<atomic<u32>>;
@group(0) @binding(5) var<storage, read> paramsBuffer: array<u32>;
@group(0) @binding(6) var<storage, read_write> depthBandCounters: array<atomic<u32>>;
@group(0) @binding(7) var<storage, read> depthBandOffsets: array<u32>;

fn depthBand(depth: f32, minDepthQ: u32, depthBandRangeQ: u32) -> u32 {
  let minDepth = f32(minDepthQ) / __DEPTH_BAND_SCATTER_SOURCE_EXPR_0__.0;
  let depthBandRange = max(1.0 / __DEPTH_BAND_SCATTER_SOURCE_EXPR_1__.0, f32(depthBandRangeQ) / __DEPTH_BAND_SCATTER_SOURCE_EXPR_2__.0);
  let t = clamp((depth - minDepth) / depthBandRange, 0.0, 0.999999);
  let bucket = min(__DEPTH_BAND_SCATTER_SOURCE_EXPR_3__u, u32(floor(t * __DEPTH_BAND_SCATTER_SOURCE_EXPR_4__.0)));
  return __DEPTH_BAND_SCATTER_SOURCE_EXPR_5__u - bucket;
}

@compute @workgroup_size(__DEPTH_BAND_SCATTER_SOURCE_EXPR_6__)
fn main(@builtin(global_invocation_id) globalId: vec3u) {
  let tileIndex = globalId.x;
  let tileCount = paramsBuffer[0];
  if (tileIndex >= tileCount || tileIndex >= __DEPTH_BAND_SCATTER_SOURCE_EXPR_7__u) {
    return;
  }

  let splatCount = tileCounters[tileIndex];
  let depth = depthRanges[tileIndex];
  if (splatCount == 0u || depth.w <= 0.0) {
    return;
  }

  let maxBatchSplats = paramsBuffer[1];
  let batchSize = select(splatCount, min(splatCount, maxBatchSplats), maxBatchSplats > 0u);
  let maxWorkItems = min(paramsBuffer[2], __DEPTH_BAND_SCATTER_SOURCE_EXPR_8__u);
  let band = depthBand(depth.z, paramsBuffer[4], max(1u, paramsBuffer[5]));
  let batchCount = (splatCount + batchSize - 1u) / batchSize;
  let tileOffset = tileOffsets[tileIndex];
  for (var batch = 0u; batch < batchCount; batch = batch + 1u) {
    let batchOffset = batch * batchSize;
    let batchSplats = min(batchSize, splatCount - batchOffset);
    let slot = depthBandOffsets[band] + atomicAdd(&depthBandCounters[band], 1u);
    if (slot >= maxWorkItems) {
      continue;
    }

    workQueue[slot] = vec4u(tileIndex, tileOffset + batchOffset, batchSplats, 0u);
    atomicAdd(&metadata[1], batchSplats);
    atomicMax(&metadata[2], batchSplats);
  }
}
