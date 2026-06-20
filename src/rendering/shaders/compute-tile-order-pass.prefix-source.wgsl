@group(0) @binding(0) var<storage, read> bucketCounters: array<u32>;
@group(0) @binding(1) var<storage, read_write> bucketOffsets: array<u32>;
@group(0) @binding(2) var<storage, read> tileOffsets: array<u32>;
@group(0) @binding(3) var<storage, read> paramsBuffer: array<f32>;

@compute @workgroup_size(__PREFIX_SOURCE_EXPR_0__)
fn main(@builtin(global_invocation_id) globalId: vec3u) {
  let tileIndex = globalId.x;
  let tileCount = u32(paramsBuffer[24]);
  let bucketCount = u32(paramsBuffer[25]);
  if (tileIndex >= tileCount) {
    return;
  }

  var cursor = tileOffsets[tileIndex];
  for (var bucket = bucketCount; bucket > 0u; bucket = bucket - 1u) {
    let bucketIndex = bucket - 1u;
    let index = tileIndex * bucketCount + bucketIndex;
    bucketOffsets[index] = cursor;
    cursor = cursor + bucketCounters[index];
  }
}
