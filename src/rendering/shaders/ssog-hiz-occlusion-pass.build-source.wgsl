@group(0) @binding(0) var<storage, read> boundsBuffer: array<vec4f>;
@group(0) @binding(1) var<storage, read> occluderMask: array<u32>;
@group(0) @binding(2) var<storage, read_write> depthGrid: array<atomic<u32>>;
@group(0) @binding(3) var<storage, read_write> visibleIndices: array<u32>;
@group(0) @binding(4) var<storage, read_write> counters: array<atomic<u32>>;
@group(0) @binding(5) var<storage, read> paramsBuffer: array<f32>;

struct ProjectedBounds {
  valid: bool,
  minCell: vec2u,
  maxCell: vec2u,
  minDepthQ: u32,
};

fn transformPoint(point: vec3f) -> vec4f {
  return vec4f(
    dot(vec4f(point, 1.0), vec4f(paramsBuffer[0], paramsBuffer[4], paramsBuffer[8], paramsBuffer[12])),
    dot(vec4f(point, 1.0), vec4f(paramsBuffer[1], paramsBuffer[5], paramsBuffer[9], paramsBuffer[13])),
    dot(vec4f(point, 1.0), vec4f(paramsBuffer[2], paramsBuffer[6], paramsBuffer[10], paramsBuffer[14])),
    dot(vec4f(point, 1.0), vec4f(paramsBuffer[3], paramsBuffer[7], paramsBuffer[11], paramsBuffer[15]))
  );
}

fn depthQ(depth: f32) -> u32 {
  return u32(clamp(depth, 0.0, 1048576.0) * 4096.0);
}

fn projectChunk(index: u32) -> ProjectedBounds {
  let minBounds = boundsBuffer[index * 2u].xyz;
  let maxBounds = boundsBuffer[index * 2u + 1u].xyz;
  let gridWidth = u32(paramsBuffer[18]);
  let gridHeight = u32(paramsBuffer[19]);
  var minPixel = vec2f(3.4028234663852886e38);
  var maxPixel = vec2f(-3.4028234663852886e38);
  var minDepth = 3.4028234663852886e38;
  var valid = false;

  for (var corner = 0u; corner < 8u; corner = corner + 1u) {
    let point = vec3f(
      select(minBounds.x, maxBounds.x, (corner & 1u) != 0u),
      select(minBounds.y, maxBounds.y, (corner & 2u) != 0u),
      select(minBounds.z, maxBounds.z, (corner & 4u) != 0u)
    );
    let clip = transformPoint(point);
    if (clip.w <= 0.0001) {
      continue;
    }
    let ndc = clip.xy / clip.w;
    let pixel = (ndc * vec2f(0.5, -0.5) + vec2f(0.5)) * vec2f(paramsBuffer[16], paramsBuffer[17]);
    minPixel = min(minPixel, pixel);
    maxPixel = max(maxPixel, pixel);
    minDepth = min(minDepth, clip.w);
    valid = true;
  }

  if (!valid || maxPixel.x < 0.0 || maxPixel.y < 0.0 || minPixel.x >= paramsBuffer[16] || minPixel.y >= paramsBuffer[17]) {
    return ProjectedBounds(false, vec2u(0u), vec2u(0u), 0u);
  }

  let cellScale = vec2f(f32(gridWidth) / paramsBuffer[16], f32(gridHeight) / paramsBuffer[17]);
  let minCell = vec2u(clamp(floor(minPixel * cellScale), vec2f(0.0), vec2f(f32(gridWidth - 1u), f32(gridHeight - 1u))));
  let maxCell = vec2u(clamp(floor(maxPixel * cellScale), vec2f(0.0), vec2f(f32(gridWidth - 1u), f32(gridHeight - 1u))));
  return ProjectedBounds(true, minCell, maxCell, depthQ(minDepth));
}

@compute @workgroup_size(__BUILD_SOURCE_EXPR_0__)
fn main(@builtin(global_invocation_id) globalId: vec3u) {
  let index = globalId.x;
  let chunkCount = u32(paramsBuffer[20]);
  if (index >= chunkCount || occluderMask[index] == 0u) {
    return;
  }

  let projected = projectChunk(index);
  if (!projected.valid) {
    return;
  }
  let gridWidth = u32(paramsBuffer[18]);
  for (var y = projected.minCell.y; y <= projected.maxCell.y; y = y + 1u) {
    for (var x = projected.minCell.x; x <= projected.maxCell.x; x = x + 1u) {
      atomicMin(&depthGrid[y * gridWidth + x], projected.minDepthQ);
    }
  }
}
