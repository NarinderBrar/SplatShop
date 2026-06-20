@group(0) @binding(0) var<storage, read_write> items: array<u32>;
@group(0) @binding(1) var<storage, read_write> blockSums: array<u32>;
@group(0) @binding(2) var<storage, read> paramsBuffer: array<u32>;

var<workgroup> temp: array<u32, __PREFIX_SCAN_SOURCE_EXPR_0__>;

@compute @workgroup_size(__PREFIX_SCAN_SOURCE_EXPR_1__)
fn main(
  @builtin(workgroup_id) workgroupId: vec3u,
  @builtin(local_invocation_index) threadIndex: u32,
) {
  let elementCount = paramsBuffer[0];
  let elementOffset = workgroupId.x * __PREFIX_SCAN_SOURCE_EXPR_2__u + threadIndex * 2u;

  temp[threadIndex * 2u] = select(items[elementOffset], 0u, elementOffset >= elementCount);
  temp[threadIndex * 2u + 1u] = select(items[elementOffset + 1u], 0u, elementOffset + 1u >= elementCount);

  var offset = 1u;
  for (var d = __PREFIX_SCAN_SOURCE_EXPR_3__u; d > 0u; d = d >> 1u) {
    workgroupBarrier();
    if (threadIndex < d) {
      let ai = offset * (threadIndex * 2u + 1u) - 1u;
      let bi = offset * (threadIndex * 2u + 2u) - 1u;
      temp[bi] += temp[ai];
    }
    offset = offset << 1u;
  }

  if (threadIndex == 0u) {
    blockSums[workgroupId.x] = temp[__PREFIX_SCAN_SOURCE_EXPR_4__u];
    temp[__PREFIX_SCAN_SOURCE_EXPR_5__u] = 0u;
  }

  for (var d = 1u; d < __PREFIX_SCAN_SOURCE_EXPR_6__u; d = d << 1u) {
    offset = offset >> 1u;
    workgroupBarrier();
    if (threadIndex < d) {
      let ai = offset * (threadIndex * 2u + 1u) - 1u;
      let bi = offset * (threadIndex * 2u + 2u) - 1u;
      let value = temp[ai];
      temp[ai] = temp[bi];
      temp[bi] += value;
    }
  }
  workgroupBarrier();

  if (elementOffset < elementCount) {
    items[elementOffset] = temp[threadIndex * 2u];
  }
  if (elementOffset + 1u < elementCount) {
    items[elementOffset + 1u] = temp[threadIndex * 2u + 1u];
  }
}
