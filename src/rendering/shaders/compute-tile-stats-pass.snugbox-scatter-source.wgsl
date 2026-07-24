@group(0) @binding(0) var<storage, read> centerBuffer: array<vec4f>;
@group(0) @binding(1) var<storage, read> tileOffsets: array<u32>;
@group(0) @binding(2) var<storage, read_write> tileCursors: array<atomic<u32>>;
@group(0) @binding(3) var<storage, read_write> tileSplatList: array<u32>;
@group(0) @binding(4) var<storage, read_write> counters: array<atomic<u32>>;
@group(0) @binding(5) var<storage, read> paramsBuffer: array<f32>;
@group(0) @binding(6) var<storage, read> quatsBuffer: array<u32>;
@group(0) @binding(7) var<storage, read> scalesBuffer: array<u32>;
@group(0) @binding(8) var<storage, read> colorBuffer: array<vec4f>;
@group(0) @binding(9) var<storage, read> scaleCodebookBuffer: array<f32>;
@group(0) @binding(10) var<storage, read> chunkInfoBuffer: array<vec4f>;
@group(0) @binding(11) var<storage, read> ordinalToPackedBuffer: array<u32>;

__SNUGBOX_HELPERS__

@compute @workgroup_size(__WORKGROUP_SIZE__)
fn main(@builtin(global_invocation_id) globalId: vec3u) {
  let index = globalId.x;
  let splatCount = u32(paramsBuffer[21]);
  if (index >= splatCount) {
    return;
  }

  let bounds = snugBoxTileBounds(index);
  if (bounds.x < 0) {
    return;
  }

  let tileCols = u32(paramsBuffer[19]);
  let tileCount = u32(paramsBuffer[23]);
  let listCapacity = u32(paramsBuffer[25]);
  for (var tileY = u32(bounds.y); tileY <= u32(bounds.w); tileY = tileY + 1u) {
    for (var tileX = u32(bounds.x); tileX <= u32(bounds.z); tileX = tileX + 1u) {
      let tileIndex = tileY * tileCols + tileX;
      if (tileIndex >= tileCount || tileIndex >= __MAX_TILES__u) {
        continue;
      }
      let local = atomicAdd(&tileCursors[tileIndex], 1u);
      let accepted = atomicLoad(&counters[tileIndex]);
      if (local >= accepted) {
        continue;
      }
      let dst = tileOffsets[tileIndex] + local;
      if (dst < listCapacity) {
        tileSplatList[dst] = index;
      } else {
        atomicAdd(&counters[__OVERFLOW_OFFSET__u], 1u);
      }
    }
  }
}
