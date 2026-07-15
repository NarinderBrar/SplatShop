import { StorageBuffer } from "@babylonjs/core/Buffers/storageBuffer";
import { ComputeShader } from "@babylonjs/core/Compute/computeShader";
import { Constants } from "@babylonjs/core/Engines/constants";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader";
import { Vector2, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { Scene } from "@babylonjs/core/scene";

import type { SogBuffers } from "../splat/SogBuffers";
import { BufferVersionTracker } from "./BufferVersionTracker";
import { GpuRadixSortPass, type GpuRadixSortStats } from "./GpuRadixSortPass";
import { getSplatShaderQualityProfile } from "./qualityProfiles";
import type { SsogGpuPageAllocation } from "./SsogGpuPagePool";
import SsogResidentPageRenderPass_DEPTH_KEY_SOURCE_raw from "./shaders/ssog-resident-page-render-pass.depth-key-source.wgsl?raw";
import SsogResidentPageRenderPass_INDEX_GATHER_SOURCE_raw from "./shaders/ssog-resident-page-render-pass.index-gather-source.wgsl?raw";
import SsogResidentPageRenderPass_WGSL_VERTEX_SOURCE_raw from "./shaders/ssog-resident-page-render-pass.wgsl-vertex-source.wgsl?raw";
import SsogResidentPageRenderPass_WGSL_FRAGMENT_SOURCE_raw from "./shaders/ssog-resident-page-render-pass.wgsl-fragment-source.wgsl?raw";

type ResidentGlobalChunk = {
  key: string;
  buffers: SogBuffers;
  pageAllocation: SsogGpuPageAllocation;
  splatCount: number;
  boundsMin: [number, number, number];
  boundsMax: [number, number, number];
  lod: number;
};

type ResidentGlobalUpdate = {
  chunks: ResidentGlobalChunk[];
  cameraPosition: Vector3;
  cameraForward: Vector3;
};

type SsogResidentPageStats = {
  residentGlobalActive: boolean;
  residentGlobalRebuilds: number;
  residentGlobalMetadataBytesUploaded: number;
  residentGlobalAttributeBytesReused: number;
  residentGlobalBuildMs: number;
  residentGlobalActiveChunks: number;
  residentGlobalDrawSplats: number;
  residentGlobalGpuDepthMs: number;
  residentGlobalGpuSortMs: number;
  residentGlobalGpuGatherMs: number;
  residentGlobalGpuSorted: boolean;
  residentGlobalMetadataUpdateFrames: number;
  residentGlobalMetadataSkippedFrames: number;
  residentGlobalViewSortFrames: number;
};

type ResidentChunkAllocation = {
  key: string;
  splatOffset: number;
  splatCount: number;
  scaleCodebookOffset: number;
  scaleCodebookCount: number;
  meansMins: [number, number, number];
  meansMaxs: [number, number, number];
};

type ResidentPhysicalBuffers = {
  meansL: StorageBuffer;
  meansU: StorageBuffer;
  quats: StorageBuffer;
  scales: StorageBuffer;
  color: StorageBuffer;
  state: StorageBuffer;
  scaleCodebook: StorageBuffer;
};

const SHADER_QUALITY = getSplatShaderQualityProfile();
const SPLATS_PER_INSTANCE = 128;
const CHUNK_TABLE_FLOATS = 16;
const DEPTH_KEY_WORKGROUP_SIZE = 256;
const INDEX_GATHER_WORKGROUP_SIZE = 256;
const DEFAULT_SPLAT_CAPACITY = 65_536;
const DEFAULT_SCALE_CODEBOOK_CAPACITY = 4096;
const DRAW_REF_LOCAL_BITS = 20;

const WGSL_VERTEX_SOURCE = SsogResidentPageRenderPass_WGSL_VERTEX_SOURCE_raw;
const WGSL_FRAGMENT_SOURCE = SsogResidentPageRenderPass_WGSL_FRAGMENT_SOURCE_raw.replaceAll(
  "__WGSL_FRAGMENT_SOURCE_EXPR_0__",
  String(SHADER_QUALITY.alphaClip.toFixed(10)),
);
const DEPTH_KEY_SOURCE = SsogResidentPageRenderPass_DEPTH_KEY_SOURCE_raw.replaceAll(
  "__DEPTH_KEY_SOURCE_EXPR_0__",
  String(DEPTH_KEY_WORKGROUP_SIZE),
);
const INDEX_GATHER_SOURCE = SsogResidentPageRenderPass_INDEX_GATHER_SOURCE_raw.replaceAll(
  "__INDEX_GATHER_SOURCE_EXPR_0__",
  String(INDEX_GATHER_WORKGROUP_SIZE),
);

const getResidentAttributeBytes = (chunk: ResidentGlobalChunk): number => {
  const data = chunk.buffers.packed;
  return (
    data.meansL.byteLength +
    data.meansU.byteLength +
    data.quats.byteLength +
    data.scales.byteLength +
    data.sh0.byteLength +
    data.scaleCodebook.byteLength +
    data.sh0Codebook.byteLength +
    data.centers.byteLength +
    (data.shN?.centroids.byteLength ?? 0) +
    (data.shN?.labels.byteLength ?? 0) +
    (data.shN?.codebook.byteLength ?? 0)
  );
};

const roundUpPowerOfTwo = (value: number): number => {
  let out = 1;
  while (out < value) {
    out *= 2;
  }
  return out;
};

class SsogResidentPageRenderPass {
  private readonly engine: WebGPUEngine;
  private readonly mesh: Mesh;
  private readonly material: ShaderMaterial;
  private readonly bufferVersions = new BufferVersionTracker();
  private readonly viewport = new Vector2(1, 1);
  private readonly updateViewport: () => void;
  private physicalBuffers?: ResidentPhysicalBuffers;
  private splatCapacity = 0;
  private scaleCodebookCapacity = 0;
  private splatCount = 0;
  private scaleCodebookCount = 0;
  private readonly allocations = new Map<string, ResidentChunkAllocation>();
  private physicalMeansLData = new Uint32Array(0);
  private physicalMeansUData = new Uint32Array(0);
  private physicalQuatsData = new Uint32Array(0);
  private physicalScalesData = new Uint32Array(0);
  private physicalStateData = new Uint32Array(0);
  private physicalColorData = new Float32Array(0);
  private physicalScaleCodebookData = new Float32Array(0);
  private chunkTableBuffer: StorageBuffer;
  private drawRefsBuffer: StorageBuffer;
  private sortedOrdinalsBuffer: StorageBuffer;
  private sortedRefsBuffer: StorageBuffer;
  private depthKeysBuffer: StorageBuffer;
  private depthParamsBuffer: StorageBuffer;
  private gatherParamsBuffer: StorageBuffer;
  private chunkTableData = new Float32Array(4);
  private drawRefsData = new Uint32Array(1);
  private chunkTableCapacity = 4;
  private drawRefCapacity = 1;
  private depthParamsData = new Float32Array(16);
  private gatherParamsData = new Uint32Array(4);
  private depthKeyShader?: ComputeShader;
  private gatherShader: ComputeShader;
  private radixSortPass?: GpuRadixSortPass;
  private enabled = false;
  private rebuilds = 0;
  private metadataBytesUploaded = 0;
  private attributeBytesReused = 0;
  private buildMs = 0;
  private lastDepthMs = 0;
  private lastSortMs = 0;
  private lastGatherMs = 0;
  private activeChunks = 0;
  private drawSplats = 0;
  private lastViewportWidth = 0;
  private lastViewportHeight = 0;
  private lastVizMode = 0;
  private lastChunkTableSignature = Number.NaN;
  private lastDrawRefsSignature = Number.NaN;
  private activeBounds: { min: [number, number, number]; max: [number, number, number] } = {
    min: [0, 0, 0],
    max: [0, 0, 0],
  };
  private metadataUpdateFrames = 0;
  private metadataSkippedFrames = 0;
  private viewSortFrames = 0;

  constructor(private readonly scene: Scene) {
    const engine = scene.getEngine();
    if (!(engine instanceof WebGPUEngine)) {
      throw new Error("Resident SSOG rendering requires Babylon WebGPU storage buffers.");
    }
    this.engine = engine;
    this.mesh = new Mesh("SsogResidentPageRenderPassQuads", scene);
    this.mesh.isPickable = false;
    this.mesh.hasVertexAlpha = true;
    this.mesh.alwaysSelectAsActiveMesh = true;
    this.mesh.doNotSyncBoundingInfo = true;
    this.material = this.createMaterial(scene);
    this.mesh.material = this.material;
    this.chunkTableBuffer = createStorageBuffer(engine, "SsogResidentChunkTable", this.chunkTableData);
    this.drawRefsBuffer = createStorageBuffer(engine, "SsogResidentDrawRefs", this.drawRefsData);
    this.sortedOrdinalsBuffer = createStorageBuffer(engine, "SsogResidentSortedOrdinals", new Uint32Array(1));
    this.sortedRefsBuffer = createStorageBuffer(engine, "SsogResidentSortedRefs", new Uint32Array(1));
    this.depthKeysBuffer = createStorageBuffer(engine, "SsogResidentDepthKeys", new Uint32Array(1));
    this.depthParamsBuffer = createStorageBuffer(engine, "SsogResidentDepthParams", this.depthParamsData);
    this.gatherParamsBuffer = createStorageBuffer(engine, "SsogResidentGatherParams", this.gatherParamsData);
    this.ensurePhysicalCapacity(DEFAULT_SPLAT_CAPACITY, DEFAULT_SCALE_CODEBOOK_CAPACITY);
    this.depthKeyShader = this.createDepthKeyShader();
    this.gatherShader = this.createGatherShader();
    this.buildGeometry();
    this.bindStorageBuffers();
    this.setRenderCount(0);

    this.updateViewport = () => {
      const renderEngine = scene.getEngine();
      const w = renderEngine.getRenderWidth(true);
      const h = renderEngine.getRenderHeight(true);
      if (w !== this.lastViewportWidth || h !== this.lastViewportHeight) {
        this.viewport.set(w, h);
        this.material.setVector2("viewport", this.viewport);
        this.lastViewportWidth = w;
        this.lastViewportHeight = h;
      }
    };
    scene.registerBeforeRender(this.updateViewport);
    this.updateViewport();
  }

  updateActiveChunks(chunks: ResidentGlobalChunk[]): void {
    const start = performance.now();
    this.activeChunks = chunks.length;
    this.drawSplats = chunks.reduce((sum, chunk) => sum + chunk.splatCount, 0);
    this.attributeBytesReused = chunks.reduce((sum, chunk) => sum + getResidentAttributeBytes(chunk), 0);
    this.activeBounds = this.computeActiveBounds(chunks);
    this.ensureChunksUploaded(chunks);
    this.updateMetadata(chunks);
    this.setRenderCount(this.drawSplats);
    this.buildMs = performance.now() - start;
  }

  updateView(cameraPosition: Vector3, cameraForward: Vector3): void {
    this.viewSortFrames++;
    this.dispatchGpuSort(cameraPosition, cameraForward);
  }

  setVizMode(mode: number): void {
    if (this.lastVizMode === mode) {
      return;
    }
    this.lastVizMode = mode;
    this.material.setFloat("vizMode", mode);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.mesh.setEnabled(enabled);
  }

  getStats(): SsogResidentPageStats {
    return {
      residentGlobalActive: this.enabled,
      residentGlobalRebuilds: this.rebuilds,
      residentGlobalMetadataBytesUploaded: this.metadataBytesUploaded,
      residentGlobalAttributeBytesReused: this.attributeBytesReused,
      residentGlobalBuildMs: this.buildMs,
      residentGlobalActiveChunks: this.activeChunks,
      residentGlobalDrawSplats: this.drawSplats,
      residentGlobalGpuDepthMs: this.lastDepthMs,
      residentGlobalGpuSortMs: this.lastSortMs,
      residentGlobalGpuGatherMs: this.lastGatherMs,
      residentGlobalGpuSorted: !!this.radixSortPass?.getStats().dispatched,
      residentGlobalMetadataUpdateFrames: this.metadataUpdateFrames,
      residentGlobalMetadataSkippedFrames: this.metadataSkippedFrames,
      residentGlobalViewSortFrames: this.viewSortFrames,
    };
  }

  dispose(): void {
    this.scene.unregisterBeforeRender(this.updateViewport);
    this.radixSortPass?.dispose();
    this.disposePhysicalBuffers();
    this.chunkTableBuffer.dispose();
    this.drawRefsBuffer.dispose();
    this.sortedOrdinalsBuffer.dispose();
    this.sortedRefsBuffer.dispose();
    this.depthKeysBuffer.dispose();
    this.depthParamsBuffer.dispose();
    this.gatherParamsBuffer.dispose();
    this.mesh.dispose();
    this.material.dispose();
  }

  private ensureChunksUploaded(chunks: ResidentGlobalChunk[]): void {
    let requiredSplats = this.splatCount;
    let requiredScaleCodebook = this.scaleCodebookCount;
    const newChunks = chunks.filter((chunk) => !this.allocations.has(chunk.key));
    for (const chunk of newChunks) {
      requiredSplats += chunk.splatCount;
      requiredScaleCodebook += chunk.buffers.packed.scaleCodebook.length;
    }
    this.ensurePhysicalCapacity(requiredSplats, requiredScaleCodebook);

    for (const chunk of newChunks) {
      const data = chunk.buffers.packed;
      const color = chunk.buffers.getSelectionColorData();
      const splatOffset = this.splatCount;
      const scaleCodebookOffset = this.scaleCodebookCount;
      const state = new Uint32Array(chunk.splatCount);
      this.physicalMeansLData.set(data.meansL, splatOffset);
      this.physicalMeansUData.set(data.meansU, splatOffset);
      this.physicalQuatsData.set(data.quats, splatOffset);
      this.physicalScalesData.set(data.scales, splatOffset);
      this.physicalStateData.set(state, splatOffset);
      this.physicalColorData.set(color, splatOffset * 4);
      this.physicalScaleCodebookData.set(data.scaleCodebook, scaleCodebookOffset);
      this.physicalBuffers?.meansL.update(data.meansL, splatOffset * Uint32Array.BYTES_PER_ELEMENT, data.meansL.byteLength);
      this.physicalBuffers?.meansU.update(data.meansU, splatOffset * Uint32Array.BYTES_PER_ELEMENT, data.meansU.byteLength);
      this.physicalBuffers?.quats.update(data.quats, splatOffset * Uint32Array.BYTES_PER_ELEMENT, data.quats.byteLength);
      this.physicalBuffers?.scales.update(data.scales, splatOffset * Uint32Array.BYTES_PER_ELEMENT, data.scales.byteLength);
      this.physicalBuffers?.state.update(state, splatOffset * Uint32Array.BYTES_PER_ELEMENT, state.byteLength);
      this.physicalBuffers?.color.update(color, splatOffset * 4 * Float32Array.BYTES_PER_ELEMENT, color.byteLength);
      this.physicalBuffers?.scaleCodebook.update(
        data.scaleCodebook,
        scaleCodebookOffset * Float32Array.BYTES_PER_ELEMENT,
        data.scaleCodebook.byteLength,
      );
      this.allocations.set(chunk.key, {
        key: chunk.key,
        splatOffset,
        splatCount: chunk.splatCount,
        scaleCodebookOffset,
        scaleCodebookCount: data.scaleCodebook.length,
        meansMins: data.meansMins,
        meansMaxs: data.meansMaxs,
      });
      this.splatCount += chunk.splatCount;
      this.scaleCodebookCount += data.scaleCodebook.length;
    }
  }

  private updateMetadata(chunks: ResidentGlobalChunk[]): void {
    const chunkTableSignature = this.computeChunkTableSignature(chunks);
    const drawRefsSignature = this.computeDrawRefsSignature(chunks);
    const chunkTableChanged = chunkTableSignature !== this.lastChunkTableSignature;
    const drawRefsChanged = drawRefsSignature !== this.lastDrawRefsSignature;
    if (!chunkTableChanged && !drawRefsChanged) {
      this.metadataBytesUploaded = 0;
      this.metadataSkippedFrames++;
      return;
    }

    const chunkTableLength = Math.max(4, chunks.length * CHUNK_TABLE_FLOATS);
    const drawRefLength = Math.max(1, this.drawSplats);
    let uploadedBytes = 0;

    if (chunkTableChanged) {
      this.ensureChunkTableCapacity(chunkTableLength);
      this.chunkTableData.fill(0, 0, chunkTableLength);
      chunks.forEach((chunk, ordinal) => {
        const allocation = this.allocations.get(chunk.key);
        if (!allocation) {
          return;
        }
        this.writeChunkTableRow(ordinal, allocation, chunk);
      });
      this.chunkTableBuffer.update(this.chunkTableData, 0, chunkTableLength * Float32Array.BYTES_PER_ELEMENT);
      this.bufferVersions.bump(this.chunkTableBuffer);
      uploadedBytes += chunkTableLength * Float32Array.BYTES_PER_ELEMENT;
      this.lastChunkTableSignature = chunkTableSignature;
    }

    if (drawRefsChanged) {
      this.ensureSortBufferCapacity(drawRefLength);
      let drawOffset = 0;
      chunks.forEach((chunk, ordinal) => {
        for (let localIndex = 0; localIndex < chunk.splatCount; localIndex++) {
          this.drawRefsData[drawOffset++] = (ordinal << DRAW_REF_LOCAL_BITS) | localIndex;
        }
      });
      this.drawRefsBuffer.update(this.drawRefsData, 0, drawRefLength * Uint32Array.BYTES_PER_ELEMENT);
      this.bufferVersions.bump(this.drawRefsBuffer);
      uploadedBytes += drawRefLength * Uint32Array.BYTES_PER_ELEMENT;
      this.lastDrawRefsSignature = drawRefsSignature;
    }

    this.metadataBytesUploaded = uploadedBytes;
    this.metadataUpdateFrames++;
    this.rebuilds++;
  }

  private computeChunkTableSignature(chunks: ResidentGlobalChunk[]): number {
    let hash = 0x811c9dc5;
    for (const chunk of chunks) {
      hash = this.hashString(hash, chunk.key);
      hash = this.hashNumber(hash, chunk.splatCount);
      hash = this.hashNumber(hash, chunk.lod);
      hash = this.hashNumber(hash, chunk.pageAllocation.splats);
      hash = this.hashNumber(hash, chunk.pageAllocation.spans.length);
      hash = this.hashNumber(hash, chunk.pageAllocation.overflowPages);
    }
    return hash >>> 0;
  }

  private computeDrawRefsSignature(chunks: ResidentGlobalChunk[]): number {
    let hash = 0x811c9dc5;
    for (const chunk of chunks) {
      hash = this.hashString(hash, chunk.key);
      hash = this.hashNumber(hash, chunk.splatCount);
    }
    return hash >>> 0;
  }

  private hashString(hash: number, value: string): number {
    let out = this.hashNumber(hash, value.length);
    for (let index = 0; index < value.length; index++) {
      out = this.hashNumber(out, value.charCodeAt(index));
    }
    return out;
  }

  private hashNumber(hash: number, value: number): number {
    return Math.imul(hash ^ (value | 0), 16777619);
  }

  private dispatchGpuSort(cameraPosition: Vector3, cameraForward: Vector3): void {
    if (this.drawSplats <= 0 || !this.radixSortPass) {
      this.lastDepthMs = 0;
      this.lastSortMs = 0;
      this.lastGatherMs = 0;
      return;
    }

    const minDepth = this.projectBounds(this.activeBounds.min, this.activeBounds.max, cameraPosition, cameraForward, Math.min);
    const maxDepth = this.projectBounds(this.activeBounds.min, this.activeBounds.max, cameraPosition, cameraForward, Math.max);
    const invDepthRange = maxDepth - minDepth > 1e-6 ? 1 / (maxDepth - minDepth) : 0;
    this.depthParamsData[0] = cameraPosition.x;
    this.depthParamsData[1] = cameraPosition.y;
    this.depthParamsData[2] = cameraPosition.z;
    this.depthParamsData[4] = cameraForward.x;
    this.depthParamsData[5] = cameraForward.y;
    this.depthParamsData[6] = cameraForward.z;
    this.depthParamsData[8] = this.drawSplats;
    this.depthParamsData[9] = minDepth;
    this.depthParamsData[10] = invDepthRange;
    this.depthParamsData[11] = 2 ** 20 - 1;
    this.depthParamsBuffer.update(this.depthParamsData);
    const depthStart = performance.now();
    const depthDispatched = this.depthKeyShader?.dispatch(Math.ceil(this.drawSplats / DEPTH_KEY_WORKGROUP_SIZE)) ?? false;
    this.lastDepthMs = depthDispatched ? performance.now() - depthStart : 0;

    const sortStart = performance.now();
    const sorted = depthDispatched && this.radixSortPass.dispatch(this.drawSplats);
    const radixStats: GpuRadixSortStats | undefined = this.radixSortPass.getStats();
    this.lastSortMs = sorted ? radixStats.lastDispatchMs || performance.now() - sortStart : 0;

    this.gatherParamsData[0] = this.drawSplats;
    this.gatherParamsBuffer.update(this.gatherParamsData);
    const gatherStart = performance.now();
    const gathered = sorted && this.gatherShader.dispatch(Math.ceil(this.drawSplats / INDEX_GATHER_WORKGROUP_SIZE));
    this.lastGatherMs = gathered ? performance.now() - gatherStart : 0;
    this.bufferVersions.bump(this.sortedRefsBuffer);
  }

  private ensureChunkTableCapacity(requiredLength: number): void {
    if (requiredLength <= this.chunkTableCapacity) {
      return;
    }

    this.chunkTableCapacity = roundUpPowerOfTwo(requiredLength);
    this.chunkTableData = new Float32Array(this.chunkTableCapacity);
    this.chunkTableBuffer.dispose();
    this.chunkTableBuffer = createStorageBuffer(this.engine, "SsogResidentChunkTable", this.chunkTableData);
    this.bufferVersions.track(this.chunkTableBuffer);
    this.bindStorageBuffers();
  }

  private ensureSortBufferCapacity(requiredLength: number): void {
    if (requiredLength <= this.drawRefCapacity) {
      return;
    }

    this.drawRefCapacity = roundUpPowerOfTwo(requiredLength);
    this.drawRefsData = new Uint32Array(this.drawRefCapacity);
    this.recreateSortBuffers(this.drawRefCapacity);
  }

  private recreateSortBuffers(drawRefCapacity: number): void {
    this.drawRefsBuffer.dispose();
    this.sortedOrdinalsBuffer.dispose();
    this.sortedRefsBuffer.dispose();
    this.depthKeysBuffer.dispose();
    this.radixSortPass?.dispose();
    this.drawRefsBuffer = createStorageBuffer(this.engine, "SsogResidentDrawRefs", this.drawRefsData);
    this.sortedOrdinalsBuffer = createStorageBuffer(
      this.engine,
      "SsogResidentSortedOrdinals",
      new Uint32Array(drawRefCapacity),
    );
    this.sortedRefsBuffer = createStorageBuffer(this.engine, "SsogResidentSortedRefs", new Uint32Array(drawRefCapacity));
    this.depthKeysBuffer = createStorageBuffer(this.engine, "SsogResidentDepthKeys", new Uint32Array(drawRefCapacity));
    this.radixSortPass = new GpuRadixSortPass(
      this.scene,
      this.depthKeysBuffer,
      this.sortedOrdinalsBuffer,
      drawRefCapacity,
      undefined,
      true,
    );
    this.depthKeyShader = this.createDepthKeyShader();
    this.gatherShader = this.createGatherShader();
    this.bufferVersions.track(this.drawRefsBuffer);
    this.bufferVersions.track(this.sortedRefsBuffer);
    this.bindStorageBuffers();
  }

  private writeChunkTableRow(ordinal: number, allocation: ResidentChunkAllocation, chunk: ResidentGlobalChunk): void {
    const base = ordinal * CHUNK_TABLE_FLOATS;
    this.chunkTableData[base + 0] = allocation.meansMins[0];
    this.chunkTableData[base + 1] = allocation.meansMins[1];
    this.chunkTableData[base + 2] = allocation.meansMins[2];
    this.chunkTableData[base + 3] = chunk.splatCount;
    this.chunkTableData[base + 4] = allocation.meansMaxs[0];
    this.chunkTableData[base + 5] = allocation.meansMaxs[1];
    this.chunkTableData[base + 6] = allocation.meansMaxs[2];
    this.chunkTableData[base + 7] = chunk.lod;
    this.chunkTableData[base + 8] = allocation.splatOffset;
    this.chunkTableData[base + 9] = allocation.scaleCodebookOffset;
    this.chunkTableData[base + 10] = chunk.pageAllocation.spans.length;
    this.chunkTableData[base + 11] = ordinal;
    this.chunkTableData[base + 12] = chunk.boundsMin[0];
    this.chunkTableData[base + 13] = chunk.boundsMin[1];
    this.chunkTableData[base + 14] = chunk.boundsMin[2];
    this.chunkTableData[base + 15] = chunk.pageAllocation.splats;
  }

  private ensurePhysicalCapacity(requiredSplats: number, requiredScaleCodebook: number): void {
    const nextSplatCapacity = roundUpPowerOfTwo(Math.max(DEFAULT_SPLAT_CAPACITY, requiredSplats));
    const nextScaleCodebookCapacity = roundUpPowerOfTwo(Math.max(DEFAULT_SCALE_CODEBOOK_CAPACITY, requiredScaleCodebook));
    if (
      this.physicalBuffers &&
      this.splatCapacity >= requiredSplats &&
      this.scaleCodebookCapacity >= requiredScaleCodebook
    ) {
      return;
    }

    const old = {
      meansL: this.physicalMeansLData,
      meansU: this.physicalMeansUData,
      quats: this.physicalQuatsData,
      scales: this.physicalScalesData,
      state: this.physicalStateData,
      color: this.physicalColorData,
      scaleCodebook: this.physicalScaleCodebookData,
    };
    this.splatCapacity = nextSplatCapacity;
    this.scaleCodebookCapacity = nextScaleCodebookCapacity;
    this.physicalMeansLData = new Uint32Array(this.splatCapacity);
    this.physicalMeansUData = new Uint32Array(this.splatCapacity);
    this.physicalQuatsData = new Uint32Array(this.splatCapacity);
    this.physicalScalesData = new Uint32Array(this.splatCapacity);
    this.physicalStateData = new Uint32Array(this.splatCapacity);
    this.physicalColorData = new Float32Array(this.splatCapacity * 4);
    this.physicalScaleCodebookData = new Float32Array(this.scaleCodebookCapacity);
    this.physicalMeansLData.set(old.meansL.subarray(0, Math.min(old.meansL.length, this.physicalMeansLData.length)));
    this.physicalMeansUData.set(old.meansU.subarray(0, Math.min(old.meansU.length, this.physicalMeansUData.length)));
    this.physicalQuatsData.set(old.quats.subarray(0, Math.min(old.quats.length, this.physicalQuatsData.length)));
    this.physicalScalesData.set(old.scales.subarray(0, Math.min(old.scales.length, this.physicalScalesData.length)));
    this.physicalStateData.set(old.state.subarray(0, Math.min(old.state.length, this.physicalStateData.length)));
    this.physicalColorData.set(old.color.subarray(0, Math.min(old.color.length, this.physicalColorData.length)));
    this.physicalScaleCodebookData.set(
      old.scaleCodebook.subarray(0, Math.min(old.scaleCodebook.length, this.physicalScaleCodebookData.length)),
    );

    this.disposePhysicalBuffers();
    this.physicalBuffers = {
      meansL: createStorageBuffer(this.engine, "SsogResidentMeansL", this.physicalMeansLData),
      meansU: createStorageBuffer(this.engine, "SsogResidentMeansU", this.physicalMeansUData),
      quats: createStorageBuffer(this.engine, "SsogResidentQuats", this.physicalQuatsData),
      scales: createStorageBuffer(this.engine, "SsogResidentScales", this.physicalScalesData),
      color: createStorageBuffer(this.engine, "SsogResidentColor", this.physicalColorData),
      state: createStorageBuffer(this.engine, "SsogResidentState", this.physicalStateData),
      scaleCodebook: createStorageBuffer(this.engine, "SsogResidentScaleCodebook", this.physicalScaleCodebookData),
    };
    if (this.depthKeyShader) {
      this.depthKeyShader = this.createDepthKeyShader();
    }
    this.bindStorageBuffers();
  }

  private disposePhysicalBuffers(): void {
    if (!this.physicalBuffers) {
      return;
    }
    Object.values(this.physicalBuffers).forEach((buffer) => buffer.dispose());
    this.physicalBuffers = undefined;
  }

  private createDepthKeyShader(): ComputeShader {
    const shader = new ComputeShader(
      "SsogResidentDepthKeyPass",
      this.engine,
      { computeSource: DEPTH_KEY_SOURCE },
      {
        bindingsMapping: {
          meansLBuffer: { group: 0, binding: 0 },
          meansUBuffer: { group: 0, binding: 1 },
          chunkTable: { group: 0, binding: 2 },
          drawRefs: { group: 0, binding: 3 },
          depthKeys: { group: 0, binding: 4 },
          paramsBuffer: { group: 0, binding: 5 },
        },
      },
    );
    shader.setStorageBuffer("meansLBuffer", this.physicalBuffers!.meansL);
    shader.setStorageBuffer("meansUBuffer", this.physicalBuffers!.meansU);
    shader.setStorageBuffer("chunkTable", this.chunkTableBuffer);
    shader.setStorageBuffer("drawRefs", this.drawRefsBuffer);
    shader.setStorageBuffer("depthKeys", this.depthKeysBuffer);
    shader.setStorageBuffer("paramsBuffer", this.depthParamsBuffer);
    return shader;
  }

  private createGatherShader(): ComputeShader {
    const shader = new ComputeShader(
      "SsogResidentIndexGatherPass",
      this.engine,
      { computeSource: INDEX_GATHER_SOURCE },
      {
        bindingsMapping: {
          sortedOrdinals: { group: 0, binding: 0 },
          drawRefs: { group: 0, binding: 1 },
          sortedRefs: { group: 0, binding: 2 },
          paramsBuffer: { group: 0, binding: 3 },
        },
      },
    );
    shader.setStorageBuffer("sortedOrdinals", this.sortedOrdinalsBuffer);
    shader.setStorageBuffer("drawRefs", this.drawRefsBuffer);
    shader.setStorageBuffer("sortedRefs", this.sortedRefsBuffer);
    shader.setStorageBuffer("paramsBuffer", this.gatherParamsBuffer);
    return shader;
  }

  private createMaterial(scene: Scene): ShaderMaterial {
    const material = new ShaderMaterial(
      "SsogResidentPageRenderPassMaterial",
      scene,
      {
        vertexSource: WGSL_VERTEX_SOURCE,
        fragmentSource: WGSL_FRAGMENT_SOURCE,
      },
      {
        attributes: ["position"],
        uniforms: [
          "worldViewProjection",
          "view",
          "world",
          "projection",
          "viewport",
          "minAlpha",
          "minPixelRadius",
          "maxPixelRadius",
          "maxStdDev",
          "clipXY",
          "blurAmount",
          "preBlurAmount",
          "renderSplatCount",
          "vizMode",
        ],
        storageBuffers: [
          "meansLBuffer",
          "meansUBuffer",
          "quatsBuffer",
          "scalesBuffer",
          "colorBuffer",
          "splatStateBuffer",
          "scaleCodebookBuffer",
          "chunkTable",
          "sortedRefs",
        ],
        needAlphaBlending: true,
        shaderLanguage: ShaderLanguage.WGSL,
      },
    );
    material.backFaceCulling = false;
    material.alphaMode = Constants.ALPHA_PREMULTIPLIED;
    material.disableDepthWrite = true;
    material.setFloat("minAlpha", SHADER_QUALITY.minAlpha);
    material.setFloat("minPixelRadius", SHADER_QUALITY.minPixelRadius);
    material.setFloat("maxPixelRadius", SHADER_QUALITY.maxPixelRadius);
    material.setFloat("maxStdDev", SHADER_QUALITY.maxStdDev);
    material.setFloat("clipXY", SHADER_QUALITY.clipXY);
    material.setFloat("blurAmount", SHADER_QUALITY.blurAmount);
    material.setFloat("preBlurAmount", SHADER_QUALITY.preBlurAmount);
    material.setFloat("renderSplatCount", 0);
    material.setFloat("vizMode", 0);
    return material;
  }

  private bindStorageBuffers(): void {
    if (!this.physicalBuffers) {
      return;
    }
    this.bufferVersions.rebindStorageBuffer(this.material, "meansLBuffer", this.physicalBuffers.meansL);
    this.bufferVersions.rebindStorageBuffer(this.material, "meansUBuffer", this.physicalBuffers.meansU);
    this.bufferVersions.rebindStorageBuffer(this.material, "quatsBuffer", this.physicalBuffers.quats);
    this.bufferVersions.rebindStorageBuffer(this.material, "scalesBuffer", this.physicalBuffers.scales);
    this.bufferVersions.rebindStorageBuffer(this.material, "colorBuffer", this.physicalBuffers.color);
    this.bufferVersions.rebindStorageBuffer(this.material, "splatStateBuffer", this.physicalBuffers.state);
    this.bufferVersions.rebindStorageBuffer(this.material, "scaleCodebookBuffer", this.physicalBuffers.scaleCodebook);
    this.bufferVersions.rebindStorageBuffer(this.material, "chunkTable", this.chunkTableBuffer);
    this.bufferVersions.rebindStorageBuffer(this.material, "sortedRefs", this.sortedRefsBuffer);
  }

  private buildGeometry(): void {
    const positions = new Float32Array(SPLATS_PER_INSTANCE * 4 * 3);
    const geometryIndices = new Uint32Array(SPLATS_PER_INSTANCE * 6);
    const quadCorners = [-1, -1, 1, -1, 1, 1, -1, 1];
    for (let splat = 0; splat < SPLATS_PER_INSTANCE; splat++) {
      for (let cornerIndex = 0; cornerIndex < 4; cornerIndex++) {
        const positionOffset = (splat * 4 + cornerIndex) * 3;
        positions[positionOffset + 0] = quadCorners[cornerIndex * 2 + 0];
        positions[positionOffset + 1] = quadCorners[cornerIndex * 2 + 1];
        positions[positionOffset + 2] = splat;
      }
      const baseVertex = splat * 4;
      const indexOffset = splat * 6;
      geometryIndices[indexOffset + 0] = baseVertex + 0;
      geometryIndices[indexOffset + 1] = baseVertex + 1;
      geometryIndices[indexOffset + 2] = baseVertex + 2;
      geometryIndices[indexOffset + 3] = baseVertex + 0;
      geometryIndices[indexOffset + 4] = baseVertex + 2;
      geometryIndices[indexOffset + 5] = baseVertex + 3;
    }
    this.mesh.setVerticesData("position", positions, false, 3);
    this.mesh.setIndices(geometryIndices);
  }

  private setRenderCount(renderCount: number): void {
    this.mesh.forcedInstanceCount = Math.ceil(renderCount / SPLATS_PER_INSTANCE);
    this.material.setFloat("renderSplatCount", renderCount);
  }

  private computeActiveBounds(chunks: ResidentGlobalChunk[]): { min: [number, number, number]; max: [number, number, number] } {
    const min: [number, number, number] = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
    const max: [number, number, number] = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
    for (const chunk of chunks) {
      for (let axis = 0; axis < 3; axis++) {
        min[axis] = Math.min(min[axis], chunk.boundsMin[axis]);
        max[axis] = Math.max(max[axis], chunk.boundsMax[axis]);
      }
    }
    return { min, max };
  }

  private projectBounds(
    min: [number, number, number],
    max: [number, number, number],
    cameraPosition: Vector3,
    cameraForward: Vector3,
    reduce: (...values: number[]) => number,
  ): number {
    const values: number[] = [];
    for (const x of [min[0], max[0]]) {
      for (const y of [min[1], max[1]]) {
        for (const z of [min[2], max[2]]) {
          values.push(
            (x - cameraPosition.x) * cameraForward.x +
              (y - cameraPosition.y) * cameraForward.y +
              (z - cameraPosition.z) * cameraForward.z,
          );
        }
      }
    }
    return reduce(...values);
  }
}

const createStorageBuffer = (engine: WebGPUEngine, name: string, data: Uint32Array | Float32Array): StorageBuffer => {
  const buffer = new StorageBuffer(engine, Math.max(4, data.byteLength), undefined, name);
  buffer.update(data);
  return buffer;
};

export { SsogResidentPageRenderPass };
export type { ResidentGlobalChunk, ResidentGlobalUpdate, SsogResidentPageStats };
