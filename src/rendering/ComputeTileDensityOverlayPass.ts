import { Constants } from "@babylonjs/core/Engines/constants";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { Scene } from "@babylonjs/core/scene";

import type { ComputeTileStatsPass } from "./ComputeTileStatsPass";
import ComputeTileDensityOverlayPass_VERTEX_SOURCE_raw from "./shaders/compute-tile-density-overlay-pass.vertex-source.wgsl?raw";
import ComputeTileDensityOverlayPass_FRAGMENT_SOURCE_raw from "./shaders/compute-tile-density-overlay-pass.fragment-source.wgsl?raw";

const VERTEX_SOURCE = ComputeTileDensityOverlayPass_VERTEX_SOURCE_raw;

const FRAGMENT_SOURCE = ComputeTileDensityOverlayPass_FRAGMENT_SOURCE_raw;

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
