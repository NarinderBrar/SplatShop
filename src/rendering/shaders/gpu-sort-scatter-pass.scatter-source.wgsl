@group(0) @binding(0) var<storage, read> depthKeyBuffer: array<u32>;
@group(0) @binding(1) var<storage, read_write> bucketOffsets: array<atomic<u32>>;
@group(0) @binding(2) var<storage, read_write> outputIndices: array<u32>;
@group(0) @binding(3) var<storage, read> paramsBuffer: array<u32>;

@compute @workgroup_size(__SCATTER_SOURCE_EXPR_0__)
fn main(@builtin(global_invocation_id) globalId: vec3u) {
  let splatIndex = globalId.x;
  let splatCount = paramsBuffer[0];
  if (splatIndex >= splatCount) {
    return;
  }

  let bucketCount = paramsBuffer[1];
  let bucketShift = paramsBuffer[2];
  let bucket = min(depthKeyBuffer[splatIndex] >> bucketShift, bucketCount - 1u);
  let dst = atomicAdd(&bucketOffsets[bucket], 1u);
  outputIndices[dst] = splatIndex;
}
