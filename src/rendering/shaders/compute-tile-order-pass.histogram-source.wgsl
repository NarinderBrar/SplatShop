@group(0) @binding(0) var<storage, read> centerBuffer: array<vec4f>;
@group(0) @binding(1) var<storage, read_write> bucketCounters: array<atomic<u32>>;
@group(0) @binding(2) var<storage, read> paramsBuffer: array<f32>;

fn transformCenter(center: vec3f) -> vec4f {
  return vec4f(
    paramsBuffer[0] * center.x + paramsBuffer[4] * center.y + paramsBuffer[8] * center.z + paramsBuffer[12],
    paramsBuffer[1] * center.x + paramsBuffer[5] * center.y + paramsBuffer[9] * center.z + paramsBuffer[13],
    paramsBuffer[2] * center.x + paramsBuffer[6] * center.y + paramsBuffer[10] * center.z + paramsBuffer[14],
    paramsBuffer[3] * center.x + paramsBuffer[7] * center.y + paramsBuffer[11] * center.z + paramsBuffer[15]
  );
}

fn tileAndBucket(index: u32) -> vec2u {
  let centerOffset = u32(paramsBuffer[28]);
  let clip = transformCenter(centerBuffer[centerOffset + index].xyz);
  if (clip.w <= 0.000001) {
    return vec2u(4294967295u);
  }
  let ndc = clip.xy / clip.w;
  if (ndc.x < -1.0 || ndc.x > 1.0 || ndc.y < -1.0 || ndc.y > 1.0) {
    return vec2u(4294967295u);
  }

  let viewport = vec2f(paramsBuffer[16], paramsBuffer[17]);
  let tileSize = paramsBuffer[18];
  let tileCols = u32(paramsBuffer[19]);
  let tileRows = u32(paramsBuffer[20]);
  let tileCount = u32(paramsBuffer[24]);
  let bucketCount = u32(paramsBuffer[25]);
  let minDepth = paramsBuffer[26];
  let maxDepth = max(minDepth + 0.000001, paramsBuffer[27]);
  let pixel = (ndc * vec2f(0.5, -0.5) + vec2f(0.5)) * viewport;
  let tileX = min(tileCols - 1u, u32(clamp(floor(pixel.x / tileSize), 0.0, f32(tileCols - 1u))));
  let tileY = min(tileRows - 1u, u32(clamp(floor(pixel.y / tileSize), 0.0, f32(tileRows - 1u))));
  let tileIndex = tileY * tileCols + tileX;
  if (tileIndex >= tileCount || tileIndex >= __HISTOGRAM_SOURCE_EXPR_0__u) {
    return vec2u(4294967295u);
  }

  let t = clamp((clip.w - minDepth) / (maxDepth - minDepth), 0.0, 0.999999);
  let bucket = min(bucketCount - 1u, u32(floor(t * f32(bucketCount))));
  return vec2u(tileIndex, bucket);
}

@compute @workgroup_size(__HISTOGRAM_SOURCE_EXPR_1__)
fn main(@builtin(global_invocation_id) globalId: vec3u) {
  let index = globalId.x;
  let splatCount = u32(paramsBuffer[21]);
  if (index >= splatCount) {
    return;
  }
  let tb = tileAndBucket(index);
  if (tb.x == 4294967295u) {
    return;
  }
  let bucketCount = u32(paramsBuffer[25]);
  atomicAdd(&bucketCounters[tb.x * bucketCount + tb.y], 1u);
}
