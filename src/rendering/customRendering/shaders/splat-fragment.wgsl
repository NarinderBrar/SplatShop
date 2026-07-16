struct Uniforms {
  worldViewProjection: mat4x4f,
  view: mat4x4f,
  world: mat4x4f,
  projection: mat4x4f,
  viewportGaussianMinRadius: vec4f,
  quality: vec4f,
  render: vec4f,
  fragment: vec4f,
  meansMin: vec4f,
  meansMax: vec4f,
  offsets0: vec4f,
  offsets1: vec4f,
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) corner: vec2f,
  @location(1) color: vec4f,
};

const EXP4: f32 = 0.01831563888873418;
const INV_ONE_MINUS_EXP4: f32 = 1.018657360363774;

@fragment
fn fsMain(input: VertexOutput) -> @location(0) vec4f {
  let radius2 = dot(input.corner, input.corner);
  if (radius2 > 1.0) {
    discard;
  }

  let splatAlpha = clamp(input.color.a, 0.0, 1.0);
  let effectiveAlpha = select(splatAlpha, 1.0, uniforms.render.y == 1.0);
  let blurScale = max(0.5, uniforms.render.w);
  let alpha = ((exp(-4.0 * radius2 / (blurScale * blurScale)) - EXP4) * INV_ONE_MINUS_EXP4) * effectiveAlpha;
  if (alpha < max(uniforms.render.z, uniforms.fragment.x)) {
    discard;
  }
  return vec4f(max(input.color.rgb, vec3f(0.0)) * alpha, alpha);
}
