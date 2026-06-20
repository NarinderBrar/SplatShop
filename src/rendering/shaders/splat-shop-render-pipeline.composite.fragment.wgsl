varying vUV: vec2f;
var textureSamplerSampler: sampler;
var textureSampler: texture_2d<f32>;
uniform time: f32;
uniform strength: f32;

#define CUSTOM_FRAGMENT_DEFINITIONS

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  let color = textureSample(textureSampler, textureSamplerSampler, input.vUV);
  let vignette = smoothstep(0.92, 0.2, distance(input.vUV, vec2f(0.5, 0.5)));
  let pulse = 0.5 + 0.5 * sin(uniforms.time * 0.9);
  let warmLift = vec3f(0.06, 0.025, -0.015) * uniforms.strength * pulse;
  fragmentOutputs.color = vec4f(color.rgb * (0.82 + 0.18 * vignette) + warmLift, color.a);
}
