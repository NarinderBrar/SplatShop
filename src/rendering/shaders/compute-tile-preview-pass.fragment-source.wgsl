varying vIntensity: f32;
varying vDepthSpan: f32;
varying vCorner: vec2f;

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  if (max(abs(input.vCorner.x), abs(input.vCorner.y)) > 1.0) {
    discard;
  }

  let countColor = vec3f(0.05, 0.85, 1.0) * (1.0 - input.vIntensity) + vec3f(1.0, 0.16, 0.05) * input.vIntensity;
  let depthColor = vec3f(0.7, 0.35, 1.0);
  let color = countColor * (1.0 - input.vDepthSpan * 0.45) + depthColor * (input.vDepthSpan * 0.45);
  let edge = step(0.82, max(abs(input.vCorner.x), abs(input.vCorner.y)));
  fragmentOutputs.color = vec4f(color + vec3f(edge * 0.25), 0.24 + input.vIntensity * 0.56);
}
