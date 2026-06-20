@group(0) @binding(0) var<storage, read> sortedOrdinals: array<u32>;
@group(0) @binding(1) var<storage, read> ordinalToPacked: array<u32>;
@group(0) @binding(2) var<storage, read_write> drawIndices: array<u32>;
@group(0) @binding(3) var<storage, read> paramsBuffer: array<u32>;

@compute @workgroup_size(__GPU_INDEX_GATHER_SOURCE_EXPR_0__)
fn main(@builtin(global_invocation_id) globalId: vec3u) {
  let index = globalId.x;
  let count = paramsBuffer[0];
  if (index >= count) {
    return;
  }

  let ordinal = sortedOrdinals[index];
  if (ordinal >= count) {
    return;
  }
  drawIndices[index] = ordinalToPacked[ordinal];
}
