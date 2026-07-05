@group(0) @binding(0) var<storage, read> centerBuffer: array<vec4f>;
@group(0) @binding(1) var<storage, read_write> depthKeyBuffer: array<u32>;
@group(0) @binding(2) var<storage, read> paramsBuffer: array<f32>;

@compute @workgroup_size(__COMPUTE_SOURCE_EXPR_0__)
fn main(@builtin(global_invocation_id) globalId: vec3u) {
  let index = globalId.x;
  let splatCount = u32(paramsBuffer[8]);
  if (index >= splatCount) {
    return;
  }

  let centerOffset = u32(paramsBuffer[12]);
  let center = centerBuffer[centerOffset + index].xyz;
  let cameraPosition = vec3f(paramsBuffer[0], paramsBuffer[1], paramsBuffer[2]);
  let cameraForward = vec3f(paramsBuffer[4], paramsBuffer[5], paramsBuffer[6]);
  let minDepth = paramsBuffer[9];
  let invDepthRange = paramsBuffer[10];
  let maxKey = paramsBuffer[11];
  let depth = dot(center - cameraPosition, cameraForward);
  let normalized = clamp((depth - minDepth) * invDepthRange, 0.0, 1.0);
  depthKeyBuffer[index] = u32((1.0 - normalized) * maxKey);
}
