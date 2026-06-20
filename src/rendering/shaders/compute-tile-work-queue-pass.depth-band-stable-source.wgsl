@group(0) @binding(0) var<storage, read> tileCounters: array<u32>;
@group(0) @binding(1) var<storage, read> tileOffsets: array<u32>;
@group(0) @binding(2) var<storage, read> depthRanges: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> workQueue: array<vec4u>;
@group(0) @binding(4) var<storage, read_write> metadata: array<u32>;
@group(0) @binding(5) var<storage, read> paramsBuffer: array<u32>;

fn depthBand(depth: f32, minDepthQ: u32, depthBandRangeQ: u32) -> u32 {
  let minDepth = f32(minDepthQ) / __DEPTH_BAND_STABLE_SOURCE_EXPR_0__.0;
  let depthBandRange = max(1.0 / __DEPTH_BAND_STABLE_SOURCE_EXPR_1__.0, f32(depthBandRangeQ) / __DEPTH_BAND_STABLE_SOURCE_EXPR_2__.0);
  let t = clamp((depth - minDepth) / depthBandRange, 0.0, 0.999999);
  let bucket = min(__DEPTH_BAND_STABLE_SOURCE_EXPR_3__u, u32(floor(t * __DEPTH_BAND_STABLE_SOURCE_EXPR_4__.0)));
  return __DEPTH_BAND_STABLE_SOURCE_EXPR_5__u - bucket;
}

@compute @workgroup_size(1)
fn main() {
  let tileCount = min(paramsBuffer[0], __DEPTH_BAND_STABLE_SOURCE_EXPR_6__u);
  let maxBatchSplats = paramsBuffer[1];
  let maxWorkItems = min(paramsBuffer[2], __DEPTH_BAND_STABLE_SOURCE_EXPR_7__u);
  var slot = 0u;
  var queuedSplats = 0u;
  var maxTileSplats = 0u;
  var overflow = 0u;

  for (var band = 0u; band < __DEPTH_BAND_STABLE_SOURCE_EXPR_8__u; band = band + 1u) {
    for (var tileIndex = 0u; tileIndex < tileCount; tileIndex = tileIndex + 1u) {
      let splatCount = tileCounters[tileIndex];
      let depth = depthRanges[tileIndex];
      if (splatCount == 0u || depth.w <= 0.0) {
        continue;
      }
      if (depthBand(depth.z, paramsBuffer[4], max(1u, paramsBuffer[5])) != band) {
        continue;
      }

      let batchSize = select(splatCount, min(splatCount, maxBatchSplats), maxBatchSplats > 0u);
      let batchCount = (splatCount + batchSize - 1u) / batchSize;
      let tileOffset = tileOffsets[tileIndex];
      for (var batch = 0u; batch < batchCount; batch = batch + 1u) {
        let batchOffset = batch * batchSize;
        let batchSplats = min(batchSize, splatCount - batchOffset);
        if (slot >= maxWorkItems) {
          overflow = overflow + 1u;
          continue;
        }

        workQueue[slot] = vec4u(tileIndex, tileOffset + batchOffset, batchSplats, band);
        slot = slot + 1u;
        queuedSplats = queuedSplats + batchSplats;
        maxTileSplats = max(maxTileSplats, batchSplats);
      }
    }
  }

  metadata[0] = slot;
  metadata[1] = queuedSplats;
  metadata[2] = maxTileSplats;
  metadata[3] = overflow;
}
