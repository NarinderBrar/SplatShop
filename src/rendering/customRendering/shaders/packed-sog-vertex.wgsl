@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var<storage, read> meansLBuffer: array<u32>;
@group(0) @binding(2) var<storage, read> meansUBuffer: array<u32>;
@group(0) @binding(3) var<storage, read> quatsBuffer: array<u32>;
@group(0) @binding(4) var<storage, read> scalesBuffer: array<u32>;
@group(0) @binding(5) var<storage, read> colorBuffer: array<vec4f>;
@group(0) @binding(6) var<storage, read> colorGroupBuffer: array<u32>;
@group(0) @binding(7) var<storage, read> stateBuffer: array<u32>;
@group(0) @binding(8) var<storage, read> scaleCodebookBuffer: array<f32>;
@group(0) @binding(9) var<storage, read> indexBuffer: array<u32>;

const SQRT2: f32 = 1.4142135623730951;

fn channel(pixel: u32, component: u32) -> u32 {
  return (pixel >> (component * 8u)) & 255u;
}

fn decodeCenter(index: u32) -> vec3f {
  let lo = meansLBuffer[u32(uniforms.offsets0.x) + index];
  let hi = meansUBuffer[u32(uniforms.offsets0.y) + index];
  let q = vec3f(
    f32((channel(hi, 0u) << 8u) + channel(lo, 0u)) / 65535.0,
    f32((channel(hi, 1u) << 8u) + channel(lo, 1u)) / 65535.0,
    f32((channel(hi, 2u) << 8u) + channel(lo, 2u)) / 65535.0,
  );
  let encoded = uniforms.meansMin.xyz * (vec3f(1.0) - q) + uniforms.meansMax.xyz * q;
  return sign(encoded) * (exp(abs(encoded)) - vec3f(1.0));
}

fn decodeRotation(index: u32) -> vec4f {
  let pixel = quatsBuffer[u32(uniforms.offsets0.z) + index];
  let a = (f32(channel(pixel, 0u)) / 255.0 - 0.5) * SQRT2;
  let b = (f32(channel(pixel, 1u)) / 255.0 - 0.5) * SQRT2;
  let c = (f32(channel(pixel, 2u)) / 255.0 - 0.5) * SQRT2;
  let d = sqrt(max(0.0, 1.0 - (a * a + b * b + c * c)));
  let mode = channel(pixel, 3u) - 252u;
  if (mode == 0u) { return vec4f(d, a, b, c); }
  if (mode == 1u) { return vec4f(a, d, b, c); }
  if (mode == 2u) { return vec4f(a, b, d, c); }
  return vec4f(a, b, c, d);
}

fn decodeScale(index: u32) -> vec3f {
  let pixel = scalesBuffer[u32(uniforms.offsets0.w) + index];
  let offset = u32(uniforms.offsets1.z);
  return vec3f(
    scaleCodebookBuffer[offset + channel(pixel, 0u)],
    scaleCodebookBuffer[offset + channel(pixel, 1u)],
    scaleCodebookBuffer[offset + channel(pixel, 2u)],
  );
}

@vertex
fn vsMain(@builtin(vertex_index) vertexIndex: u32, @builtin(instance_index) instanceIndex: u32) -> VertexOutput {
  let sourceOrder = instanceIndex * SPLATS_PER_INSTANCE + vertexIndex / 6u;
  if (f32(sourceOrder) >= uniforms.render.x) {
    return hiddenVertex();
  }

  let splatIndex = indexBuffer[sourceOrder];
  let state = stateBuffer[u32(uniforms.offsets1.y) + splatIndex];
  if ((state & SPLAT_STATE_RENDER_DISABLED) != 0u) {
    return hiddenVertex();
  }

  let center = decodeCenter(splatIndex);
  let corner = quadCorner(vertexIndex);
  let centerClip = uniforms.worldViewProjection * vec4f(center, 1.0);
  var output: VertexOutput;
  output.position = splatPosition(center, normalize(decodeRotation(splatIndex)), exp(decodeScale(splatIndex)), corner, centerClip);
  output.corner = corner;
  output.color = displayColor(
    colorBuffer[u32(uniforms.offsets1.x) + splatIndex],
    state,
    splatIndex,
    colorGroupBuffer[splatIndex],
  );
  return output;
}
