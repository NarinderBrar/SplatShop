@group(0) @binding(0) var<storage, read> centerBuffer: array<vec4f>;
@group(0) @binding(1) var<storage, read_write> counters: array<atomic<u32>>;
@group(0) @binding(2) var<storage, read> paramsBuffer: array<f32>;

fn transformCenter(center: vec3f) -> vec4f {
  return vec4f(
    paramsBuffer[0] * center.x + paramsBuffer[4] * center.y + paramsBuffer[8] * center.z + paramsBuffer[12],
    paramsBuffer[1] * center.x + paramsBuffer[5] * center.y + paramsBuffer[9] * center.z + paramsBuffer[13],
    paramsBuffer[2] * center.x + paramsBuffer[6] * center.y + paramsBuffer[10] * center.z + paramsBuffer[14],
    paramsBuffer[3] * center.x + paramsBuffer[7] * center.y + paramsBuffer[11] * center.z + paramsBuffer[15]
  );
}

@compute @workgroup_size(__BIN_SOURCE_EXPR_0__)
fn main(@builtin(global_invocation_id) globalId: vec3u) {
  let index = globalId.x;
  let splatCount = u32(paramsBuffer[21]);
  if (index >= splatCount) {
    return;
  }

  let centerOffset = u32(paramsBuffer[24]);
  let clip = transformCenter(centerBuffer[centerOffset + index].xyz);
  if (clip.w <= 0.000001) {
    atomicAdd(&counters[__BEHIND_OFFSET__u], 1u);
    return;
  }

  let ndc = clip.xy / clip.w;
  if (ndc.x < -1.0 || ndc.x > 1.0 || ndc.y < -1.0 || ndc.y > 1.0) {
    atomicAdd(&counters[__CLIPPED_OFFSET__u], 1u);
    return;
  }

  let viewport = vec2f(paramsBuffer[16], paramsBuffer[17]);
  let tileSize = paramsBuffer[18];
  let tileCols = u32(paramsBuffer[19]);
  let tileRows = u32(paramsBuffer[20]);
  let pixel = (ndc * vec2f(0.5, -0.5) + vec2f(0.5)) * viewport;
  let tileX = min(tileCols - 1u, u32(clamp(floor(pixel.x / tileSize), 0.0, f32(tileCols - 1u))));
  let tileY = min(tileRows - 1u, u32(clamp(floor(pixel.y / tileSize), 0.0, f32(tileRows - 1u))));
  let tileIndex = tileY * tileCols + tileX;
  if (tileIndex >= __MAX_TILES__u) {
    atomicAdd(&counters[__OVERFLOW_OFFSET__u], 1u);
    return;
  }

  atomicAdd(&counters[tileIndex], 1u);
  atomicAdd(&counters[__PAIR_OFFSET__u], 1u);
  atomicAdd(&counters[__VISIBLE_OFFSET__u], 1u);
}
