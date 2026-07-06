@group(0) @binding(0) var<storage, read> boundsBuffer: array<vec4f>;
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
    paramsBuffer[0] * point.x + paramsBuffer[4] * point.y + paramsBuffer[8] * point.z + paramsBuffer[12],
    paramsBuffer[1] * point.x + paramsBuffer[5] * point.y + paramsBuffer[9] * point.z + paramsBuffer[13],
    paramsBuffer[2] * point.x + paramsBuffer[6] * point.y + paramsBuffer[10] * point.z + paramsBuffer[14],
    paramsBuffer[3] * point.x + paramsBuffer[7] * point.y + paramsBuffer[11] * point.z + paramsBuffer[15]
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

@compute @workgroup_size(__TEST_SOURCE_EXPR_0__)
fn main(@builtin(global_invocation_id) globalId: vec3u) {
  let index = globalId.x;
  let chunkCount = u32(paramsBuffer[20]);
  if (index >= chunkCount) {
    return;
  }

  atomicAdd(&counters[2], 1u);
  let projected = projectChunk(index);
  var visible = true;

  if (projected.valid) {
    visible = false;
    let gridWidth = u32(paramsBuffer[18]);
    let biasQ = u32(paramsBuffer[21] * 4096.0);
    for (var y = projected.minCell.y; y <= projected.maxCell.y; y = y + 1u) {
      for (var x = projected.minCell.x; x <= projected.maxCell.x; x = x + 1u) {
        let cellDepthQ = atomicLoad(&depthGrid[y * gridWidth + x]);
        if (cellDepthQ == 0xffffffffu || cellDepthQ + biasQ >= projected.minDepthQ) {
          visible = true;
        }
      }
    }
  }

  if (visible) {
    let slot = atomicAdd(&counters[0], 1u);
    visibleIndices[slot] = index;
  } else {
    atomicAdd(&counters[1], 1u);
  }
}
