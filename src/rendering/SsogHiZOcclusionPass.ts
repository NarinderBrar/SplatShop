import { StorageBuffer } from "@babylonjs/core/Buffers/storageBuffer";
import { ComputeShader } from "@babylonjs/core/Compute/computeShader";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader";
import type { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import type { Matrix } from "@babylonjs/core/Maths/math.vector";
import type { Scene } from "@babylonjs/core/scene";

import type { SsogChunkEntry } from "../splat/SplatAsset";
import { canCreateComputeShader } from "./GpuDepthKeyPass";
import { GpuReadbackBufferPool, type GpuReadbackBufferPoolStats } from "./GpuReadbackBufferPool";
import SsogHiZOcclusionPass_BUILD_SOURCE_raw from "./shaders/ssog-hiz-occlusion-pass.build-source.wgsl?raw";
import SsogHiZOcclusionPass_CLEAR_SOURCE_raw from "./shaders/ssog-hiz-occlusion-pass.clear-source.wgsl?raw";
import SsogHiZOcclusionPass_TEST_SOURCE_raw from "./shaders/ssog-hiz-occlusion-pass.test-source.wgsl?raw";

const WORKGROUP_SIZE = 64;
const PARAM_FLOAT_COUNT = 28;
const COUNTER_COUNT = 4;
const FAR_DEPTH_Q = 0xffffffff;
const CLEAR_BINDINGS = ["depthGrid", "paramsBuffer"] as const;
const BUILD_BINDINGS = ["boundsBuffer", "occluderMask", "depthGrid", "paramsBuffer"] as const;
const TEST_BINDINGS = ["boundsBuffer", "depthGrid", "visibleIndices", "counters", "paramsBuffer"] as const;

type SsogHiZBindingName =
  | "boundsBuffer"
  | "occluderMask"
  | "depthGrid"
  | "visibleIndices"
  | "counters"
  | "paramsBuffer";

const CLEAR_SOURCE = SsogHiZOcclusionPass_CLEAR_SOURCE_raw.replaceAll(
  "__CLEAR_SOURCE_EXPR_0__",
  String(WORKGROUP_SIZE),
);
const BUILD_SOURCE = SsogHiZOcclusionPass_BUILD_SOURCE_raw.replaceAll(
  "__BUILD_SOURCE_EXPR_0__",
  String(WORKGROUP_SIZE),
);
const TEST_SOURCE = SsogHiZOcclusionPass_TEST_SOURCE_raw.replaceAll(
  "__TEST_SOURCE_EXPR_0__",
  String(WORKGROUP_SIZE),
);

type SsogHiZOcclusionStats = {
  supported: boolean;
  enabled: boolean;
  dispatched: boolean;
  readbackPending: boolean;
  chunkCount: number;
  occluderChunks: number;
  testedChunks: number;
  visibleChunks: number;
  occludedChunks: number;
  compactVisibleChunks: number;
  resultGeneration: number;
  gridWidth: number;
  gridHeight: number;
  lastDispatchMs: number;
  readbackPool: GpuReadbackBufferPoolStats;
};

class SsogHiZOcclusionPass {
  private readonly clearShader: ComputeShader;
  private readonly buildShader: ComputeShader;
  private readonly testShader: ComputeShader;
  private readonly bounds: StorageBuffer;
  private readonly occluderMask: StorageBuffer;
  private readonly visibleIndices: StorageBuffer;
  private readonly counters: StorageBuffer;
  private readonly depthGrid: StorageBuffer;
  private readonly params: StorageBuffer;
  private readonly paramsData = new Float32Array(PARAM_FLOAT_COUNT);
  private readonly zeroCounters = new Uint32Array(COUNTER_COUNT);
  private readonly counterReadback = new Uint32Array(COUNTER_COUNT);
  private readonly farDepthGrid: Uint32Array;
  private readonly visibleIndexReadback: Uint32Array;
  private readonly readbackPool: GpuReadbackBufferPool;
  private readbackPending = false;
  private stats: SsogHiZOcclusionStats;

  constructor(
    scene: Scene,
    entries: SsogChunkEntry[],
    private readonly gridWidth = 96,
    private readonly gridHeight = 54,
  ) {
    const engine = scene.getEngine() as WebGPUEngine;
    this.readbackPool = new GpuReadbackBufferPool(engine, "SsogHiZ");
    const boundsData = new Float32Array(Math.max(1, entries.length) * 8);
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index];
      const offset = index * 8;
      boundsData[offset + 0] = entry.bound.min[0];
      boundsData[offset + 1] = entry.bound.min[1];
      boundsData[offset + 2] = entry.bound.min[2];
      boundsData[offset + 4] = entry.bound.max[0];
      boundsData[offset + 5] = entry.bound.max[1];
      boundsData[offset + 6] = entry.bound.max[2];
    }

    const chunkBytes = Math.max(1, entries.length) * Uint32Array.BYTES_PER_ELEMENT;
    const gridCells = this.gridWidth * this.gridHeight;
    this.bounds = new StorageBuffer(engine, boundsData.byteLength, undefined, "SsogHiZBounds");
    this.bounds.update(boundsData);
    this.occluderMask = new StorageBuffer(engine, chunkBytes, undefined, "SsogHiZOccluderMask");
    this.visibleIndices = new StorageBuffer(engine, chunkBytes, undefined, "SsogHiZVisibleIndices");
    this.counters = new StorageBuffer(engine, this.zeroCounters.byteLength, undefined, "SsogHiZCounters");
    this.depthGrid = new StorageBuffer(
      engine,
      gridCells * Uint32Array.BYTES_PER_ELEMENT,
      undefined,
      "SsogHiZDepthGrid",
    );
    this.params = new StorageBuffer(engine, this.paramsData.byteLength, undefined, "SsogHiZParams");
    this.farDepthGrid = new Uint32Array(gridCells);
    this.farDepthGrid.fill(FAR_DEPTH_Q);
    this.visibleIndexReadback = new Uint32Array(Math.max(1, entries.length));

    this.clearShader = this.createShader(engine, "SsogHiZClearSparseBindings", CLEAR_SOURCE, CLEAR_BINDINGS);
    this.buildShader = this.createShader(engine, "SsogHiZBuildSparseBindings", BUILD_SOURCE, BUILD_BINDINGS);
    this.testShader = this.createShader(engine, "SsogHiZTestSparseBindings", TEST_SOURCE, TEST_BINDINGS);
    this.bindShader(this.clearShader, CLEAR_BINDINGS);
    this.bindShader(this.buildShader, BUILD_BINDINGS);
    this.bindShader(this.testShader, TEST_BINDINGS);
    this.stats = {
      supported: true,
      enabled: true,
      dispatched: false,
      readbackPending: false,
      chunkCount: entries.length,
      occluderChunks: 0,
      testedChunks: 0,
      visibleChunks: 0,
      occludedChunks: 0,
      compactVisibleChunks: 0,
      resultGeneration: 0,
      gridWidth: this.gridWidth,
      gridHeight: this.gridHeight,
      lastDispatchMs: 0,
      readbackPool: this.readbackPool.getStats(),
    };
  }

  static isSupported(scene: Scene): boolean {
    return canCreateComputeShader(scene);
  }

  dispose(): void {
    this.bounds.dispose();
    this.occluderMask.dispose();
    this.visibleIndices.dispose();
    this.counters.dispose();
    this.depthGrid.dispose();
    this.params.dispose();
    this.readbackPool.dispose();
  }

  dispatch(
    transform: Matrix,
    viewportWidth: number,
    viewportHeight: number,
    occluderMask: Uint32Array,
    occluderChunks: number,
    bias: number,
  ): boolean {
    if (this.readbackPending) {
      this.stats = { ...this.stats, readbackPending: true };
      return false;
    }

    const start = performance.now();
    const matrix = transform.toArray();
    for (let i = 0; i < 16; i++) {
      this.paramsData[i] = matrix[i];
    }
    this.paramsData[16] = Math.max(1, viewportWidth);
    this.paramsData[17] = Math.max(1, viewportHeight);
    this.paramsData[18] = this.gridWidth;
    this.paramsData[19] = this.gridHeight;
    this.paramsData[20] = this.stats.chunkCount;
    this.paramsData[21] = Math.max(0, bias);
    this.params.update(this.paramsData);
    this.occluderMask.update(occluderMask, 0, Math.min(occluderMask.byteLength, this.stats.chunkCount * 4));
    this.counters.update(this.zeroCounters);
    this.depthGrid.update(this.farDepthGrid);

    const gridCells = this.gridWidth * this.gridHeight;
    const cleared = this.clearShader.dispatch(Math.ceil(gridCells / WORKGROUP_SIZE));
    const built = cleared && this.buildShader.dispatch(Math.ceil(Math.max(1, this.stats.chunkCount) / WORKGROUP_SIZE));
    const tested = built && this.testShader.dispatch(Math.ceil(Math.max(1, this.stats.chunkCount) / WORKGROUP_SIZE));
    this.stats = {
      ...this.stats,
      enabled: true,
      dispatched: tested,
      readbackPending: tested,
      occluderChunks,
      lastDispatchMs: tested ? performance.now() - start : 0,
    };
    if (tested) {
      this.scheduleReadback();
    }
    return tested;
  }

  markSkipped(): void {
    this.stats = {
      ...this.stats,
      enabled: false,
      dispatched: false,
      readbackPending: this.readbackPending,
      lastDispatchMs: 0,
    };
  }

  hasValidResult(): boolean {
    return (
      this.stats.resultGeneration > 0 &&
      !this.readbackPending &&
      this.stats.compactVisibleChunks === this.stats.visibleChunks
    );
  }

  getVisibleIndices(): Uint32Array {
    return this.visibleIndexReadback.subarray(0, this.stats.compactVisibleChunks);
  }

  getStats(): SsogHiZOcclusionStats {
    return {
      ...this.stats,
      readbackPending: this.readbackPending,
      readbackPool: this.readbackPool.getStats(),
    };
  }

  private createShader(
    engine: WebGPUEngine,
    name: string,
    source: string,
    bindings: readonly SsogHiZBindingName[],
  ): ComputeShader {
    const fullBindingsMapping = {
      boundsBuffer: { group: 0, binding: 0 },
      occluderMask: { group: 0, binding: 1 },
      depthGrid: { group: 0, binding: 2 },
      visibleIndices: { group: 0, binding: 3 },
      counters: { group: 0, binding: 4 },
      paramsBuffer: { group: 0, binding: 5 },
    } satisfies Record<SsogHiZBindingName, { group: number; binding: number }>;
    const bindingsMapping = Object.fromEntries(
      bindings.map((binding) => [binding, fullBindingsMapping[binding]]),
    ) as Partial<typeof fullBindingsMapping>;

    return new ComputeShader(
      name,
      engine,
      { computeSource: source },
      { bindingsMapping },
    );
  }

  private bindShader(shader: ComputeShader, bindings: readonly SsogHiZBindingName[]): void {
    for (const binding of bindings) {
      switch (binding) {
      case "boundsBuffer":
        shader.setStorageBuffer(binding, this.bounds);
        break;
      case "occluderMask":
        shader.setStorageBuffer(binding, this.occluderMask);
        break;
      case "depthGrid":
        shader.setStorageBuffer(binding, this.depthGrid);
        break;
      case "visibleIndices":
        shader.setStorageBuffer(binding, this.visibleIndices);
        break;
      case "counters":
        shader.setStorageBuffer(binding, this.counters);
        break;
      case "paramsBuffer":
        shader.setStorageBuffer(binding, this.params);
        break;
      }
    }
  }

  private scheduleReadback(): void {
    if (this.readbackPending) {
      return;
    }
    this.readbackPending = true;
    void this.readbackPool
      .readStorageBuffer(this.counters, 0, this.zeroCounters.byteLength, this.counterReadback)
      .then((counterView) => {
        const counters = new Uint32Array(counterView.buffer, counterView.byteOffset, counterView.byteLength / 4);
        const visibleChunks = Math.min(counters[0] ?? 0, this.stats.chunkCount);
        return this.readbackPool
          .readStorageBuffer(
            this.visibleIndices,
            0,
            Math.max(1, visibleChunks) * Uint32Array.BYTES_PER_ELEMENT,
            this.visibleIndexReadback,
          )
          .then(() => {
            this.stats = {
              ...this.stats,
              testedChunks: counters[2] ?? this.stats.chunkCount,
              visibleChunks,
              occludedChunks: counters[1] ?? 0,
              compactVisibleChunks: visibleChunks,
              resultGeneration: this.stats.resultGeneration + 1,
            };
          });
      })
      .finally(() => {
        this.readbackPending = false;
        this.stats = {
          ...this.stats,
          readbackPending: false,
          readbackPool: this.readbackPool.getStats(),
        };
      });
  }
}

export { SsogHiZOcclusionPass };
export type { SsogHiZOcclusionStats };
