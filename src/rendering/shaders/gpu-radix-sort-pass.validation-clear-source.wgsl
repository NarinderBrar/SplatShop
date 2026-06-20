@group(0) @binding(0) var<storage, read_write> counters: array<atomic<u32>>;

@compute @workgroup_size(4)
fn main(@builtin(global_invocation_id) globalId: vec3u) {
  if (globalId.x < 8u) {
    atomicStore(&counters[globalId.x], 0u);
  }
}
