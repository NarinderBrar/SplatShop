@group(0) @binding(0) var<storage, read> inputKeys: array<u32>;
@group(0) @binding(1) var<storage, read_write> blockSums: array<u32>;
@group(0) @binding(2) var<storage, read> paramsBuffer: array<u32>;

var<workgroup> histogram: array<atomic<u32>, __TEMPLATE_EXPR_0__>;

@compute @workgroup_size(__TEMPLATE_EXPR_1__, __TEMPLATE_EXPR_2__, 1)
fn main(
  @builtin(workgroup_id) workgroupId: vec3u,
  @builtin(num_workgroups) workgroupDim: vec3u,
  @builtin(local_invocation_index) threadIndex: u32,
) {
  let linearWorkgroupId = workgroupId.x + workgroupId.y * workgroupDim.x;
  let workgroupStart = linearWorkgroupId * __TEMPLATE_EXPR_3__u;
  let workgroupCount = paramsBuffer[0];
  let elementCount = paramsBuffer[1];

  if (threadIndex < __TEMPLATE_EXPR_4__u) {
    atomicStore(&histogram[threadIndex], 0u);
  }
  workgroupBarrier();

  for (var round = 0u; round < __TEMPLATE_EXPR_5__u; round++) {
    let index = workgroupStart + round * __TEMPLATE_EXPR_6__u + threadIndex;
    if (index < elementCount && linearWorkgroupId < workgroupCount) {
      let digit = (inputKeys[index] >> __TEMPLATE_EXPR_7__u) & 15u;
      atomicAdd(&histogram[digit], 1u);
    }
  }
  workgroupBarrier();

  if (threadIndex < __TEMPLATE_EXPR_8__u && linearWorkgroupId < workgroupCount) {
    blockSums[threadIndex * workgroupCount + linearWorkgroupId] = atomicLoad(&histogram[threadIndex]);
  }
}
