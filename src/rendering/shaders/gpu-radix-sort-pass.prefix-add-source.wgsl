@group(0) @binding(0) var<storage, read_write> items: array<u32>;
@group(0) @binding(1) var<storage, read> blockSums: array<u32>;
@group(0) @binding(2) var<storage, read> paramsBuffer: array<u32>;

@compute @workgroup_size(__PREFIX_ADD_SOURCE_EXPR_0__)
fn main(
  @builtin(workgroup_id) workgroupId: vec3u,
  @builtin(local_invocation_index) threadIndex: u32,
) {
  let elementCount = paramsBuffer[0];
  let elementOffset = workgroupId.x * __PREFIX_ADD_SOURCE_EXPR_1__u + threadIndex * 2u;
  if (elementOffset >= elementCount) {
    return;
  }

  let blockSum = blockSums[workgroupId.x];
  items[elementOffset] += blockSum;
  if (elementOffset + 1u < elementCount) {
    items[elementOffset + 1u] += blockSum;
  }
}
