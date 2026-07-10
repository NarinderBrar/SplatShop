@group(0) @binding(0) var<storage, read> meansLBuffer: array<u32>;
@group(0) @binding(1) var<storage, read> meansUBuffer: array<u32>;
@group(0) @binding(2) var<storage, read> chunkTable: array<vec4f>;
@group(0) @binding(3) var<storage, read> drawRefs: array<u32>;
@group(0) @binding(4) var<storage, read_write> depthKeys: array<u32>;
@group(0) @binding(5) var<storage, read> paramsBuffer: array<f32>;

const DRAW_REF_LOCAL_MASK: u32 = 1048575u;

fn chan(pixel: u32, component: u32) -> u32 {
  return (pixel >> (component * 8u)) & 255u;
}

fn chunkOrdinal(encoded: u32) -> u32 {
  return encoded >> 20u;
}

fn localIndex(encoded: u32) -> u32 {
  return encoded & DRAW_REF_LOCAL_MASK;
}

fn chunkRow(chunk: u32, row: u32) -> vec4f {
  return chunkTable[chunk * 4u + row];
}

fn decodeCenter(chunk: u32, index: u32) -> vec3f {
  let physicalIndex = u32(chunkRow(chunk, 2u).x) + index;
  let lo = meansLBuffer[physicalIndex];
  let hi = meansUBuffer[physicalIndex];
  let q = vec3f(
    f32((chan(hi, 0u) << 8u) + chan(lo, 0u)) / 65535.0,
    f32((chan(hi, 1u) << 8u) + chan(lo, 1u)) / 65535.0,
    f32((chan(hi, 2u) << 8u) + chan(lo, 2u)) / 65535.0
  );
  let meansMin = chunkRow(chunk, 0u).xyz;
  let meansMax = chunkRow(chunk, 1u).xyz;
  let encoded = meansMin * (vec3f(1.0) - q) + meansMax * q;
  return sign(encoded) * (exp(abs(encoded)) - vec3f(1.0));
}

@compute @workgroup_size(__DEPTH_KEY_SOURCE_EXPR_0__)
fn main(@builtin(global_invocation_id) globalId: vec3u) {
  let index = globalId.x;
  let splatCount = u32(paramsBuffer[8]);
  if (index >= splatCount) {
    return;
  }

  let encoded = drawRefs[index];
  let center = decodeCenter(chunkOrdinal(encoded), localIndex(encoded));
  let cameraPosition = vec3f(paramsBuffer[0], paramsBuffer[1], paramsBuffer[2]);
  let cameraForward = vec3f(paramsBuffer[4], paramsBuffer[5], paramsBuffer[6]);
  let minDepth = paramsBuffer[9];
  let invDepthRange = paramsBuffer[10];
  let maxKey = paramsBuffer[11];
  let depth = dot(center - cameraPosition, cameraForward);
  let normalized = clamp((depth - minDepth) * invDepthRange, 0.0, 1.0);
  depthKeys[index] = u32((1.0 - normalized) * maxKey);
}
