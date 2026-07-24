import { StorageBuffer } from "@babylonjs/core/Buffers/storageBuffer";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import type { Nullable } from "@babylonjs/core/types";

import { BufferVersionTracker } from "../rendering/BufferVersionTracker";
import type { GpuBufferWriter, GpuBufferWriterArenaAllocation } from "../rendering/GpuBufferWriter";
import type { SogPackedData } from "./SplatAsset";

type SogStorageBuffers = {
  meansL: StorageBuffer;
  meansU: StorageBuffer;
  quats: StorageBuffer;
  scales: StorageBuffer;
  sh0: StorageBuffer;
  color: StorageBuffer;
  state: StorageBuffer;
  scaleCodebook: StorageBuffer;
  sh0Codebook: StorageBuffer;
  centers: StorageBuffer;
  depthKeys: StorageBuffer;
  sortBucketCounts: StorageBuffer;
  sortBucketOffsets: StorageBuffer;
  sortScratchIndices: StorageBuffer;
  indices: StorageBuffer;
  shNCentroids?: StorageBuffer;
  shNLabels?: StorageBuffer;
  shNCodebook?: StorageBuffer;
};

type SogStorageBufferOffsets = {
  centers: number;
  meansL: number;
  meansU: number;
  quats: number;
  scales: number;
  color: number;
  state: number;
  scaleCodebook: number;
};

type SogBufferStats = {
  numSplats: number;
  boundsMin: [number, number, number];
  boundsMax: [number, number, number];
  shMode: "dc" | "sh";
  shNFileCount: number;
  shNCodebookLength: number;
  shBands: number;
  shCoeffCount: number;
  shPaletteCount: number;
  shRenderMode: "dc" | "loaded" | "cpu";
};

class SogBuffers {
  indices: Uint32Array;
  readonly stats: SogBufferStats;
  storage: Nullable<SogStorageBuffers>;
  readonly storageOffsets: SogStorageBufferOffsets = {
    centers: 0,
    meansL: 0,
    meansU: 0,
    quats: 0,
    scales: 0,
    color: 0,
    state: 0,
    scaleCodebook: 0,
  };
  readonly bufferVersions = new BufferVersionTracker();
  private dcColorData?: Float32Array;
  private colorData?: Float32Array;

  private readonly writer: GpuBufferWriter | undefined;
  private readonly poolKey: string | undefined;
  private readonly arenaAllocations = new Map<keyof SogStorageBufferOffsets, GpuBufferWriterArenaAllocation>();
  private scaleCodebookArenaAllocation: GpuBufferWriterArenaAllocation | undefined;

  constructor(
    private readonly engine: unknown,
    readonly packed: SogPackedData,
    writer?: GpuBufferWriter,
    poolKey?: string,
    createGpuStorage = true,
  ) {
    this.writer = writer;
    this.poolKey = poolKey;
    this.indices = createGpuStorage ? this.createIdentityIndices() : new Uint32Array(0);

    if (createGpuStorage) {
      this.ensureColorData();
    }
    this.stats = {
      numSplats: packed.numSplats,
      boundsMin: packed.boundsMin,
      boundsMax: packed.boundsMax,
      shMode: packed.shN && packed.shN.fileCount > 0 ? "sh" : "dc",
      shNFileCount: packed.shN?.fileCount ?? 0,
      shNCodebookLength: packed.shN?.codebookLength ?? 0,
      shBands: packed.shN?.bands ?? 0,
      shCoeffCount: packed.shN?.coeffsPerChannel ?? 0,
      shPaletteCount: packed.shN?.paletteCount ?? 0,
      shRenderMode: packed.shN ? "loaded" : "dc",
    };
    this.storage = createGpuStorage && engine instanceof WebGPUEngine ? this.createStorageBuffers(engine) : null;
  }

  ensureStorage(): Nullable<SogStorageBuffers> {
    if (!this.storage && this.engine instanceof WebGPUEngine) {
      if (this.indices.length !== this.packed.numSplats) {
        this.indices = this.createIdentityIndices();
      }
      this.storage = this.createStorageBuffers(this.engine);
    }
    return this.storage;
  }

  dispose(): void {
    if (!this.storage) {
      return;
    }

    this.releaseArenaStorageBuffer("meansL", "SogMeansL", this.storage.meansL);
    this.releaseArenaStorageBuffer("meansU", "SogMeansU", this.storage.meansU);
    this.releaseArenaStorageBuffer("quats", "SogQuats", this.storage.quats);
    this.releaseArenaStorageBuffer("scales", "SogScales", this.storage.scales);
    this.releaseStorageBuffer("SogSh0", this.storage.sh0);
    this.releaseArenaStorageBuffer("color", "SogColor", this.storage.color);
    this.releaseArenaStorageBuffer("state", "SogStateDefault", this.storage.state);
    this.releaseScaleCodebookBuffer(this.storage.scaleCodebook);
    this.releaseStorageBuffer("SogSh0Codebook", this.storage.sh0Codebook);
    this.releaseArenaStorageBuffer("centers", "SogCenters", this.storage.centers);
    this.releaseStorageBuffer("SogDepthKeys", this.storage.depthKeys);
    this.releaseStorageBuffer("SogSortBucketCounts", this.storage.sortBucketCounts);
    this.releaseStorageBuffer("SogSortBucketOffsets", this.storage.sortBucketOffsets);
    this.releaseStorageBuffer("SogSortScratchIndices", this.storage.sortScratchIndices);
    this.releaseStorageBuffer("SogIndices", this.storage.indices);
    this.releaseOptionalStorageBuffer("SogShNCentroids", this.storage.shNCentroids);
    this.releaseOptionalStorageBuffer("SogShNLabels", this.storage.shNLabels);
    this.releaseOptionalStorageBuffer("SogShNCodebook", this.storage.shNCodebook);
  }

  private createStorageBuffers(engine: WebGPUEngine): SogStorageBuffers {
    const make = (name: string, data: Uint32Array | Float32Array) => {
      if (this.writer) {
        return this.writer.createStorageBufferWithFallback(name, data, this.poolKey);
      }
      const buffer = new StorageBuffer(engine, data.byteLength, undefined, name);
      buffer.update(data);
      return buffer;
    };
    const centers = new Float32Array(this.packed.numSplats * 4);
    for (let i = 0; i < this.packed.numSplats; i++) {
      centers[i * 4 + 0] = this.packed.centers[i * 3 + 0];
      centers[i * 4 + 1] = this.packed.centers[i * 3 + 1];
      centers[i * 4 + 2] = this.packed.centers[i * 3 + 2];
      centers[i * 4 + 3] = 1;
    }
    const depthKeys = new Uint32Array(this.packed.numSplats);
    const state = new Uint32Array(this.packed.numSplats);
    const sortBucketCounts = new Uint32Array(4096);
    const sortBucketOffsets = new Uint32Array(4096);
    const sortScratchIndices = new Uint32Array(this.packed.numSplats);

    const buffers: SogStorageBuffers = {
      meansL: this.makeArenaStorageBuffer("meansL", "SogMeansL", this.packed.meansL, make),
      meansU: this.makeArenaStorageBuffer("meansU", "SogMeansU", this.packed.meansU, make),
      quats: this.makeArenaStorageBuffer("quats", "SogQuats", this.packed.quats, make),
      scales: this.makeArenaStorageBuffer("scales", "SogScales", this.packed.scales, make),
      sh0: make("SogSh0", this.packed.sh0),
      color: this.makeFloat32ArenaStorageBuffer("color", "SogColor", this.ensureColorData(), make),
      state: this.makeArenaStorageBuffer("state", "SogStateDefault", state, make),
      scaleCodebook: this.makeScaleCodebookBuffer(make),
      sh0Codebook: make("SogSh0Codebook", this.packed.sh0Codebook),
      centers: this.makeFloat32ArenaStorageBuffer("centers", "SogCenters", centers, make),
      depthKeys: make("SogDepthKeys", depthKeys),
      sortBucketCounts: make("SogSortBucketCounts", sortBucketCounts),
      sortBucketOffsets: make("SogSortBucketOffsets", sortBucketOffsets),
      sortScratchIndices: make("SogSortScratchIndices", sortScratchIndices),
      indices: make("SogIndices", this.indices),
    };
    if (this.packed.shN) {
      buffers.shNCentroids = make("SogShNCentroids", this.packed.shN.centroids);
      buffers.shNLabels = make("SogShNLabels", this.packed.shN.labels);
      buffers.shNCodebook = make("SogShNCodebook", this.packed.shN.codebook);
    }

    this.bufferVersions.trackAll(buffers as unknown as Record<string, StorageBuffer | undefined>);
    return buffers;
  }

  private makeArenaStorageBuffer(
    offsetKey: keyof SogStorageBufferOffsets,
    name: string,
    data: Uint32Array,
    make: (name: string, data: Uint32Array | Float32Array) => StorageBuffer,
  ): StorageBuffer {
    if (this.writer && this.poolKey) {
      const allocation = this.writer.allocateUint32ArenaBuffer(`${this.poolKey}:${offsetKey}`, name, data);
      this.arenaAllocations.set(offsetKey, allocation);
      this.storageOffsets[offsetKey] = allocation.elementOffset;
      return allocation.buffer;
    }

    this.storageOffsets[offsetKey] = 0;
    return make(name, data);
  }

  private makeFloat32ArenaStorageBuffer(
    offsetKey: keyof SogStorageBufferOffsets,
    name: string,
    data: Float32Array,
    make: (name: string, data: Uint32Array | Float32Array) => StorageBuffer,
  ): StorageBuffer {
    if (this.writer && this.poolKey) {
      const allocation = this.writer.allocateFloat32ArenaBuffer(`${this.poolKey}:${offsetKey}`, name, data);
      this.arenaAllocations.set(offsetKey, allocation);
      this.storageOffsets[offsetKey] = allocation.elementOffset;
      return allocation.buffer;
    }

    this.storageOffsets[offsetKey] = 0;
    return make(name, data);
  }

  private makeScaleCodebookBuffer(make: (name: string, data: Uint32Array | Float32Array) => StorageBuffer): StorageBuffer {
    if (this.writer && this.poolKey) {
      this.scaleCodebookArenaAllocation = this.writer.allocateFloat32ArenaBuffer(
        `${this.poolKey}:scaleCodebook`,
        "SogScaleCodebook",
        this.packed.scaleCodebook,
      );
      this.storageOffsets.scaleCodebook = this.scaleCodebookArenaAllocation.elementOffset;
      return this.scaleCodebookArenaAllocation.buffer;
    }

    this.storageOffsets.scaleCodebook = 0;
    return make("SogScaleCodebook", this.packed.scaleCodebook);
  }

  updateCpuShColors(cameraPosition: { x: number; y: number; z: number }): number {
    const shN = this.packed.shN;
    if (!shN || !this.storage) {
      return 0;
    }

    const start = performance.now();
    const coeffs = shN.coeffsPerChannel;
    const codebook = shN.codebook;
    const centroids = shN.centroids;
    const labels = shN.labels;
    const dcColors = this.ensureDcColorData();
    const colors = this.ensureColorData();
    const centers = this.packed.centers;
    const stride = shN.centroidWidth;

    for (let i = 0; i < this.packed.numSplats; i++) {
      const centerOffset = i * 3;
      const dx = cameraPosition.x - centers[centerOffset + 0];
      const dy = cameraPosition.y - centers[centerOffset + 1];
      const dz = cameraPosition.z - centers[centerOffset + 2];
      const invLen = 1 / Math.max(1e-6, Math.hypot(dx, dy, dz));
      const basis = evalShBasis(dx * invLen, dy * invLen, dz * invLen, coeffs);
      const label = labels[i];
      const paletteIndex = (label & 0xff) | (((label >>> 8) & 0xff) << 8);
      const paletteX = paletteIndex % 64;
      const paletteY = Math.floor(paletteIndex / 64);
      const colorOffset = i * 4;
      let r = dcColors[colorOffset + 0];
      let g = dcColors[colorOffset + 1];
      let b = dcColors[colorOffset + 2];

      for (let coeff = 0; coeff < coeffs; coeff++) {
        const pixel = centroids[paletteY * stride + paletteX * coeffs + coeff];
        const basisValue = basis[coeff];
        r += codebook[pixel & 0xff] * basisValue;
        g += codebook[(pixel >>> 8) & 0xff] * basisValue;
        b += codebook[(pixel >>> 16) & 0xff] * basisValue;
      }

      colors[colorOffset + 0] = r;
      colors[colorOffset + 1] = g;
      colors[colorOffset + 2] = b;
    }

    this.storage.color.update(colors, this.storageOffsets.color * Float32Array.BYTES_PER_ELEMENT, colors.byteLength);
    this.bufferVersions.bump(this.storage.color);
    this.stats.shRenderMode = "cpu";
    return performance.now() - start;
  }

  getSelectionColorData(): Float32Array {
    return this.ensureColorData();
  }

  private ensureDcColorData(): Float32Array {
    if (!this.dcColorData) {
      this.dcColorData = this.createDcColorData();
    }
    return this.dcColorData;
  }

  private ensureColorData(): Float32Array {
    if (!this.colorData) {
      const dcColorData = this.ensureDcColorData();
      this.colorData = this.packed.shN ? dcColorData.slice() : dcColorData;
    }
    return this.colorData;
  }

  private createDcColorData(): Float32Array {
    const out = new Float32Array(this.packed.numSplats * 4);
    for (let i = 0; i < this.packed.numSplats; i++) {
      const pixel = this.packed.sh0[i];
      const offset = i * 4;
      out[offset + 0] = 0.5 + this.packed.sh0Codebook[chan(pixel, 0)] * SH_C0;
      out[offset + 1] = 0.5 + this.packed.sh0Codebook[chan(pixel, 1)] * SH_C0;
      out[offset + 2] = 0.5 + this.packed.sh0Codebook[chan(pixel, 2)] * SH_C0;
      out[offset + 3] = chan(pixel, 3) / 255;
    }
    return out;
  }

  private createIdentityIndices(): Uint32Array {
    const indices = new Uint32Array(this.packed.numSplats);
    for (let index = 0; index < indices.length; index++) {
      indices[index] = index;
    }
    return indices;
  }

  private releaseOptionalStorageBuffer(name: string, buffer: StorageBuffer | undefined): void {
    if (buffer) {
      this.releaseStorageBuffer(name, buffer);
    }
  }

  private releaseStorageBuffer(name: string, buffer: StorageBuffer): void {
    if (this.writer && this.poolKey) {
      this.writer.releaseStorageBuffer(name, buffer, this.poolKey);
    } else {
      buffer.dispose();
    }
  }

  private releaseArenaStorageBuffer(offsetKey: keyof SogStorageBufferOffsets, name: string, buffer: StorageBuffer): void {
    const allocation = this.arenaAllocations.get(offsetKey);
    if (this.writer && allocation) {
      this.writer.releaseArenaAllocation(allocation);
      this.arenaAllocations.delete(offsetKey);
      return;
    }
    this.releaseStorageBuffer(name, buffer);
  }

  private releaseScaleCodebookBuffer(buffer: StorageBuffer): void {
    if (this.writer && this.scaleCodebookArenaAllocation) {
      this.writer.releaseArenaAllocation(this.scaleCodebookArenaAllocation);
      this.scaleCodebookArenaAllocation = undefined;
      return;
    }
    this.releaseStorageBuffer("SogScaleCodebook", buffer);
  }
}

const SH_C0 = 0.28209479177387814;
const SH_C1 = 0.4886025119029199;
const SH_C2 = [
  1.0925484305920792,
  -1.0925484305920792,
  0.31539156525252005,
  -1.0925484305920792,
  0.5462742152960396,
];
const SH_C3 = [
  -0.5900435899266435,
  2.890611442640554,
  -0.4570457994644658,
  0.3731763325901154,
  -0.4570457994644658,
  1.445305721320277,
  -0.5900435899266435,
];

const chan = (pixel: number, component: number): number => (pixel >>> (component * 8)) & 0xff;

const evalShBasis = (x: number, y: number, z: number, coeffs: number): number[] => {
  const basis = new Array<number>(coeffs).fill(0);
  if (coeffs >= 3) {
    basis[0] = -SH_C1 * y;
    basis[1] = SH_C1 * z;
    basis[2] = -SH_C1 * x;
  }
  if (coeffs >= 8) {
    basis[3] = SH_C2[0] * x * y;
    basis[4] = SH_C2[1] * y * z;
    basis[5] = SH_C2[2] * (2 * z * z - x * x - y * y);
    basis[6] = SH_C2[3] * x * z;
    basis[7] = SH_C2[4] * (x * x - y * y);
  }
  if (coeffs >= 15) {
    basis[8] = SH_C3[0] * y * (3 * x * x - y * y);
    basis[9] = SH_C3[1] * x * y * z;
    basis[10] = SH_C3[2] * y * (4 * z * z - x * x - y * y);
    basis[11] = SH_C3[3] * z * (2 * z * z - 3 * x * x - 3 * y * y);
    basis[12] = SH_C3[4] * x * (4 * z * z - x * x - y * y);
    basis[13] = SH_C3[5] * z * (x * x - y * y);
    basis[14] = SH_C3[6] * x * (x * x - 3 * y * y);
  }
  return basis;
};

export { SogBuffers };
export type { SogBufferStats, SogStorageBufferOffsets, SogStorageBuffers };
