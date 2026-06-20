@group(0) @binding(0) var<storage, read> inputKeys: array<u32>;
@group(0) @binding(1) var<storage, read> sortedIndices: array<u32>;
@group(0) @binding(2) var<storage, read_write> counters: array<atomic<u32>>;
@group(0) @binding(3) var<storage, read> paramsBuffer: array<u32>;

@compute @workgroup_size(__VALIDATION_SOURCE_EXPR_0__)
fn main(@builtin(global_invocation_id) globalId: vec3u) {
  let index = globalId.x;
  let elementCount = paramsBuffer[1];
  if (index + 1u >= elementCount) {
    return;
  }

  let left = sortedIndices[index];
  let right = sortedIndices[index + 1u];
  if (left >= elementCount || right >= elementCount) {
    atomicAdd(&counters[2], 1u);
    return;
  }

  let leftKey = inputKeys[left];
  let rightKey = inputKeys[right];
  if (leftKey > rightKey) {
    atomicAdd(&counters[0], 1u);
  }
  if (leftKey < rightKey) {
    atomicAdd(&counters[1], 1u);
  }
  if (left == right) {
    atomicAdd(&counters[3], 1u);
  }

  atomicAdd(&counters[4], left);
  atomicXor(&counters[5], left);
  atomicAdd(&counters[6], 1u);

  if (index + 2u == elementCount) {
    atomicAdd(&counters[4], right);
    atomicXor(&counters[5], right);
    atomicAdd(&counters[6], 1u);
  }
}
