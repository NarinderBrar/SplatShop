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
import { SelectionPass, type SelectionSource } from "./SelectionPass";
import type { SelectionMode } from "../app/createUI";

type NdcPoint = {
  x: number;
  y: number;
};

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
  readonly selectionPass?: SelectionPass;

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
      this.selectionPass = this.tryCreateSelectionPass(
        scene,
        {
          centers: this.sogBuffers.packed.centers,
          centerStride: 3,
          colors: this.sogBuffers.getSelectionColorData(),
        },
        this.sogBuffers.stats.numSplats,
      );
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
      if (this.buffers.storage) {
        this.selectionPass = this.tryCreateSelectionPass(
          scene,
          {
            centers: this.buffers.packed.centerScale,
            centerStride: 4,
            colors: this.buffers.packed.color,
          },
          this.buffers.stats.numSplats,
        );
      }
    } else {
      throw new Error(`Unsupported splat asset runtime: ${asset.kind}`);
    }

    if (this.selectionPass && "setSplatStateBuffer" in this.renderPass) {
      (this.renderPass as { setSplatStateBuffer: (b: import("@babylonjs/core/Buffers/storageBuffer").StorageBuffer) => void }).setSplatStateBuffer(this.selectionPass.getStateBuffer().storage);
    }

    this.preview.setVisible(false);
  }

  private tryCreateSelectionPass(
    scene: Scene,
    source: SelectionSource,
    numSplats: number,
  ): SelectionPass | undefined {
    if (!scene.getEngine().isWebGPU) {
      return undefined;
    }
    try {
      return new SelectionPass(scene, source, numSplats);
    } catch {
      return undefined;
    }
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

  setVizMode(mode: number): void {
    const pass = this.renderPass;
    if ("setVizMode" in pass) {
      (pass as unknown as { setVizMode: (m: number) => void }).setVizMode(mode);
    }
  }

  setDebugChunkBoundsVisible(visible: boolean): void {
    const pass = this.renderPass;
    if ("setDebugChunkBoundsVisible" in pass) {
      (pass as unknown as { setDebugChunkBoundsVisible: (v: boolean) => void }).setDebugChunkBoundsVisible(visible);
    }
  }

  setLodScale(scale: number): void {
    const pass = this.renderPass;
    if ("setLodScale" in pass) {
      (pass as unknown as { setLodScale: (v: number) => void }).setLodScale(scale);
    }
  }

  selectPoint(
    ndcX: number,
    ndcY: number,
    threshold: number,
    selectionMode: SelectionMode,
    selectBehind: boolean,
    viewProjection: Float32Array,
  ): Promise<number> {
    return this.selectionPass?.selectPoint(ndcX, ndcY, threshold, selectionMode, selectBehind, viewProjection) ?? Promise.resolve(0);
  }

  selectRect(
    minX: number,
    minY: number,
    maxX: number,
    maxY: number,
    selectionMode: SelectionMode,
    selectBehind: boolean,
    viewProjection: Float32Array,
  ): Promise<number> {
    return this.selectionPass?.selectRect(minX, minY, maxX, maxY, selectionMode, selectBehind, viewProjection) ?? Promise.resolve(0);
  }

  selectCircle(
    centerX: number,
    centerY: number,
    radius: number,
    selectionMode: SelectionMode,
    selectBehind: boolean,
    viewProjection: Float32Array,
  ): Promise<number> {
    return this.selectionPass?.selectCircle(centerX, centerY, radius, selectionMode, selectBehind, viewProjection) ?? Promise.resolve(0);
  }

  selectLasso(
    points: readonly NdcPoint[],
    selectionMode: SelectionMode,
    selectBehind: boolean,
    viewProjection: Float32Array,
  ): Promise<number> {
    return this.selectionPass?.selectLasso(points, selectionMode, selectBehind, viewProjection) ?? Promise.resolve(0);
  }

  clearSelection(): Promise<number> {
    return this.selectionPass?.clearSelection() ?? Promise.resolve(0);
  }

  get hasSelection(): boolean {
    return this.selectionPass !== undefined;
  }

  dispose(): void {
    this.renderPass.dispose();
    this.preview.dispose();
    this.buffers?.dispose();
    this.sogBuffers?.dispose();
    this.ssogBuffers?.forEach((buffers) => buffers.dispose());
    this.selectionPass?.dispose();
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
