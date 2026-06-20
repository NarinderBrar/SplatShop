@group(0) @binding(0) var<storage, read_write> bucketCounts: array<atomic<u32>>;
@group(0) @binding(1) var<storage, read> paramsBuffer: array<u32>;

@compute @workgroup_size(__CLEAR_SOURCE_EXPR_0__)
fn main(@builtin(global_invocation_id) globalId: vec3u) {
  let index = globalId.x;
  let bucketCount = paramsBuffer[1];
  if (index >= bucketCount) {
    return;
  }

  atomicStore(&bucketCounts[index], 0u);
}
