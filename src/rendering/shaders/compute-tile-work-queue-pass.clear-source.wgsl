@group(0) @binding(0) var<storage, read_write> metadata: array<u32>;
@group(0) @binding(1) var<storage, read_write> depthBandCounters: array<u32>;
@group(0) @binding(2) var<storage, read_write> depthBandOffsets: array<u32>;

@compute @workgroup_size(__CLEAR_SOURCE_EXPR_0__)
fn main(@builtin(global_invocation_id) globalId: vec3u) {
  let index = globalId.x;
  if (index >= __CLEAR_SOURCE_EXPR_1__u) {
  } else {
    metadata[index] = 0u;
  }
  if (index < __CLEAR_SOURCE_EXPR_2__u) {
    depthBandCounters[index] = 0u;
    depthBandOffsets[index] = 0u;
  }
}
