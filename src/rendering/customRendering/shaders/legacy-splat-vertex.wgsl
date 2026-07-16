@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var<storage, read> centerScaleBuffer: array<vec4f>;
@group(0) @binding(2) var<storage, read> scaleBuffer: array<vec4f>;
@group(0) @binding(3) var<storage, read> rotationBuffer: array<vec4f>;
@group(0) @binding(4) var<storage, read> colorBuffer: array<vec4f>;
@group(0) @binding(5) var<storage, read> colorGroupBuffer: array<u32>;
@group(0) @binding(6) var<storage, read> stateBuffer: array<u32>;
@group(0) @binding(7) var<storage, read> indexBuffer: array<u32>;

@vertex
fn vsMain(@builtin(vertex_index) vertexIndex: u32, @builtin(instance_index) instanceIndex: u32) -> VertexOutput {
  let sourceOrder = instanceIndex * SPLATS_PER_INSTANCE + vertexIndex / 6u;
  if (f32(sourceOrder) >= uniforms.render.x) {
    return hiddenVertex();
  }

  let splatIndex = indexBuffer[sourceOrder];
  let state = stateBuffer[splatIndex];
  if ((state & SPLAT_STATE_RENDER_DISABLED) != 0u) {
    return hiddenVertex();
  }

  let centerScale = centerScaleBuffer[splatIndex];
  let corner = quadCorner(vertexIndex);
  let centerClip = uniforms.worldViewProjection * vec4f(centerScale.xyz, 1.0);
  var output: VertexOutput;
  output.position = splatPosition(
    centerScale.xyz,
    normalize(rotationBuffer[splatIndex]),
    exp(scaleBuffer[splatIndex].xyz) * uniforms.viewportGaussianMinRadius.z,
    corner,
    centerClip,
  );
  output.corner = corner;
  output.color = displayColor(colorBuffer[splatIndex], state, splatIndex, colorGroupBuffer[splatIndex]);
  return output;
}
