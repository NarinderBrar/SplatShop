@group(0) @binding(0) var<storage, read> chunkBuildTable: array<vec4u>;
@group(0) @binding(1) var<storage, read_write> drawRefs: array<u32>;

@compute @workgroup_size(__DRAW_REF_BUILD_SOURCE_EXPR_0__)
fn main(
  @builtin(workgroup_id) workgroupId: vec3u,
  @builtin(local_invocation_id) localId: vec3u,
) {
  let chunk = chunkBuildTable[workgroupId.x];
  let drawOffset = chunk.x;
  let splatCount = chunk.y;
  let encodedChunk = chunk.z << 20u;

  var localIndex = localId.x;
  while (localIndex < splatCount) {
    drawRefs[drawOffset + localIndex] = encodedChunk | localIndex;
    localIndex += __DRAW_REF_BUILD_SOURCE_EXPR_0__u;
  }
}
