@group(0) @binding(0) var<storage, read> centerBuffer: array<vec4f>;
@group(0) @binding(1) var<storage, read_write> bucketCounters: array<atomic<u32>>;
@group(0) @binding(2) var<storage, read> tileOffsets: array<u32>;
@group(0) @binding(3) var<storage, read> tileSplatList: array<u32>;
@group(0) @binding(4) var<storage, read> paramsBuffer: array<f32>;

fn transformCenter(center: vec3f) -> vec4f {
  return vec4f(
    paramsBuffer[0] * center.x + paramsBuffer[4] * center.y + paramsBuffer[8] * center.z + paramsBuffer[12],
    paramsBuffer[1] * center.x + paramsBuffer[5] * center.y + paramsBuffer[9] * center.z + paramsBuffer[13],
    paramsBuffer[2] * center.x + paramsBuffer[6] * center.y + paramsBuffer[10] * center.z + paramsBuffer[14],
    paramsBuffer[3] * center.x + paramsBuffer[7] * center.y + paramsBuffer[11] * center.z + paramsBuffer[15]
  );
}

fn tileForEntry(entryIndex: u32, tileCount: u32) -> u32 {
  var low = 0u;
  var high = tileCount;
  while (low < high) {
    let midpoint = low + (high - low) / 2u;
    if (tileOffsets[midpoint + 1u] <= entryIndex) {
      low = midpoint + 1u;
    } else {
      high = midpoint;
    }
  }
  return low;
}

@compute @workgroup_size(__HISTOGRAM_SOURCE_EXPR_1__)
fn main(@builtin(global_invocation_id) globalId: vec3u) {
  let entryIndex = globalId.x;
  let tileCount = u32(paramsBuffer[24]);
  if (tileCount == 0u || entryIndex >= tileOffsets[tileCount]) {
    return;
  }

  let tileIndex = tileForEntry(entryIndex, tileCount);
  if (tileIndex >= tileCount || tileIndex >= __HISTOGRAM_SOURCE_EXPR_0__u) {
    return;
  }
  let splatIndex = tileSplatList[entryIndex];
  let centerOffset = u32(paramsBuffer[28]);
  let clip = transformCenter(centerBuffer[centerOffset + splatIndex].xyz);
  if (clip.w <= 0.000001) {
    return;
  }

  let bucketCount = u32(paramsBuffer[25]);
  let minDepth = paramsBuffer[26];
  let maxDepth = max(minDepth + 0.000001, paramsBuffer[27]);
  let t = clamp((clip.w - minDepth) / (maxDepth - minDepth), 0.0, 0.999999);
  let bucket = min(bucketCount - 1u, u32(floor(t * f32(bucketCount))));
  atomicAdd(&bucketCounters[tileIndex * bucketCount + bucket], 1u);
}
