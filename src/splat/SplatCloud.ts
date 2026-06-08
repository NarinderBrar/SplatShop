import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Scene } from "@babylonjs/core/scene";

import { CompositeSplatRenderPass } from "../rendering/CompositeSplatRenderPass";
import { PackedSogRenderPass } from "../rendering/PackedSogRenderPass";
import { SplatRenderPass } from "../rendering/SplatRenderPass";
import { StreamingSsogRenderPass } from "../rendering/StreamingSsogRenderPass";
import type { SplatAsset } from "./SplatAsset";
import { SogBuffers } from "./SogBuffers";
import type { SplatData } from "./SplatData";
import { SplatBuffers } from "./SplatBuffers";
import { SplatPreview } from "./SplatPreview";

const requireWebGpuForPackedAsset = (scene: Scene, assetKind: string): void => {
  if (!scene.getEngine().isWebGPU) {
    throw new Error(`${assetKind} packed rendering requires WebGPU; the viewer started in WebGL mode.`);
  }
};

class SplatCloud {
  readonly buffers?: SplatBuffers;
  readonly sogBuffers?: SogBuffers;
  readonly ssogBuffers?: SogBuffers[];
  readonly bufferStats: {
    numSplats: number;
    boundsMin: [number, number, number];
    boundsMax: [number, number, number];
    scaleLogMin?: number;
    scaleLogMax?: number;
    opacityMin?: number;
    opacityMax?: number;
  };
  readonly preview: SplatPreview;
  readonly renderPass: SplatRenderPass | PackedSogRenderPass | CompositeSplatRenderPass | StreamingSsogRenderPass;

  constructor(
    readonly filename: string,
    readonly asset: SplatAsset,
    scene: Scene,
  ) {
    this.preview = new SplatPreview();

    if (asset.kind === "sog" && asset.packed.enabled) {
      requireWebGpuForPackedAsset(scene, "SOG");
      this.sogBuffers = new SogBuffers(scene.getEngine(), asset.packed.data);
      this.renderPass = new PackedSogRenderPass(scene, this.sogBuffers);
      this.bufferStats = this.sogBuffers.stats;
    } else if (asset.kind === "ssog" && asset.entries && asset.loadChunk) {
      requireWebGpuForPackedAsset(scene, "SSOG");
      this.renderPass = new StreamingSsogRenderPass(scene, asset.entries, asset.loadChunk);
      this.bufferStats = {
        numSplats: asset.stats.sourceSplats,
        boundsMin: asset.stats.boundsMin ?? [0, 0, 0],
        boundsMax: asset.stats.boundsMax ?? [0, 0, 0],
      };
    } else if (asset.kind === "ssog" && asset.chunks.length > 0) {
      requireWebGpuForPackedAsset(scene, "SSOG");
      this.ssogBuffers = asset.chunks.map((chunk) => new SogBuffers(scene.getEngine(), chunk.data));
      this.renderPass = new CompositeSplatRenderPass({
        scene,
        chunks: asset.chunks,
        passes: this.ssogBuffers.map((buffers) => new PackedSogRenderPass(scene, buffers)),
      });
      this.bufferStats = this.mergeSogStats(this.ssogBuffers);
    } else if (asset.data) {
      const splatData: SplatData = asset.data;
      this.buffers = new SplatBuffers(scene.getEngine(), splatData);
      this.preview.setData(splatData);
      this.renderPass = new SplatRenderPass(scene, this.buffers);
      this.bufferStats = this.buffers.stats;
    } else {
      throw new Error(`Unsupported splat asset runtime: ${asset.kind}`);
    }

    this.preview.setVisible(false);
  }

  get splatData(): SplatData {
    if (!this.asset.data) {
      throw new Error("Packed SOG assets do not expose expanded SplatData.");
    }
    return this.asset.data;
  }

  getCenterAndRadius(): { center: Vector3; radius: number } | undefined {
    const previewFraming = this.preview.getCenterAndRadius();
    if (previewFraming) {
      return previewFraming;
    }

    const boundsMin = this.asset.stats.boundsMin;
    const boundsMax = this.asset.stats.boundsMax;
    if (!boundsMin || !boundsMax) {
      return undefined;
    }

    const center = new Vector3(
      (boundsMin[0] + boundsMax[0]) * 0.5,
      (boundsMin[1] + boundsMax[1]) * 0.5,
      (boundsMin[2] + boundsMax[2]) * 0.5,
    );
    const radius = Math.max(0.001, Vector3.Distance(center, new Vector3(boundsMax[0], boundsMax[1], boundsMax[2])));
    return { center, radius };
  }

  dispose(): void {
    this.renderPass.dispose();
    this.preview.dispose();
    this.buffers?.dispose();
    this.sogBuffers?.dispose();
    this.ssogBuffers?.forEach((buffers) => buffers.dispose());
  }

  private mergeSogStats(buffers: SogBuffers[]): SplatCloud["bufferStats"] {
    const boundsMin: [number, number, number] = [
      Number.POSITIVE_INFINITY,
      Number.POSITIVE_INFINITY,
      Number.POSITIVE_INFINITY,
    ];
    const boundsMax: [number, number, number] = [
      Number.NEGATIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ];
    let numSplats = 0;

    for (const buffer of buffers) {
      numSplats += buffer.stats.numSplats;
      for (let axis = 0; axis < 3; axis++) {
        boundsMin[axis] = Math.min(boundsMin[axis], buffer.stats.boundsMin[axis]);
        boundsMax[axis] = Math.max(boundsMax[axis], buffer.stats.boundsMax[axis]);
      }
    }

    return { numSplats, boundsMin, boundsMax };
  }
}

export { SplatCloud };
