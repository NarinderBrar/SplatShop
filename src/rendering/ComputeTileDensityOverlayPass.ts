import { Constants } from "@babylonjs/core/Engines/constants";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { Scene } from "@babylonjs/core/scene";

import type { ComputeTileStatsPass } from "./ComputeTileStatsPass";

const VERTEX_SOURCE = `
attribute position: vec3f;

varying vUv: vec2f;

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
  vertexOutputs.position = vec4f(vertexInputs.position.xy, 0.0, 1.0);
  vertexOutputs.vUv = vertexInputs.position.xy * vec2f(0.5, -0.5) + vec2f(0.5);
}
`;

const FRAGMENT_SOURCE = `
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
`;

const isEnabled = (): boolean =>
  new URLSearchParams(window.location.search).get("computeTileDensityRender") === "true";

class ComputeTileDensityOverlayPass {
  private readonly mesh: Mesh;
  private readonly material: ShaderMaterial;

  constructor(scene: Scene, private readonly tileStatsPass: ComputeTileStatsPass) {
    this.mesh = new Mesh("ComputeTileDensityOverlay", scene);
    this.mesh.renderingGroupId = 3;
    this.mesh.isPickable = false;
    this.mesh.alwaysSelectAsActiveMesh = true;
    this.mesh.doNotSyncBoundingInfo = true;

    const positions = new Float32Array([
      -1, -1, 0,
      1, -1, 0,
      1, 1, 0,
      -1, 1, 0,
    ]);
    const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);
    this.mesh.setVerticesData("position", positions, false, 3);
    this.mesh.setIndices(indices);

    this.material = new ShaderMaterial(
      "ComputeTileDensityOverlayMaterial",
      scene,
      {
        vertexSource: VERTEX_SOURCE,
        fragmentSource: FRAGMENT_SOURCE,
      },
      {
        attributes: ["position"],
        uniforms: ["tileCols", "tileRows", "maxTileOccupancy", "opacity"],
        storageBuffers: ["tileCounters"],
        shaderLanguage: ShaderLanguage.WGSL,
      },
    );
    this.material.alphaMode = Constants.ALPHA_COMBINE;
    this.material.disableDepthWrite = true;
    this.material.setStorageBuffer("tileCounters", this.tileStatsPass.getTileCountersBuffer());
    this.material.setFloat("opacity", 0.58);
    this.mesh.material = this.material;
  }

  static isEnabled(): boolean {
    return isEnabled();
  }

  update(): void {
    const stats = this.tileStatsPass.getStats();
    this.material.setFloat("tileCols", stats.tileCols);
    this.material.setFloat("tileRows", stats.tileRows);
    this.material.setFloat("maxTileOccupancy", stats.maxTileOccupancy);
    this.mesh.setEnabled(stats.dispatched && stats.tileCols > 0 && stats.tileRows > 0 && stats.maxTileOccupancy > 0);
  }

  dispose(): void {
    this.mesh.dispose();
    this.material.dispose();
  }
}

export { ComputeTileDensityOverlayPass };
