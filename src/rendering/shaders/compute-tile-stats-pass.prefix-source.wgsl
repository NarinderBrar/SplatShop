@group(0) @binding(0) var<storage, read_write> counters: array<u32>;
@group(0) @binding(1) var<storage, read_write> tileOffsets: array<u32>;
@group(0) @binding(2) var<storage, read> paramsBuffer: array<f32>;

@compute @workgroup_size(1)
fn main() {
  let tileCount = u32(paramsBuffer[23]);
  let listCapacity = u32(paramsBuffer[25]);
  var total = 0u;
  var truncated = 0u;
  for (var i = 0u; i < tileCount; i = i + 1u) {
    let requested = counters[i];
    let accepted = min(requested, listCapacity - min(total, listCapacity));
    tileOffsets[i] = total;
    counters[i] = accepted;
    total = total + accepted;
    truncated = truncated + requested - accepted;
  }
  tileOffsets[tileCount] = total;
  counters[__PAIR_OFFSET__u] = total;
  counters[__OVERFLOW_OFFSET__u] = counters[__OVERFLOW_OFFSET__u] + truncated;
}
