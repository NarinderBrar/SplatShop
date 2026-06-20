@group(0) @binding(0) var<storage, read> centerBuffer: array<vec4f>;
@group(0) @binding(1) var<storage, read> tileOffsets: array<u32>;
@group(0) @binding(2) var<storage, read> tileSplatList: array<u32>;
@group(0) @binding(3) var<storage, read_write> depthRanges: array<vec4f>;
@group(0) @binding(4) var<storage, read> paramsBuffer: array<f32>;

fn transformCenter(center: vec3f) -> vec4f {
  return vec4f(
    paramsBuffer[0] * center.x + paramsBuffer[4] * center.y + paramsBuffer[8] * center.z + paramsBuffer[12],
    paramsBuffer[1] * center.x + paramsBuffer[5] * center.y + paramsBuffer[9] * center.z + paramsBuffer[13],
    paramsBuffer[2] * center.x + paramsBuffer[6] * center.y + paramsBuffer[10] * center.z + paramsBuffer[14],
    paramsBuffer[3] * center.x + paramsBuffer[7] * center.y + paramsBuffer[11] * center.z + paramsBuffer[15]
  );
}

@compute @workgroup_size(__DEPTH_RANGE_SOURCE_EXPR_0__)
fn main(@builtin(global_invocation_id) globalId: vec3u) {
  let tileIndex = globalId.x;
  let splatCount = u32(paramsBuffer[21]);
  let tileCount = u32(paramsBuffer[23]);
  if (tileIndex >= tileCount || tileIndex >= __DEPTH_RANGE_SOURCE_EXPR_1__u) {
    return;
  }

  let start = tileOffsets[tileIndex];
  let end = tileOffsets[tileIndex + 1u];
  if (end <= start) {
    depthRanges[tileIndex] = vec4f(0.0);
    return;
  }

  let listCount = end - start;
  let sampleStep = max(1u, (listCount + __DEPTH_RANGE_SOURCE_EXPR_2__u - 1u) / __DEPTH_RANGE_SOURCE_EXPR_3__u);
  var minDepth = 3.4028234663852886e38;
  var maxDepth = -3.4028234663852886e38;
  var sumDepth = 0.0;
  var validCount = 0u;
  for (var item = start; item < end; item = item + sampleStep) {
    let splatIndex = tileSplatList[item];
    if (splatIndex >= splatCount) {
      continue;
    }
    let clip = transformCenter(centerBuffer[splatIndex].xyz);
    if (clip.w <= 0.000001) {
      continue;
    }
    minDepth = min(minDepth, clip.w);
    maxDepth = max(maxDepth, clip.w);
    sumDepth = sumDepth + clip.w;
    validCount = validCount + 1u;
  }

  if (validCount == 0u) {
    depthRanges[tileIndex] = vec4f(0.0);
    return;
  }
  depthRanges[tileIndex] = vec4f(minDepth, maxDepth, sumDepth / f32(validCount), f32(validCount));
}
