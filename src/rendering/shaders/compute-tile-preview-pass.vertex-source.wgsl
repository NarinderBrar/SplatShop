attribute position: vec3f;

uniform tileCols: f32;
uniform tileRows: f32;
uniform workTileCount: f32;
uniform maxTileSplats: f32;
uniform markerScale: f32;

var<storage, read> workQueue: array<vec4u>;
var<storage, read> workDepthRanges: array<vec4f>;

varying vIntensity: f32;
varying vDepthSpan: f32;
varying vCorner: vec2f;

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
  let slot = vertexInputs.instanceIndex;
  if (f32(slot) >= uniforms.workTileCount || uniforms.tileCols <= 0.0 || uniforms.tileRows <= 0.0) {
    vertexOutputs.position = vec4f(0.0, 0.0, 2.0, 1.0);
    vertexOutputs.vIntensity = 0.0;
    vertexOutputs.vDepthSpan = 0.0;
    vertexOutputs.vCorner = vec2f(2.0);
    return vertexOutputs;
  }

  let entry = workQueue[slot];
  let tileIndex = entry.x;
  let tileCount = f32(entry.z);
  let cols = max(1u, u32(uniforms.tileCols));
  let tileX = tileIndex % cols;
  let tileY = tileIndex / cols;
  let tileSize = vec2f(2.0 / uniforms.tileCols, 2.0 / uniforms.tileRows);
  let tileMin = vec2f(-1.0, 1.0) + vec2f(f32(tileX), -f32(tileY + 1u)) * tileSize;
  let tileCenter = tileMin + vec2f(tileSize.x * 0.5, tileSize.y * 0.5);
  let marker = tileSize * clamp(uniforms.markerScale, 0.08, 0.95);
  let corner = vertexInputs.position.xy;

  let depth = workDepthRanges[slot];
  let depthSpan = max(0.0, depth.y - depth.x);
  vertexOutputs.position = vec4f(tileCenter + corner * marker * 0.5, 0.0, 1.0);
  vertexOutputs.vIntensity = clamp(log2(tileCount + 1.0) / log2(max(2.0, uniforms.maxTileSplats + 1.0)), 0.0, 1.0);
  vertexOutputs.vDepthSpan = clamp(log2(depthSpan + 1.0) / 8.0, 0.0, 1.0);
  vertexOutputs.vCorner = corner;
}
