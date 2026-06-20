varying vIntensity: f32;
varying vSampleT: f32;
varying vCorner: vec2f;
varying vColor: vec4f;
varying vCoverageAlpha: f32;

uniform minAlpha: f32;
uniform maxAlpha: f32;
uniform alphaClip: f32;
uniform alphaScale: f32;

const EXP4: f32 = 0.01831563888873418;
const INV_ONE_MINUS_EXP4: f32 = 1.018657360363774;

fn normExp(x: f32) -> f32 {
  return (exp(-4.0 * x) - EXP4) * INV_ONE_MINUS_EXP4;
}

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  let radius2 = dot(input.vCorner, input.vCorner);
  if (radius2 > 1.0) {
    discard;
  }

  let color = max(input.vColor.rgb, vec3f(0.0));
  let alpha = normExp(radius2) * clamp(input.vColor.a * uniforms.alphaScale * input.vCoverageAlpha, uniforms.minAlpha, uniforms.maxAlpha);
  if (alpha < uniforms.alphaClip) {
    discard;
  }
  fragmentOutputs.color = vec4f(color * alpha, alpha);
}
