import { StorageBuffer } from "@babylonjs/core/Buffers/storageBuffer";
import { ComputeShader } from "@babylonjs/core/Compute/computeShader";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader";
import type { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import type { Scene } from "@babylonjs/core/scene";

import { canCreateComputeShader } from "./GpuDepthKeyPass";
import { GpuBufferArena } from "./GpuBufferArena";
import { GpuReadbackBufferPool } from "./GpuReadbackBufferPool";
import GpuRadixSortPass_PREFIX_SCAN_SOURCE_raw from "./shaders/gpu-radix-sort-pass.prefix-scan-source.wgsl?raw";
import GpuRadixSortPass_PREFIX_ADD_SOURCE_raw from "./shaders/gpu-radix-sort-pass.prefix-add-source.wgsl?raw";
import GpuRadixSortPass_VALIDATION_CLEAR_SOURCE_raw from "./shaders/gpu-radix-sort-pass.validation-clear-source.wgsl?raw";
import GpuRadixSortPass_VALIDATION_SOURCE_raw from "./shaders/gpu-radix-sort-pass.validation-source.wgsl?raw";
import GpuRadixSortPass_RADIX_HISTOGRAM_SOURCE_raw from "./shaders/gpu-radix-sort-pass.radix-histogram-source.wgsl?raw";
import GpuRadixSortPass_RADIX_REORDER_SOURCE_raw from "./shaders/gpu-radix-sort-pass.radix-reorder-source.wgsl?raw";

const WORKGROUP_SIZE_X = 16;
const WORKGROUP_SIZE_Y = 16;
const THREADS_PER_WORKGROUP = WORKGROUP_SIZE_X * WORKGROUP_SIZE_Y;
const ELEMENTS_PER_THREAD = 8;
const ELEMENTS_PER_WORKGROUP = THREADS_PER_WORKGROUP * ELEMENTS_PER_THREAD;
const BITS_PER_PASS = 4;
const BUCKET_COUNT = 16;
const PREFIX_ITEMS_PER_WORKGROUP = 512;
const DEFAULT_SORT_BITS = 20;

const makeRadixHistogramSource = (currentBit: number) => GpuRadixSortPass_RADIX_HISTOGRAM_SOURCE_raw.replaceAll("__TEMPLATE_EXPR_0__", String(BUCKET_COUNT)).replaceAll("__TEMPLATE_EXPR_1__", String(WORKGROUP_SIZE_X)).replaceAll("__TEMPLATE_EXPR_2__", String(WORKGROUP_SIZE_Y)).replaceAll("__TEMPLATE_EXPR_3__", String(ELEMENTS_PER_WORKGROUP)).replaceAll("__TEMPLATE_EXPR_4__", String(BUCKET_COUNT)).replaceAll("__TEMPLATE_EXPR_5__", String(ELEMENTS_PER_THREAD)).replaceAll("__TEMPLATE_EXPR_6__", String(THREADS_PER_WORKGROUP)).replaceAll("__TEMPLATE_EXPR_7__", String(currentBit)).replaceAll("__TEMPLATE_EXPR_8__", String(BUCKET_COUNT));

const makeRadixReorderSource = (currentBit: number) => GpuRadixSortPass_RADIX_REORDER_SOURCE_raw.replaceAll("__TEMPLATE_EXPR_0__", String(BUCKET_COUNT)).replaceAll("__TEMPLATE_EXPR_1__", String(WORKGROUP_SIZE_X)).replaceAll("__TEMPLATE_EXPR_2__", String(WORKGROUP_SIZE_Y)).replaceAll("__TEMPLATE_EXPR_3__", String(ELEMENTS_PER_WORKGROUP)).replaceAll("__TEMPLATE_EXPR_4__", String(BUCKET_COUNT)).replaceAll("__TEMPLATE_EXPR_5__", String(ELEMENTS_PER_THREAD)).replaceAll("__TEMPLATE_EXPR_6__", String(THREADS_PER_WORKGROUP)).replaceAll("__TEMPLATE_EXPR_7__", String(currentBit)).replaceAll("__TEMPLATE_EXPR_8__", String(ELEMENTS_PER_THREAD - 1)).replaceAll("__TEMPLATE_EXPR_9__", String(BUCKET_COUNT));

const PREFIX_SCAN_SOURCE = GpuRadixSortPass_PREFIX_SCAN_SOURCE_raw.replaceAll("__PREFIX_SCAN_SOURCE_EXPR_0__", String(PREFIX_ITEMS_PER_WORKGROUP)).replaceAll("__PREFIX_SCAN_SOURCE_EXPR_1__", String(THREADS_PER_WORKGROUP)).replaceAll("__PREFIX_SCAN_SOURCE_EXPR_2__", String(PREFIX_ITEMS_PER_WORKGROUP)).replaceAll("__PREFIX_SCAN_SOURCE_EXPR_3__", String(PREFIX_ITEMS_PER_WORKGROUP / 2)).replaceAll("__PREFIX_SCAN_SOURCE_EXPR_4__", String(PREFIX_ITEMS_PER_WORKGROUP - 1)).replaceAll("__PREFIX_SCAN_SOURCE_EXPR_5__", String(PREFIX_ITEMS_PER_WORKGROUP - 1)).replaceAll("__PREFIX_SCAN_SOURCE_EXPR_6__", String(PREFIX_ITEMS_PER_WORKGROUP));

const PREFIX_ADD_SOURCE = GpuRadixSortPass_PREFIX_ADD_SOURCE_raw.replaceAll("__PREFIX_ADD_SOURCE_EXPR_0__", String(THREADS_PER_WORKGROUP)).replaceAll("__PREFIX_ADD_SOURCE_EXPR_1__", String(PREFIX_ITEMS_PER_WORKGROUP));

const VALIDATION_CLEAR_SOURCE = GpuRadixSortPass_VALIDATION_CLEAR_SOURCE_raw;

const VALIDATION_SOURCE = GpuRadixSortPass_VALIDATION_SOURCE_raw.replaceAll("__VALIDATION_SOURCE_EXPR_0__", String(THREADS_PER_WORKGROUP));

type GpuRadixSortStats = {
  enabled: boolean;
  dispatched: boolean;
  lastDispatchMs: number;
  lastDispatchSplats: number;
  capacity: number;
  sortBits: number;
  passes: number;
  validationEnabled: boolean;
  validationPending: boolean;
  validationSamples: number;
  ascendingViolations: number;
  descendingViolations: number;
  outOfRangeIndices: number;
  duplicateAdjacentIndices: number;
  checksumValid: boolean;
  indexSum: number;
  expectedIndexSum: number;
  indexXor: number;
  expectedIndexXor: number;
  validatedIndexCount: number;
  gpuBufferArenaBuffers: number;
  gpuBufferArenaBytes: number;
  gpuBufferArenaPeakBytes: number;
  gpuBufferArenaAllocations: number;
  gpuBufferArenaReuses: number;
  gpuBufferArenaGrows: number;
};

type PrefixPass = {
  scanShader: ComputeShader;
  addShader?: ComputeShader;
  blockSums: StorageBuffer;
  params: StorageBuffer;
  paramsData: Uint32Array;
  count: number;
  dispatchCount: number;
};

class GpuRadixSortPass {
  private readonly params: StorageBuffer;
  private readonly paramsData = new Uint32Array(4);
  private readonly workgroupCapacity: number;
  private readonly keyScratchA: StorageBuffer;
  private readonly keyScratchB: StorageBuffer;
  private readonly initialValues: StorageBuffer;
  private readonly valueScratchA: StorageBuffer;
  private readonly valueScratchB: StorageBuffer;
  private readonly blockSums: StorageBuffer;
  private readonly histogramShaders: ComputeShader[] = [];
  private readonly reorderShaders: ComputeShader[] = [];
  private readonly prefixPasses: PrefixPass[] = [];
  private readonly validationClearShader: ComputeShader;
  private readonly validationShader: ComputeShader;
  private readonly validationCounters: StorageBuffer;
  private readonly tempBufferArena: GpuBufferArena;
  private readonly readbackPool: GpuReadbackBufferPool;
  private readonly validationReadback = new Uint32Array(8);
  private lastDispatchMs = 0;
  private lastDispatchSplats = 0;
  private validationPending = false;
  private validationSamples = 0;
  private ascendingViolations = 0;
  private descendingViolations = 0;
  private outOfRangeIndices = 0;
  private duplicateAdjacentIndices = 0;
  private indexSum = 0;
  private expectedIndexSum = 0;
  private indexXor = 0;
  private expectedIndexXor = 0;
  private validatedIndexCount = 0;

  constructor(
    scene: Scene,
    private readonly inputKeys: StorageBuffer,
    private readonly outputIndices: StorageBuffer,
    private readonly capacity: number,
    private readonly sortBits = DEFAULT_SORT_BITS,
    private readonly validationEnabled = true,
  ) {
    const engine = scene.getEngine() as WebGPUEngine;
    this.tempBufferArena = new GpuBufferArena(engine, "GpuRadixSortTemp");
    this.readbackPool = new GpuReadbackBufferPool(engine, "GpuRadixSortValidation");
    const elementBytes = capacity * 4;
    this.workgroupCapacity = Math.ceil(capacity / ELEMENTS_PER_WORKGROUP);
    this.params = new StorageBuffer(engine, this.paramsData.byteLength, undefined, "GpuRadixSortParams");
    this.keyScratchA = new StorageBuffer(engine, elementBytes, undefined, "GpuRadixSortKeyScratchA");
    this.keyScratchB = new StorageBuffer(engine, elementBytes, undefined, "GpuRadixSortKeyScratchB");
    this.initialValues = new StorageBuffer(engine, elementBytes, undefined, "GpuRadixSortInitialValues");
    this.valueScratchA = new StorageBuffer(engine, elementBytes, undefined, "GpuRadixSortValueScratchA");
    this.valueScratchB = new StorageBuffer(engine, elementBytes, undefined, "GpuRadixSortValueScratchB");
    this.initialValues.update(this.createSequentialIndices(capacity));
    this.validationCounters = new StorageBuffer(engine, this.validationReadback.byteLength, undefined, "GpuRadixValidationCounters");
    this.blockSums = new StorageBuffer(
      engine,
      BUCKET_COUNT * this.workgroupCapacity * 4,
      undefined,
      "GpuRadixSortBlockSums",
    );

    const passCount = this.getPassCount();
    for (let pass = 0; pass < passCount; pass++) {
      const bit = pass * BITS_PER_PASS;
      this.histogramShaders.push(this.createHistogramShader(engine, bit));
      this.reorderShaders.push(this.createReorderShader(engine, bit));
    }

    this.validationClearShader = new ComputeShader(
      "GpuRadixValidationClear",
      engine,
      { computeSource: VALIDATION_CLEAR_SOURCE },
      {
        bindingsMapping: {
          counters: { group: 0, binding: 0 },
        },
      },
    );
    this.validationClearShader.setStorageBuffer("counters", this.validationCounters);

    this.validationShader = new ComputeShader(
      "GpuRadixValidation",
      engine,
      { computeSource: VALIDATION_SOURCE },
      {
        bindingsMapping: {
          inputKeys: { group: 0, binding: 0 },
          sortedIndices: { group: 0, binding: 1 },
          counters: { group: 0, binding: 2 },
          paramsBuffer: { group: 0, binding: 3 },
        },
      },
    );
    this.validationShader.setStorageBuffer("inputKeys", this.inputKeys);
    this.validationShader.setStorageBuffer("sortedIndices", this.outputIndices);
    this.validationShader.setStorageBuffer("counters", this.validationCounters);
    this.validationShader.setStorageBuffer("paramsBuffer", this.params);

    this.createPrefixPasses(engine, this.blockSums, BUCKET_COUNT * this.workgroupCapacity);
  }

  static isSupported(scene: Scene): boolean {
    return canCreateComputeShader(scene);
  }

  dispose(): void {
    this.params.dispose();
    this.keyScratchA.dispose();
    this.keyScratchB.dispose();
    this.initialValues.dispose();
    this.valueScratchA.dispose();
    this.valueScratchB.dispose();
    this.validationCounters.dispose();
    this.blockSums.dispose();
    this.tempBufferArena.dispose();
    this.readbackPool.dispose();
  }

  dispatch(count = this.capacity): boolean {
    const activeCount = Math.max(0, Math.min(this.capacity, Math.floor(count)));
    if (activeCount <= 0) {
      return false;
    }

    const start = performance.now();
    const workgroupCount = Math.ceil(activeCount / ELEMENTS_PER_WORKGROUP);
    const dispatchX = Math.min(workgroupCount, 65535);
    const dispatchY = Math.ceil(workgroupCount / dispatchX);
    this.paramsData[0] = workgroupCount;
    this.paramsData[1] = activeCount;
    this.paramsData[2] = 0;
    this.paramsData[3] = 0;
    this.params.update(this.paramsData);

    let inputKeys = this.inputKeys;
    let outputKeys = this.keyScratchA;
    let inputValues = this.initialValues;
    let outputValues = this.valueScratchB;
    let dispatched = true;
    const passCount = this.getPassCount();

    for (let pass = 0; pass < passCount; pass++) {
      const isLastPass = pass === passCount - 1;
      const histogram = this.histogramShaders[pass];
      const reorder = this.reorderShaders[pass];

      histogram.setStorageBuffer("inputKeys", inputKeys);
      histogram.setStorageBuffer("blockSums", this.blockSums);
      histogram.setStorageBuffer("paramsBuffer", this.params);
      dispatched = histogram.dispatch(dispatchX, dispatchY, 1) && dispatched;

      this.dispatchPrefixPasses(BUCKET_COUNT * workgroupCount);

      reorder.setStorageBuffer("inputKeys", inputKeys);
      reorder.setStorageBuffer("outputKeys", outputKeys);
      reorder.setStorageBuffer("prefixBlockSums", this.blockSums);
      reorder.setStorageBuffer("inputValues", inputValues);
      reorder.setStorageBuffer("outputValues", isLastPass ? this.outputIndices : outputValues);
      reorder.setStorageBuffer("paramsBuffer", this.params);
      dispatched = reorder.dispatch(dispatchX, dispatchY, 1) && dispatched;

      if (!isLastPass) {
        inputKeys = outputKeys;
        outputKeys = outputKeys === this.keyScratchA ? this.keyScratchB : this.keyScratchA;
        inputValues = outputValues;
        outputValues = outputValues === this.valueScratchA ? this.valueScratchB : this.valueScratchA;
      }
    }

    if (dispatched) {
      this.dispatchValidation(activeCount);
      this.lastDispatchMs = performance.now() - start;
      this.lastDispatchSplats = activeCount;
    }
    return dispatched;
  }

  getStats(): GpuRadixSortStats {
    const arenaStats = this.tempBufferArena.getStats();
    return {
      enabled: true,
      dispatched: this.lastDispatchSplats > 0,
      lastDispatchMs: this.lastDispatchMs,
      lastDispatchSplats: this.lastDispatchSplats,
      capacity: this.capacity,
      sortBits: this.sortBits,
      passes: this.getPassCount(),
      validationEnabled: this.validationEnabled,
      validationPending: this.validationPending,
      validationSamples: this.validationSamples,
      ascendingViolations: this.ascendingViolations,
      descendingViolations: this.descendingViolations,
      outOfRangeIndices: this.outOfRangeIndices,
      duplicateAdjacentIndices: this.duplicateAdjacentIndices,
      checksumValid:
        this.validatedIndexCount === this.lastDispatchSplats &&
        this.indexSum === this.expectedIndexSum &&
        this.indexXor === this.expectedIndexXor,
      indexSum: this.indexSum,
      expectedIndexSum: this.expectedIndexSum,
      indexXor: this.indexXor,
      expectedIndexXor: this.expectedIndexXor,
      validatedIndexCount: this.validatedIndexCount,
      gpuBufferArenaBuffers: arenaStats.bufferCount,
      gpuBufferArenaBytes: arenaStats.totalBytes,
      gpuBufferArenaPeakBytes: arenaStats.peakBytes,
      gpuBufferArenaAllocations: arenaStats.allocationCount,
      gpuBufferArenaReuses: arenaStats.reuseCount,
      gpuBufferArenaGrows: arenaStats.growCount,
    };
  }

  private dispatchValidation(activeCount: number): void {
    if (!this.validationEnabled || this.validationPending) {
      return;
    }

    this.expectedIndexSum = this.computeExpectedIndexSum(activeCount);
    this.expectedIndexXor = this.computeExpectedIndexXor(activeCount);
    this.validationClearShader.dispatch(1);
    this.validationShader.dispatch(Math.ceil(activeCount / THREADS_PER_WORKGROUP));
    this.validationPending = true;
    this.validationSamples = Math.max(0, activeCount - 1);
    void this.readValidationCounters();
  }

  private async readValidationCounters(): Promise<void> {
    try {
      const result = await this.readbackPool.readStorageBuffer(
        this.validationCounters,
        0,
        this.validationReadback.byteLength,
        this.validationReadback,
      );
      const counters = result;
      this.ascendingViolations = counters[0] ?? 0;
      this.descendingViolations = counters[1] ?? 0;
      this.outOfRangeIndices = counters[2] ?? 0;
      this.duplicateAdjacentIndices = counters[3] ?? 0;
      this.indexSum = counters[4] ?? 0;
      this.indexXor = counters[5] ?? 0;
      this.validatedIndexCount = counters[6] ?? 0;
    } catch {
      this.validationSamples = 0;
      this.ascendingViolations = 0;
      this.descendingViolations = 0;
      this.outOfRangeIndices = 0;
      this.duplicateAdjacentIndices = 0;
      this.indexSum = 0;
      this.indexXor = 0;
      this.validatedIndexCount = 0;
    } finally {
      this.validationPending = false;
    }
  }

  private computeExpectedIndexSum(count: number): number {
    return ((count * (count - 1)) / 2) >>> 0;
  }

  private computeExpectedIndexXor(count: number): number {
    if (count <= 0) {
      return 0;
    }

    const last = count - 1;
    switch (last & 3) {
      case 0:
        return last >>> 0;
      case 1:
        return 1;
      case 2:
        return (last + 1) >>> 0;
      default:
        return 0;
    }
  }

  private getPassCount(): number {
    return Math.ceil(this.sortBits / BITS_PER_PASS);
  }

  private createHistogramShader(engine: WebGPUEngine, bit: number): ComputeShader {
    return new ComputeShader(
      `GpuRadixSortHistogram${bit}`,
      engine,
      { computeSource: makeRadixHistogramSource(bit) },
      {
        bindingsMapping: {
          inputKeys: { group: 0, binding: 0 },
          blockSums: { group: 0, binding: 1 },
          paramsBuffer: { group: 0, binding: 2 },
        },
      },
    );
  }

  private createReorderShader(engine: WebGPUEngine, bit: number): ComputeShader {
    return new ComputeShader(
      `GpuRadixSortReorder${bit}`,
      engine,
      { computeSource: makeRadixReorderSource(bit) },
      {
        bindingsMapping: {
          inputKeys: { group: 0, binding: 0 },
          outputKeys: { group: 0, binding: 1 },
          prefixBlockSums: { group: 0, binding: 2 },
          inputValues: { group: 0, binding: 3 },
          outputValues: { group: 0, binding: 4 },
          paramsBuffer: { group: 0, binding: 5 },
        },
      },
    );
  }

  private createSequentialIndices(count: number): Uint32Array {
    const values = new Uint32Array(count);
    for (let i = 0; i < count; i++) {
      values[i] = i;
    }
    return values;
  }

  private createPrefixPasses(engine: WebGPUEngine, dataBuffer: StorageBuffer, count: number): void {
    const workgroupCount = Math.ceil(count / PREFIX_ITEMS_PER_WORKGROUP);
    const passIndex = this.prefixPasses.length;
    const blockSums = this.tempBufferArena.getStorageBuffer(
      `PrefixBlockSums${passIndex}`,
      Math.max(1, workgroupCount) * 4,
    );
    const paramsData = new Uint32Array(4);
    const params = this.tempBufferArena.getStorageBuffer(`PrefixParams${passIndex}`, paramsData.byteLength);
    const scanShader = new ComputeShader(
      "GpuRadixPrefixScan",
      engine,
      { computeSource: PREFIX_SCAN_SOURCE },
      {
        bindingsMapping: {
          items: { group: 0, binding: 0 },
          blockSums: { group: 0, binding: 1 },
          paramsBuffer: { group: 0, binding: 2 },
        },
      },
    );
    scanShader.setStorageBuffer("items", dataBuffer);
    scanShader.setStorageBuffer("blockSums", blockSums);
    scanShader.setStorageBuffer("paramsBuffer", params);

    const pass: PrefixPass = {
      scanShader,
      blockSums,
      params,
      paramsData,
      count,
      dispatchCount: workgroupCount,
    };
    this.prefixPasses.push(pass);

    if (workgroupCount > 1) {
      this.createPrefixPasses(engine, blockSums, workgroupCount);
      const addShader = new ComputeShader(
        "GpuRadixPrefixAdd",
        engine,
        { computeSource: PREFIX_ADD_SOURCE },
        {
          bindingsMapping: {
            items: { group: 0, binding: 0 },
            blockSums: { group: 0, binding: 1 },
            paramsBuffer: { group: 0, binding: 2 },
          },
        },
      );
      addShader.setStorageBuffer("items", dataBuffer);
      addShader.setStorageBuffer("blockSums", blockSums);
      addShader.setStorageBuffer("paramsBuffer", params);
      pass.addShader = addShader;
    }
  }

  private dispatchPrefixPasses(rootCount: number): void {
    let count = rootCount;
    const dispatchCounts: number[] = [];
    for (const pass of this.prefixPasses) {
      const dispatchCount = Math.ceil(count / PREFIX_ITEMS_PER_WORKGROUP);
      dispatchCounts.push(dispatchCount);
      pass.paramsData[0] = count;
      pass.paramsData[1] = 0;
      pass.paramsData[2] = 0;
      pass.paramsData[3] = 0;
      pass.params.update(pass.paramsData);
      pass.scanShader.dispatch(dispatchCount);
      count = dispatchCount;
    }

    for (let i = this.prefixPasses.length - 1; i >= 0; i--) {
      const pass = this.prefixPasses[i];
      if (pass.addShader) {
        pass.addShader.dispatch(dispatchCounts[i] ?? pass.dispatchCount);
      }
    }
  }
}

export { GpuRadixSortPass };
export type { GpuRadixSortStats };
