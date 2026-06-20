@group(0) @binding(0) var<storage, read> counters: array<u32>;
@group(0) @binding(1) var<storage, read_write> tileOffsets: array<u32>;
@group(0) @binding(2) var<storage, read> paramsBuffer: array<f32>;

@compute @workgroup_size(1)
fn main() {
  let tileCount = u32(paramsBuffer[23]);
  var total = 0u;
  for (var i = 0u; i < tileCount; i = i + 1u) {
    tileOffsets[i] = total;
    total = total + counters[i];
  }
  tileOffsets[tileCount] = total;
}
