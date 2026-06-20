@group(0) @binding(0) var<storage, read_write> counters: array<u32>;
@group(0) @binding(1) var<storage, read> paramsBuffer: array<f32>;

@compute @workgroup_size(__CLEAR_SOURCE_EXPR_0__)
fn main(@builtin(global_invocation_id) globalId: vec3u) {
  let index = globalId.x;
  let counterCount = u32(paramsBuffer[22]);
  if (index >= counterCount) {
    return;
  }
  counters[index] = 0u;
}
