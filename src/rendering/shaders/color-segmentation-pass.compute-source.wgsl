@group(0) @binding(0) var<storage, read> colorBuffer: array<vec4f>;
@group(0) @binding(1) var<storage, read_write> colorGroupBuffer: array<u32>;
@group(0) @binding(2) var<storage, read> paramsBuffer: array<f32>;

@compute @workgroup_size(__COMPUTE_SOURCE_EXPR_0__)
fn main(@builtin(global_invocation_id) globalId: vec3u) {
  let index = globalId.x;
  let splatCount = u32(paramsBuffer[0]);
  let colorOffset = u32(paramsBuffer[1]);
  if (index >= splatCount) {
    return;
  }

  let color = colorBuffer[colorOffset + index].rgb;
  let r = u32(color.r * 255.0) >> 5u;
  let g = u32(color.g * 255.0) >> 5u;
  let b = u32(color.b * 255.0) >> 5u;
  colorGroupBuffer[index] = (r << 6u) | (g << 3u) | b;
}
