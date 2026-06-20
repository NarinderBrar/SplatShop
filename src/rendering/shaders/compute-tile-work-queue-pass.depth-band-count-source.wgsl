@group(0) @binding(0) var<storage, read> tileCounters: array<u32>;
@group(0) @binding(1) var<storage, read> depthRanges: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> depthBandCounters: array<atomic<u32>>;
@group(0) @binding(3) var<storage, read> paramsBuffer: array<u32>;

fn depthBand(depth: f32, minDepthQ: u32, depthBandRangeQ: u32) -> u32 {
  let minDepth = f32(minDepthQ) / __DEPTH_BAND_COUNT_SOURCE_EXPR_0__.0;
  let depthBandRange = max(1.0 / __DEPTH_BAND_COUNT_SOURCE_EXPR_1__.0, f32(depthBandRangeQ) / __DEPTH_BAND_COUNT_SOURCE_EXPR_2__.0);
  let t = clamp((depth - minDepth) / depthBandRange, 0.0, 0.999999);
  let bucket = min(__DEPTH_BAND_COUNT_SOURCE_EXPR_3__u, u32(floor(t * __DEPTH_BAND_COUNT_SOURCE_EXPR_4__.0)));
  return __DEPTH_BAND_COUNT_SOURCE_EXPR_5__u - bucket;
}

@compute @workgroup_size(__DEPTH_BAND_COUNT_SOURCE_EXPR_6__)
fn main(@builtin(global_invocation_id) globalId: vec3u) {
  let tileIndex = globalId.x;
  let tileCount = paramsBuffer[0];
  if (tileIndex >= tileCount || tileIndex >= __DEPTH_BAND_COUNT_SOURCE_EXPR_7__u) {
    return;
  }

  let splatCount = tileCounters[tileIndex];
  let depth = depthRanges[tileIndex];
  if (splatCount == 0u || depth.w <= 0.0) {
    return;
  }

  let maxBatchSplats = paramsBuffer[1];
  let batchSize = select(splatCount, min(splatCount, maxBatchSplats), maxBatchSplats > 0u);
  let batchCount = (splatCount + batchSize - 1u) / batchSize;
  atomicAdd(&depthBandCounters[depthBand(depth.z, paramsBuffer[4], max(1u, paramsBuffer[5]))], batchCount);
}
