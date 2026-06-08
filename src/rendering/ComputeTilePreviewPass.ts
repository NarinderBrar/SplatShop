import { Constants } from "@babylonjs/core/Engines/constants";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { Scene } from "@babylonjs/core/scene";

import type { ComputeTileStatsPass } from "./ComputeTileStatsPass";
import type { ComputeTileWorkQueuePass } from "./ComputeTileWorkQueuePass";

const DEFAULT_PREVIEW_TILE_LIMIT = 512;

const getPreviewTileLimit = (): number => {
  const value = Number(new URLSearchParams(window.location.search).get("computeTilePreviewTileLimit"));
  if (!Number.isFinite(value) || value <= 0) {
    return DEFAULT_PREVIEW_TILE_LIMIT;
  }
  return Math.max(1, Math.floor(value));
};

const VERTEX_SOURCE = `
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
`;

const FRAGMENT_SOURCE = `
varying vIntensity: f32;
varying vDepthSpan: f32;
varying vCorner: vec2f;

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  if (max(abs(input.vCorner.x), abs(input.vCorner.y)) > 1.0) {
    discard;
  }

  let countColor = vec3f(0.05, 0.85, 1.0) * (1.0 - input.vIntensity) + vec3f(1.0, 0.16, 0.05) * input.vIntensity;
  let depthColor = vec3f(0.7, 0.35, 1.0);
  let color = countColor * (1.0 - input.vDepthSpan * 0.45) + depthColor * (input.vDepthSpan * 0.45);
  let edge = step(0.82, max(abs(input.vCorner.x), abs(input.vCorner.y)));
  fragmentOutputs.color = vec4f(color + vec3f(edge * 0.25), 0.24 + input.vIntensity * 0.56);
}
`;

const isEnabled = (): boolean =>
  new URLSearchParams(window.location.search).get("computeTilePreview") === "true";

class ComputeTilePreviewPass {
  private readonly mesh: Mesh;
  private readonly material: ShaderMaterial;
  private readonly previewTileLimit = getPreviewTileLimit();

  constructor(
    scene: Scene,
    private readonly tileStatsPass: ComputeTileStatsPass,
    private readonly workQueuePass: ComputeTileWorkQueuePass,
  ) {
    this.mesh = new Mesh("ComputeTilePreview", scene);
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
      "ComputeTilePreviewMaterial",
      scene,
      {
        vertexSource: VERTEX_SOURCE,
        fragmentSource: FRAGMENT_SOURCE,
      },
      {
        attributes: ["position"],
        uniforms: ["tileCols", "tileRows", "workTileCount", "maxTileSplats", "markerScale"],
        storageBuffers: ["workQueue", "workDepthRanges"],
        needAlphaBlending: true,
        shaderLanguage: ShaderLanguage.WGSL,
      },
    );
    this.material.alphaMode = Constants.ALPHA_COMBINE;
    this.material.disableDepthWrite = true;
    this.material.setStorageBuffer("workQueue", this.workQueuePass.getWorkQueueBuffer());
    this.material.setStorageBuffer("workDepthRanges", this.workQueuePass.getWorkDepthRangesBuffer());
    this.material.setFloat("markerScale", 0.42);
    this.mesh.material = this.material;
  }

  static isEnabled(): boolean {
    return isEnabled();
  }

  update(): void {
    const tileStats = this.tileStatsPass.getStats();
    const workStats = this.workQueuePass.getStats();
    const previewTiles = Math.min(workStats.workTiles, this.previewTileLimit);
    this.material.setFloat("tileCols", tileStats.tileCols);
    this.material.setFloat("tileRows", tileStats.tileRows);
    this.material.setFloat("workTileCount", previewTiles);
    this.material.setFloat("maxTileSplats", workStats.maxTileSplats);
    this.mesh.forcedInstanceCount = Math.max(0, previewTiles);
    this.mesh.setEnabled(
      workStats.dispatched &&
        previewTiles > 0 &&
        tileStats.tileCols > 0 &&
        tileStats.tileRows > 0 &&
        workStats.maxTileSplats > 0,
    );
  }

  dispose(): void {
    this.mesh.dispose();
    this.material.dispose();
  }
}

export { ComputeTilePreviewPass };
