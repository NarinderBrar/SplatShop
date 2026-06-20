@group(0) @binding(0) var<storage, read> inputKeys: array<u32>;
@group(0) @binding(1) var<storage, read_write> outputKeys: array<u32>;
@group(0) @binding(2) var<storage, read> prefixBlockSums: array<u32>;
@group(0) @binding(3) var<storage, read> inputValues: array<u32>;
@group(0) @binding(4) var<storage, read_write> outputValues: array<u32>;
@group(0) @binding(5) var<storage, read> paramsBuffer: array<u32>;

var<workgroup> digitMasks: array<atomic<u32>, 128>;
var<workgroup> digitOffsets: array<u32, __TEMPLATE_EXPR_0__>;

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
  let wordIndex = threadIndex >> 5u;
  let bitIndex = threadIndex & 31u;

  if (threadIndex < __TEMPLATE_EXPR_4__u) {
    digitOffsets[threadIndex] = 0u;
  }
  if (threadIndex < 128u) {
    atomicStore(&digitMasks[threadIndex], 0u);
  }
  workgroupBarrier();

  for (var round = 0u; round < __TEMPLATE_EXPR_5__u; round++) {
    let index = workgroupStart + round * __TEMPLATE_EXPR_6__u + threadIndex;
    let isValid = index < elementCount && linearWorkgroupId < workgroupCount;
    let key = select(0u, inputKeys[index], isValid);
    let digit = select(16u, (key >> __TEMPLATE_EXPR_7__u) & 15u, isValid);
    let value = select(0u, inputValues[index], isValid);

    if (isValid) {
      atomicOr(&digitMasks[digit * 8u + wordIndex], 1u << bitIndex);
    }
    workgroupBarrier();

    if (isValid) {
      let base = digit * 8u;
      var localPrefix = digitOffsets[digit];
      for (var word = 0u; word < wordIndex; word++) {
        localPrefix += countOneBits(atomicLoad(&digitMasks[base + word]));
      }
      localPrefix += countOneBits(atomicLoad(&digitMasks[base + wordIndex]) & ((1u << bitIndex) - 1u));

      let prefixIndex = digit * workgroupCount + linearWorkgroupId;
      let sortedPosition = prefixBlockSums[prefixIndex] + localPrefix;

      outputKeys[sortedPosition] = key;
      outputValues[sortedPosition] = value;
    }

    if (round < __TEMPLATE_EXPR_8__u) {
      workgroupBarrier();
      if (threadIndex < __TEMPLATE_EXPR_9__u) {
        var count = 0u;
        for (var word = 0u; word < 8u; word++) {
          let maskIndex = threadIndex * 8u + word;
          count += countOneBits(atomicLoad(&digitMasks[maskIndex]));
          atomicStore(&digitMasks[maskIndex], 0u);
        }
        digitOffsets[threadIndex] += count;
      }
      workgroupBarrier();
    }
  }
}
