varying vUv: vec2f;

uniform tileCols: f32;
uniform tileRows: f32;
uniform maxTileOccupancy: f32;
uniform opacity: f32;

var<storage, read> tileCounters: array<u32>;

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  let cols = max(1u, u32(uniforms.tileCols));
  let rows = max(1u, u32(uniforms.tileRows));
  let tileX = min(cols - 1u, u32(clamp(floor(input.vUv.x * f32(cols)), 0.0, f32(cols - 1u))));
  let tileY = min(rows - 1u, u32(clamp(floor(input.vUv.y * f32(rows)), 0.0, f32(rows - 1u))));
  let tileIndex = tileY * cols + tileX;
  let count = f32(tileCounters[tileIndex]);
  if (count <= 0.0 || uniforms.maxTileOccupancy <= 0.0) {
    discard;
  }

  let intensity = clamp(log2(count + 1.0) / log2(uniforms.maxTileOccupancy + 1.0), 0.0, 1.0);
  let cool = vec3f(0.1, 0.7, 1.0);
  let hot = vec3f(1.0, 0.18, 0.04);
  let color = cool * (1.0 - intensity) + hot * intensity;
  let grid = step(0.965, fract(input.vUv.x * f32(cols))) + step(0.965, fract(input.vUv.y * f32(rows)));
  let gridBoost = min(grid, 1.0) * 0.22;
  fragmentOutputs.color = vec4f(color + vec3f(gridBoost), uniforms.opacity * (0.2 + intensity * 0.65));
}
