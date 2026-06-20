import { StorageBuffer } from "@babylonjs/core/Buffers/storageBuffer";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import type { Nullable } from "@babylonjs/core/types";

import { BufferVersionTracker } from "../rendering/BufferVersionTracker";
import type { SplatData } from "./SplatData";

type PackedSplatArrays = {
  centerScale: Float32Array;
  scale: Float32Array;
  rotationOpacity: Float32Array;
  color: Float32Array;
  indices: Uint32Array;
};

type SplatStorageBuffers = {
  centerScale: StorageBuffer;
  scale: StorageBuffer;
  rotationOpacity: StorageBuffer;
  color: StorageBuffer;
  state: StorageBuffer;
  depthKeys: StorageBuffer;
  sortBucketCounts: StorageBuffer;
  sortBucketOffsets: StorageBuffer;
  sortScratchIndices: StorageBuffer;
  indices: StorageBuffer;
};

type SplatBufferStats = {
  numSplats: number;
  boundsMin: [number, number, number];
  boundsMax: [number, number, number];
  scaleLogMin: number;
  scaleLogMax: number;
  opacityMin: number;
  opacityMax: number;
};

const SH_C0 = 0.28209479177387814;

const sigmoid = (value: number) => {
  if (value > 0) {
    return 1 / (1 + Math.exp(-value));
  }
  const exp = Math.exp(value);
  return exp / (1 + exp);
};

class SplatBuffers {
  readonly packed: PackedSplatArrays;
  readonly stats: SplatBufferStats;
  readonly storage: Nullable<SplatStorageBuffers>;
  readonly bufferVersions = new BufferVersionTracker();

  constructor(engine: unknown, splatData: SplatData | PackedSplatArrays) {
    this.packed = isPackedSplatArrays(splatData) ? splatData : SplatBuffers.pack(splatData);
    this.stats = SplatBuffers.computeStats(this.packed);
    this.storage = engine instanceof WebGPUEngine ? this.createStorageBuffers(engine) : null;
  }

  dispose(): void {
    this.storage?.centerScale.dispose();
    this.storage?.scale.dispose();
    this.storage?.rotationOpacity.dispose();
    this.storage?.color.dispose();
    this.storage?.state.dispose();
    this.storage?.depthKeys.dispose();
    this.storage?.sortBucketCounts.dispose();
    this.storage?.sortBucketOffsets.dispose();
    this.storage?.sortScratchIndices.dispose();
    this.storage?.indices.dispose();
  }

  private createStorageBuffers(engine: WebGPUEngine): SplatStorageBuffers {
    const centerScale = new StorageBuffer(engine, this.packed.centerScale.byteLength, undefined, "SplatCenterScale");
    centerScale.update(this.packed.centerScale);

    const scale = new StorageBuffer(engine, this.packed.scale.byteLength, undefined, "SplatScale");
    scale.update(this.packed.scale);

    const rotationOpacity = new StorageBuffer(
      engine,
      this.packed.rotationOpacity.byteLength,
      undefined,
      "SplatRotationOpacity",
    );
    rotationOpacity.update(this.packed.rotationOpacity);

    const color = new StorageBuffer(engine, this.packed.color.byteLength, undefined, "SplatColor");
    color.update(this.packed.color);

    const stateData = new Uint32Array(this.packed.indices.length);
    const state = new StorageBuffer(engine, Math.max(stateData.byteLength, 4), undefined, "SplatStateDefault");
    state.update(stateData);

    const depthKeysData = new Uint32Array(this.packed.indices.length);
    const depthKeys = new StorageBuffer(engine, depthKeysData.byteLength, undefined, "SplatDepthKeys");
    depthKeys.update(depthKeysData);

    const sortBucketCountsData = new Uint32Array(4096);
    const sortBucketCounts = new StorageBuffer(
      engine,
      sortBucketCountsData.byteLength,
      undefined,
      "SplatSortBucketCounts",
    );
    sortBucketCounts.update(sortBucketCountsData);

    const sortBucketOffsetsData = new Uint32Array(4096);
    const sortBucketOffsets = new StorageBuffer(
      engine,
      sortBucketOffsetsData.byteLength,
      undefined,
      "SplatSortBucketOffsets",
    );
    sortBucketOffsets.update(sortBucketOffsetsData);

    const sortScratchIndicesData = new Uint32Array(this.packed.indices.length);
    const sortScratchIndices = new StorageBuffer(
      engine,
      sortScratchIndicesData.byteLength,
      undefined,
      "SplatSortScratchIndices",
    );
    sortScratchIndices.update(sortScratchIndicesData);

    const indices = new StorageBuffer(engine, this.packed.indices.byteLength, undefined, "SplatIndices");
    indices.update(this.packed.indices);

    const buffers: SplatStorageBuffers = {
      centerScale,
      scale,
      rotationOpacity,
      color,
      state,
      depthKeys,
      sortBucketCounts,
      sortBucketOffsets,
      sortScratchIndices,
      indices,
    };
    this.bufferVersions.trackAll(buffers as unknown as Record<string, StorageBuffer | undefined>);
    return buffers;
  }

  private static pack(splatData: SplatData): PackedSplatArrays {
    const x = splatData.getFloatProp("x");
    const y = splatData.getFloatProp("y");
    const z = splatData.getFloatProp("z");
    const scale0 = splatData.getFloatProp("scale_0");
    const scale1 = splatData.getFloatProp("scale_1");
    const scale2 = splatData.getFloatProp("scale_2");
    const rot0 = splatData.getFloatProp("rot_0");
    const rot1 = splatData.getFloatProp("rot_1");
    const rot2 = splatData.getFloatProp("rot_2");
    const rot3 = splatData.getFloatProp("rot_3");
    const dc0 = splatData.getFloatProp("f_dc_0");
    const dc1 = splatData.getFloatProp("f_dc_1");
    const dc2 = splatData.getFloatProp("f_dc_2");
    const opacity = splatData.getFloatProp("opacity");

    const centerScale = new Float32Array(splatData.numSplats * 4);
    const scale = new Float32Array(splatData.numSplats * 4);
    const rotationOpacity = new Float32Array(splatData.numSplats * 4);
    const color = new Float32Array(splatData.numSplats * 4);
    const indices = new Uint32Array(splatData.numSplats);

    for (let i = 0; i < splatData.numSplats; i++) {
      centerScale[i * 4 + 0] = x[i];
      centerScale[i * 4 + 1] = y[i];
      centerScale[i * 4 + 2] = z[i];
      centerScale[i * 4 + 3] = Math.max(scale0[i], scale1[i], scale2[i]);

      scale[i * 4 + 0] = scale0[i];
      scale[i * 4 + 1] = scale1[i];
      scale[i * 4 + 2] = scale2[i];
      scale[i * 4 + 3] = centerScale[i * 4 + 3];

      rotationOpacity[i * 4 + 0] = rot0[i];
      rotationOpacity[i * 4 + 1] = rot1[i];
      rotationOpacity[i * 4 + 2] = rot2[i];
      rotationOpacity[i * 4 + 3] = rot3[i];

      color[i * 4 + 0] = 0.5 + SH_C0 * dc0[i];
      color[i * 4 + 1] = 0.5 + SH_C0 * dc1[i];
      color[i * 4 + 2] = 0.5 + SH_C0 * dc2[i];
      color[i * 4 + 3] = sigmoid(opacity[i]);

      indices[i] = i;
    }

    return {
      centerScale,
      scale,
      rotationOpacity,
      color,
      indices,
    };
  }

  private static computeStats(packed: PackedSplatArrays): SplatBufferStats {
    const splatCount = packed.centerScale.length / 4;
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
    let scaleLogMin = Number.POSITIVE_INFINITY;
    let scaleLogMax = Number.NEGATIVE_INFINITY;
    let opacityMin = Number.POSITIVE_INFINITY;
    let opacityMax = Number.NEGATIVE_INFINITY;

    for (let i = 0; i < splatCount; i++) {
      const offset = i * 4;
      for (let axis = 0; axis < 3; axis++) {
        const position = packed.centerScale[offset + axis];
        boundsMin[axis] = Math.min(boundsMin[axis], position);
        boundsMax[axis] = Math.max(boundsMax[axis], position);

        const logScale = packed.scale[offset + axis];
        scaleLogMin = Math.min(scaleLogMin, logScale);
        scaleLogMax = Math.max(scaleLogMax, logScale);
      }

      const opacity = packed.color[offset + 3];
      opacityMin = Math.min(opacityMin, opacity);
      opacityMax = Math.max(opacityMax, opacity);
    }

    return {
      numSplats: splatCount,
      boundsMin,
      boundsMax,
      scaleLogMin,
      scaleLogMax,
      opacityMin,
      opacityMax,
    };
  }
}

const isPackedSplatArrays = (value: SplatData | PackedSplatArrays): value is PackedSplatArrays =>
  "centerScale" in value && "scale" in value && "rotationOpacity" in value && "color" in value && "indices" in value;

export { SplatBuffers };
export type { PackedSplatArrays, SplatBufferStats, SplatStorageBuffers };
