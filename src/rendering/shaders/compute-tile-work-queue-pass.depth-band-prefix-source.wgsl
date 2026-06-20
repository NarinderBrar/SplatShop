@group(0) @binding(0) var<storage, read> depthBandCounters: array<u32>;
@group(0) @binding(1) var<storage, read_write> depthBandOffsets: array<u32>;
@group(0) @binding(2) var<storage, read_write> metadata: array<u32>;
@group(0) @binding(3) var<storage, read> paramsBuffer: array<u32>;

@compute @workgroup_size(1)
fn main() {
  let maxWorkItems = min(paramsBuffer[2], __DEPTH_BAND_PREFIX_SOURCE_EXPR_0__u);
  var cursor = 0u;
  for (var band = 0u; band < __DEPTH_BAND_PREFIX_SOURCE_EXPR_1__u; band = band + 1u) {
    depthBandOffsets[band] = min(cursor, maxWorkItems);
    cursor = cursor + depthBandCounters[band];
  }
  metadata[0] = min(cursor, maxWorkItems);
  if (cursor > maxWorkItems) {
    metadata[3] = cursor - maxWorkItems;
  }
}
