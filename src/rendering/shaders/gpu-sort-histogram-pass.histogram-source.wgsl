@group(0) @binding(0) var<storage, read> depthKeyBuffer: array<u32>;
@group(0) @binding(1) var<storage, read_write> bucketCounts: array<atomic<u32>>;
@group(0) @binding(2) var<storage, read> paramsBuffer: array<u32>;

@compute @workgroup_size(__HISTOGRAM_SOURCE_EXPR_0__)
fn main(@builtin(global_invocation_id) globalId: vec3u) {
  let index = globalId.x;
  let splatCount = paramsBuffer[0];
  if (index >= splatCount) {
    return;
  }

  let bucketShift = paramsBuffer[2];
  let bucketCount = paramsBuffer[1];
  let bucket = min(depthKeyBuffer[index] >> bucketShift, bucketCount - 1u);
  atomicAdd(&bucketCounts[bucket], 1u);
}
