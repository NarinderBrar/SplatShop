@group(0) @binding(2) var<storage, read_write> depthGrid: array<atomic<u32>>;
@group(0) @binding(5) var<storage, read> paramsBuffer: array<f32>;

@compute @workgroup_size(__CLEAR_SOURCE_EXPR_0__)
fn main(@builtin(global_invocation_id) globalId: vec3u) {
  let index = globalId.x;
  let gridWidth = u32(paramsBuffer[18]);
  let gridHeight = u32(paramsBuffer[19]);
  if (index >= gridWidth * gridHeight) {
    return;
  }
  atomicStore(&depthGrid[index], 0xffffffffu);
}
