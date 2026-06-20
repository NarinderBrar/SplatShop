attribute position: vec3f;

varying vUv: vec2f;

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
  vertexOutputs.position = vec4f(vertexInputs.position.xy, 0.0, 1.0);
  vertexOutputs.vUv = vertexInputs.position.xy * vec2f(0.5, -0.5) + vec2f(0.5);
}
