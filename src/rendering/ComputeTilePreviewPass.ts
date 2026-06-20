import { Constants } from "@babylonjs/core/Engines/constants";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { Scene } from "@babylonjs/core/scene";

import type { ComputeTileStatsPass } from "./ComputeTileStatsPass";
import type { ComputeTileWorkQueuePass } from "./ComputeTileWorkQueuePass";
import ComputeTilePreviewPass_VERTEX_SOURCE_raw from "./shaders/compute-tile-preview-pass.vertex-source.wgsl?raw";
import ComputeTilePreviewPass_FRAGMENT_SOURCE_raw from "./shaders/compute-tile-preview-pass.fragment-source.wgsl?raw";

const DEFAULT_PREVIEW_TILE_LIMIT = 512;

const getPreviewTileLimit = (): number => {
  const value = Number(new URLSearchParams(window.location.search).get("computeTilePreviewTileLimit"));
  if (!Number.isFinite(value) || value <= 0) {
    return DEFAULT_PREVIEW_TILE_LIMIT;
  }
  return Math.max(1, Math.floor(value));
};

const VERTEX_SOURCE = ComputeTilePreviewPass_VERTEX_SOURCE_raw;

const FRAGMENT_SOURCE = ComputeTilePreviewPass_FRAGMENT_SOURCE_raw;

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
