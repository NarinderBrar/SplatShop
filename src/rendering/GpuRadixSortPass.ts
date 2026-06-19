import { StorageBuffer } from "@babylonjs/core/Buffers/storageBuffer";
import { ComputeShader } from "@babylonjs/core/Compute/computeShader";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader";
import type { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import type { Scene } from "@babylonjs/core/scene";

import { canCreateComputeShader } from "./GpuDepthKeyPass";
import { GpuBufferArena } from "./GpuBufferArena";

const WORKGROUP_SIZE_X = 16;
const WORKGROUP_SIZE_Y = 16;
const THREADS_PER_WORKGROUP = WORKGROUP_SIZE_X * WORKGROUP_SIZE_Y;
const ELEMENTS_PER_THREAD = 8;
const ELEMENTS_PER_WORKGROUP = THREADS_PER_WORKGROUP * ELEMENTS_PER_THREAD;
const BITS_PER_PASS = 4;
const BUCKET_COUNT = 16;
const PREFIX_ITEMS_PER_WORKGROUP = 512;
const DEFAULT_SORT_BITS = 20;

const makeRadixHistogramSource = (currentBit: number) => `
@group(0) @binding(0) var<storage, read> inputKeys: array<u32>;
@group(0) @binding(1) var<storage, read_write> blockSums: array<u32>;
@group(0) @binding(2) var<storage, read> paramsBuffer: array<u32>;

var<workgroup> histogram: array<atomic<u32>, ${BUCKET_COUNT}>;

@compute @workgroup_size(${WORKGROUP_SIZE_X}, ${WORKGROUP_SIZE_Y}, 1)
fn main(
  @builtin(workgroup_id) workgroupId: vec3u,
  @builtin(num_workgroups) workgroupDim: vec3u,
  @builtin(local_invocation_index) threadIndex: u32,
) {
  let linearWorkgroupId = workgroupId.x + workgroupId.y * workgroupDim.x;
  let workgroupStart = linearWorkgroupId * ${ELEMENTS_PER_WORKGROUP}u;
  let workgroupCount = paramsBuffer[0];
  let elementCount = paramsBuffer[1];

  if (threadIndex < ${BUCKET_COUNT}u) {
    atomicStore(&histogram[threadIndex], 0u);
  }
  workgroupBarrier();

  for (var round = 0u; round < ${ELEMENTS_PER_THREAD}u; round++) {
    let index = workgroupStart + round * ${THREADS_PER_WORKGROUP}u + threadIndex;
    if (index < elementCount && linearWorkgroupId < workgroupCount) {
      let digit = (inputKeys[index] >> ${currentBit}u) & 15u;
      atomicAdd(&histogram[digit], 1u);
    }
  }
  workgroupBarrier();

  if (threadIndex < ${BUCKET_COUNT}u && linearWorkgroupId < workgroupCount) {
    blockSums[threadIndex * workgroupCount + linearWorkgroupId] = atomicLoad(&histogram[threadIndex]);
  }
}
`;

const makeRadixReorderSource = (currentBit: number) => `
@group(0) @binding(0) var<storage, read> inputKeys: array<u32>;
@group(0) @binding(1) var<storage, read_write> outputKeys: array<u32>;
@group(0) @binding(2) var<storage, read> prefixBlockSums: array<u32>;
@group(0) @binding(3) var<storage, read> inputValues: array<u32>;
@group(0) @binding(4) var<storage, read_write> outputValues: array<u32>;
@group(0) @binding(5) var<storage, read> paramsBuffer: array<u32>;

var<workgroup> digitMasks: array<atomic<u32>, 128>;
var<workgroup> digitOffsets: array<u32, ${BUCKET_COUNT}>;

@compute @workgroup_size(${WORKGROUP_SIZE_X}, ${WORKGROUP_SIZE_Y}, 1)
fn main(
  @builtin(workgroup_id) workgroupId: vec3u,
  @builtin(num_workgroups) workgroupDim: vec3u,
  @builtin(local_invocation_index) threadIndex: u32,
) {
  let linearWorkgroupId = workgroupId.x + workgroupId.y * workgroupDim.x;
  let workgroupStart = linearWorkgroupId * ${ELEMENTS_PER_WORKGROUP}u;
  let workgroupCount = paramsBuffer[0];
  let elementCount = paramsBuffer[1];
  let wordIndex = threadIndex >> 5u;
  let bitIndex = threadIndex & 31u;

  if (threadIndex < ${BUCKET_COUNT}u) {
    digitOffsets[threadIndex] = 0u;
  }
  if (threadIndex < 128u) {
    atomicStore(&digitMasks[threadIndex], 0u);
  }
  workgroupBarrier();

  for (var round = 0u; round < ${ELEMENTS_PER_THREAD}u; round++) {
    let index = workgroupStart + round * ${THREADS_PER_WORKGROUP}u + threadIndex;
    let isValid = index < elementCount && linearWorkgroupId < workgroupCount;
    let key = select(0u, inputKeys[index], isValid);
    let digit = select(16u, (key >> ${currentBit}u) & 15u, isValid);
    let value = select(0u, inputValues[index], isValid);

    if (isValid) {
      atomicOr(&digitMasks[digit * 8u + wordIndex], 1u << bitIndex);
    }
    workgroupBarrier();

    if (isValid) {
      let base = digit * 8u;
      var localPrefix = digitOffsets[digit];
      for (var word = 0u; word < wordIndex; word++) {
        localPrefix += countOneBits(atomicLoad(&digitMasks[base + word]));
      }
      localPrefix += countOneBits(atomicLoad(&digitMasks[base + wordIndex]) & ((1u << bitIndex) - 1u));

      let prefixIndex = digit * workgroupCount + linearWorkgroupId;
      let sortedPosition = prefixBlockSums[prefixIndex] + localPrefix;

      outputKeys[sortedPosition] = key;
      outputValues[sortedPosition] = value;
    }

    if (round < ${ELEMENTS_PER_THREAD - 1}u) {
      workgroupBarrier();
      if (threadIndex < ${BUCKET_COUNT}u) {
        var count = 0u;
        for (var word = 0u; word < 8u; word++) {
          let maskIndex = threadIndex * 8u + word;
          count += countOneBits(atomicLoad(&digitMasks[maskIndex]));
          atomicStore(&digitMasks[maskIndex], 0u);
        }
        digitOffsets[threadIndex] += count;
      }
      workgroupBarrier();
    }
  }
}
`;

const PREFIX_SCAN_SOURCE = `
@group(0) @binding(0) var<storage, read_write> items: array<u32>;
@group(0) @binding(1) var<storage, read_write> blockSums: array<u32>;
@group(0) @binding(2) var<storage, read> paramsBuffer: array<u32>;

var<workgroup> temp: array<u32, ${PREFIX_ITEMS_PER_WORKGROUP}>;

@compute @workgroup_size(${THREADS_PER_WORKGROUP})
fn main(
  @builtin(workgroup_id) workgroupId: vec3u,
  @builtin(local_invocation_index) threadIndex: u32,
) {
  let elementCount = paramsBuffer[0];
  let elementOffset = workgroupId.x * ${PREFIX_ITEMS_PER_WORKGROUP}u + threadIndex * 2u;

  temp[threadIndex * 2u] = select(items[elementOffset], 0u, elementOffset >= elementCount);
  temp[threadIndex * 2u + 1u] = select(items[elementOffset + 1u], 0u, elementOffset + 1u >= elementCount);

  var offset = 1u;
  for (var d = ${PREFIX_ITEMS_PER_WORKGROUP / 2}u; d > 0u; d = d >> 1u) {
    workgroupBarrier();
    if (threadIndex < d) {
      let ai = offset * (threadIndex * 2u + 1u) - 1u;
      let bi = offset * (threadIndex * 2u + 2u) - 1u;
      temp[bi] += temp[ai];
    }
    offset = offset << 1u;
  }

  if (threadIndex == 0u) {
    blockSums[workgroupId.x] = temp[${PREFIX_ITEMS_PER_WORKGROUP - 1}u];
    temp[${PREFIX_ITEMS_PER_WORKGROUP - 1}u] = 0u;
  }

  for (var d = 1u; d < ${PREFIX_ITEMS_PER_WORKGROUP}u; d = d << 1u) {
    offset = offset >> 1u;
    workgroupBarrier();
    if (threadIndex < d) {
      let ai = offset * (threadIndex * 2u + 1u) - 1u;
      let bi = offset * (threadIndex * 2u + 2u) - 1u;
      let value = temp[ai];
      temp[ai] = temp[bi];
      temp[bi] += value;
    }
  }
  workgroupBarrier();

  if (elementOffset < elementCount) {
    items[elementOffset] = temp[threadIndex * 2u];
  }
  if (elementOffset + 1u < elementCount) {
    items[elementOffset + 1u] = temp[threadIndex * 2u + 1u];
  }
}
`;

const PREFIX_ADD_SOURCE = `
@group(0) @binding(0) var<storage, read_write> items: array<u32>;
@group(0) @binding(1) var<storage, read> blockSums: array<u32>;
@group(0) @binding(2) var<storage, read> paramsBuffer: array<u32>;

@compute @workgroup_size(${THREADS_PER_WORKGROUP})
fn main(
  @builtin(workgroup_id) workgroupId: vec3u,
  @builtin(local_invocation_index) threadIndex: u32,
) {
  let elementCount = paramsBuffer[0];
  let elementOffset = workgroupId.x * ${PREFIX_ITEMS_PER_WORKGROUP}u + threadIndex * 2u;
  if (elementOffset >= elementCount) {
    return;
  }

  let blockSum = blockSums[workgroupId.x];
  items[elementOffset] += blockSum;
  if (elementOffset + 1u < elementCount) {
    items[elementOffset + 1u] += blockSum;
  }
}
`;

const VALIDATION_CLEAR_SOURCE = `
@group(0) @binding(0) var<storage, read_write> counters: array<atomic<u32>>;

@compute @workgroup_size(4)
fn main(@builtin(global_invocation_id) globalId: vec3u) {
  if (globalId.x < 8u) {
    atomicStore(&counters[globalId.x], 0u);
  }
}
`;

const VALIDATION_SOURCE = `
@group(0) @binding(0) var<storage, read> inputKeys: array<u32>;
@group(0) @binding(1) var<storage, read> sortedIndices: array<u32>;
@group(0) @binding(2) var<storage, read_write> counters: array<atomic<u32>>;
@group(0) @binding(3) var<storage, read> paramsBuffer: array<u32>;

@compute @workgroup_size(${THREADS_PER_WORKGROUP})
fn main(@builtin(global_invocation_id) globalId: vec3u) {
  let index = globalId.x;
  let elementCount = paramsBuffer[1];
  if (index + 1u >= elementCount) {
    return;
  }

  let left = sortedIndices[index];
  let right = sortedIndices[index + 1u];
  if (left >= elementCount || right >= elementCount) {
    atomicAdd(&counters[2], 1u);
    return;
  }

  let leftKey = inputKeys[left];
  let rightKey = inputKeys[right];
  if (leftKey > rightKey) {
    atomicAdd(&counters[0], 1u);
  }
  if (leftKey < rightKey) {
    atomicAdd(&counters[1], 1u);
  }
  if (left == right) {
    atomicAdd(&counters[3], 1u);
  }

  atomicAdd(&counters[4], left);
  atomicXor(&counters[5], left);
  atomicAdd(&counters[6], 1u);

  if (index + 2u == elementCount) {
    atomicAdd(&counters[4], right);
    atomicXor(&counters[5], right);
    atomicAdd(&counters[6], 1u);
  }
}
`;

type GpuRadixSortStats = {
  enabled: boolean;
  dispatched: boolean;
  lastDispatchMs: number;
  lastDispatchSplats: number;
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
  private readonly workgroupCount: number;
  private readonly dispatchX: number;
  private readonly dispatchY: number;
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
    private readonly splatCount: number,
    private readonly sortBits = DEFAULT_SORT_BITS,
    private readonly validationEnabled = true,
  ) {
    const engine = scene.getEngine() as WebGPUEngine;
    this.tempBufferArena = new GpuBufferArena(engine, "GpuRadixSortTemp");
    const elementBytes = splatCount * 4;
    this.workgroupCount = Math.ceil(splatCount / ELEMENTS_PER_WORKGROUP);
    this.dispatchX = Math.min(this.workgroupCount, 65535);
    this.dispatchY = Math.ceil(this.workgroupCount / this.dispatchX);
    this.params = new StorageBuffer(engine, this.paramsData.byteLength, undefined, "GpuRadixSortParams");
    this.keyScratchA = new StorageBuffer(engine, elementBytes, undefined, "GpuRadixSortKeyScratchA");
    this.keyScratchB = new StorageBuffer(engine, elementBytes, undefined, "GpuRadixSortKeyScratchB");
    this.initialValues = new StorageBuffer(engine, elementBytes, undefined, "GpuRadixSortInitialValues");
    this.valueScratchA = new StorageBuffer(engine, elementBytes, undefined, "GpuRadixSortValueScratchA");
    this.valueScratchB = new StorageBuffer(engine, elementBytes, undefined, "GpuRadixSortValueScratchB");
    this.initialValues.update(this.createSequentialIndices(splatCount));
    this.validationCounters = new StorageBuffer(engine, this.validationReadback.byteLength, undefined, "GpuRadixValidationCounters");
    this.expectedIndexSum = this.computeExpectedIndexSum(splatCount);
    this.expectedIndexXor = this.computeExpectedIndexXor(splatCount);
    this.blockSums = new StorageBuffer(
      engine,
      BUCKET_COUNT * this.workgroupCount * 4,
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

    this.createPrefixPasses(engine, this.blockSums, BUCKET_COUNT * this.workgroupCount);
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
  }

  dispatch(): boolean {
    if (this.splatCount <= 0) {
      return false;
    }

    const start = performance.now();
    this.paramsData[0] = this.workgroupCount;
    this.paramsData[1] = this.splatCount;
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
      dispatched = histogram.dispatch(this.dispatchX, this.dispatchY, 1) && dispatched;

      this.dispatchPrefixPasses();

      reorder.setStorageBuffer("inputKeys", inputKeys);
      reorder.setStorageBuffer("outputKeys", outputKeys);
      reorder.setStorageBuffer("prefixBlockSums", this.blockSums);
      reorder.setStorageBuffer("inputValues", inputValues);
      reorder.setStorageBuffer("outputValues", isLastPass ? this.outputIndices : outputValues);
      reorder.setStorageBuffer("paramsBuffer", this.params);
      dispatched = reorder.dispatch(this.dispatchX, this.dispatchY, 1) && dispatched;

      if (!isLastPass) {
        inputKeys = outputKeys;
        outputKeys = outputKeys === this.keyScratchA ? this.keyScratchB : this.keyScratchA;
        inputValues = outputValues;
        outputValues = outputValues === this.valueScratchA ? this.valueScratchB : this.valueScratchA;
      }
    }

    if (dispatched) {
      this.dispatchValidation();
      this.lastDispatchMs = performance.now() - start;
      this.lastDispatchSplats = this.splatCount;
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
        this.validatedIndexCount === this.splatCount &&
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

  private dispatchValidation(): void {
    if (!this.validationEnabled || this.validationPending) {
      return;
    }

    this.validationClearShader.dispatch(1);
    this.validationShader.dispatch(Math.ceil(this.splatCount / THREADS_PER_WORKGROUP));
    this.validationPending = true;
    this.validationSamples = Math.max(0, this.splatCount - 1);
    void this.readValidationCounters();
  }

  private async readValidationCounters(): Promise<void> {
    try {
      const result = await this.validationCounters.read(0, this.validationReadback.byteLength, this.validationReadback, true);
      const counters =
        result instanceof Uint32Array
          ? result
          : new Uint32Array(result.buffer, result.byteOffset, Math.floor(result.byteLength / 4));
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
    let sum = 0;
    for (let i = 0; i < count; i++) {
      sum = (sum + i) >>> 0;
    }
    return sum;
  }

  private computeExpectedIndexXor(count: number): number {
    let xor = 0;
    for (let i = 0; i < count; i++) {
      xor = (xor ^ i) >>> 0;
    }
    return xor;
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

  private dispatchPrefixPasses(): void {
    for (const pass of this.prefixPasses) {
      pass.paramsData[0] = pass.count;
      pass.paramsData[1] = 0;
      pass.paramsData[2] = 0;
      pass.paramsData[3] = 0;
      pass.params.update(pass.paramsData);
      pass.scanShader.dispatch(pass.dispatchCount);
    }

    for (let i = this.prefixPasses.length - 1; i >= 0; i--) {
      const pass = this.prefixPasses[i];
      if (pass.addShader) {
        pass.addShader.dispatch(pass.dispatchCount);
      }
    }
  }
}

export { GpuRadixSortPass };
export type { GpuRadixSortStats };
