@group(0) @binding(0) var<storage, read> boundsBuffer: array<vec4f>;
@group(0) @binding(1) var<storage, read_write> visibilityMask: array<u32>;
@group(0) @binding(2) var<storage, read_write> visibleIndices: array<u32>;
@group(0) @binding(3) var<storage, read_write> counters: array<atomic<u32>>;
@group(0) @binding(4) var<storage, read> paramsBuffer: array<f32>;

fn aabbVisible(index: u32) -> bool {
  let minBounds = boundsBuffer[index * 2u].xyz;
  let maxBounds = boundsBuffer[index * 2u + 1u].xyz;
  let margin = paramsBuffer[25];

  for (var planeIndex = 0u; planeIndex < 6u; planeIndex = planeIndex + 1u) {
    let offset = planeIndex * 4u;
    let normal = vec3f(paramsBuffer[offset + 0u], paramsBuffer[offset + 1u], paramsBuffer[offset + 2u]);
    let planeD = paramsBuffer[offset + 3u];
    let positive = select(minBounds, maxBounds, normal >= vec3f(0.0));
    if (dot(normal, positive) + planeD < -margin) {
      return false;
    }
  }

  return true;
}

@compute @workgroup_size(__COMPUTE_SOURCE_EXPR_0__)
fn main(@builtin(global_invocation_id) globalId: vec3u) {
  let index = globalId.x;
  let chunkCount = u32(paramsBuffer[24]);
  if (index >= chunkCount) {
    return;
  }

  if (aabbVisible(index)) {
    visibilityMask[index] = 1u;
    let visibleSlot = atomicAdd(&counters[0], 1u);
    visibleIndices[visibleSlot] = index;
  } else {
    visibilityMask[index] = 0u;
    atomicAdd(&counters[1], 1u);
  }
}
