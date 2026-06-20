@group(0) @binding(0) var<storage, read_write> bucketCounters: array<u32>;
@group(0) @binding(1) var<storage, read_write> bucketOffsets: array<u32>;
@group(0) @binding(2) var<storage, read> paramsBuffer: array<f32>;

@compute @workgroup_size(__CLEAR_SOURCE_EXPR_0__)
fn main(@builtin(global_invocation_id) globalId: vec3u) {
  let index = globalId.x;
  let total = u32(paramsBuffer[24]) * u32(paramsBuffer[25]);
  if (index >= total) {
    return;
  }
  bucketCounters[index] = 0u;
  bucketOffsets[index] = 0u;
}
