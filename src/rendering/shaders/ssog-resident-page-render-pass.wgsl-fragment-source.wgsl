varying vCorner: vec2f;
varying vColor: vec4f;

uniform vizMode: f32;
uniform minAlpha: f32;
uniform blurAmount: f32;

const EXP4: f32 = 0.01831563888873418;
const INV_ONE_MINUS_EXP4: f32 = 1.018657360363774;

#define CUSTOM_FRAGMENT_DEFINITIONS

fn normExp(x: f32) -> f32 {
  return (exp(-4.0 * x) - EXP4) * INV_ONE_MINUS_EXP4;
}

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  let radius2 = dot(input.vCorner, input.vCorner);
  if (radius2 > 1.0) {
    discard;
  }
  let splatAlpha = clamp(input.vColor.a, 0.0, 1.0);
  let effectiveAlpha = select(splatAlpha, 1.0, uniforms.vizMode == 1.0);
  let blurScale = max(0.5, uniforms.blurAmount);
  let alpha = normExp(radius2 / (blurScale * blurScale)) * effectiveAlpha;
  if (alpha < max(uniforms.minAlpha, __WGSL_FRAGMENT_SOURCE_EXPR_0__)) {
    discard;
  }
  fragmentOutputs.color = vec4f(max(input.vColor.rgb, vec3f(0.0)) * alpha, alpha);
}
