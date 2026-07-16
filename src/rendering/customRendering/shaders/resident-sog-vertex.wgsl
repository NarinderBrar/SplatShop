@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var<storage, read> meansLBuffer: array<u32>;
@group(0) @binding(2) var<storage, read> meansUBuffer: array<u32>;
@group(0) @binding(3) var<storage, read> quatsBuffer: array<u32>;
@group(0) @binding(4) var<storage, read> scalesBuffer: array<u32>;
@group(0) @binding(5) var<storage, read> colorBuffer: array<vec4f>;
@group(0) @binding(6) var<storage, read> stateBuffer: array<u32>;
@group(0) @binding(7) var<storage, read> scaleCodebookBuffer: array<f32>;
@group(0) @binding(8) var<storage, read> chunkTable: array<vec4f>;
@group(0) @binding(9) var<storage, read> sortedRefs: array<u32>;

const SQRT2: f32 = 1.4142135623730951;
const DRAW_REF_LOCAL_MASK: u32 = 1048575u;

fn channel(pixel: u32, component: u32) -> u32 {
  return (pixel >> (component * 8u)) & 255u;
}

fn chunkRow(chunk: u32, row: u32) -> vec4f {
  return chunkTable[chunk * 4u + row];
}

fn physicalIndex(chunk: u32, localIndex: u32) -> u32 {
  return u32(chunkRow(chunk, 2u).x) + localIndex;
}

fn decodeResidentCenter(chunk: u32, index: u32) -> vec3f {
  let sourceIndex = physicalIndex(chunk, index);
  let lo = meansLBuffer[sourceIndex];
  let hi = meansUBuffer[sourceIndex];
  let q = vec3f(
    f32((channel(hi, 0u) << 8u) + channel(lo, 0u)) / 65535.0,
    f32((channel(hi, 1u) << 8u) + channel(lo, 1u)) / 65535.0,
    f32((channel(hi, 2u) << 8u) + channel(lo, 2u)) / 65535.0,
  );
  let encoded = chunkRow(chunk, 0u).xyz * (vec3f(1.0) - q) + chunkRow(chunk, 1u).xyz * q;
  return sign(encoded) * (exp(abs(encoded)) - vec3f(1.0));
}

fn decodeResidentRotation(sourceIndex: u32) -> vec4f {
  let pixel = quatsBuffer[sourceIndex];
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

fn decodeResidentScale(chunk: u32, sourceIndex: u32) -> vec3f {
  let pixel = scalesBuffer[sourceIndex];
  let offset = u32(chunkRow(chunk, 2u).y);
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

  let encoded = sortedRefs[sourceOrder];
  let chunk = encoded >> 20u;
  let localIndex = encoded & DRAW_REF_LOCAL_MASK;
  let sourceIndex = physicalIndex(chunk, localIndex);
  let state = stateBuffer[sourceIndex];
  if ((state & SPLAT_STATE_RENDER_DISABLED) != 0u) {
    return hiddenVertex();
  }

  let center = decodeResidentCenter(chunk, localIndex);
  let corner = quadCorner(vertexIndex);
  let centerClip = uniforms.worldViewProjection * vec4f(center, 1.0);
  var output: VertexOutput;
  output.position = splatPosition(
    center,
    normalize(decodeResidentRotation(sourceIndex)),
    exp(decodeResidentScale(chunk, sourceIndex)),
    corner,
    centerClip,
  );
  output.corner = corner;
  output.color = displayColor(colorBuffer[sourceIndex], state, chunk, localIndex / 4096u);
  return output;
}
