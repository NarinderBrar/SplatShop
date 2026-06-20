@group(0) @binding(0) var<storage, read_write> depthBandCounters: array<u32>;

@compute @workgroup_size(__DEPTH_BAND_RESET_COUNTERS_SOURCE_EXPR_0__)
fn main(@builtin(global_invocation_id) globalId: vec3u) {
  let index = globalId.x;
  if (index < __DEPTH_BAND_RESET_COUNTERS_SOURCE_EXPR_1__u) {
    depthBandCounters[index] = 0u;
  }
}
