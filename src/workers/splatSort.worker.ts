/// <reference lib="webworker" />

type InitMessage = {
  type: "init";
  centers: ArrayBuffer;
  indices: ArrayBuffer;
};

type SortMessage = {
  type: "sort";
  cameraPosition: [number, number, number];
  cameraForward: [number, number, number];
};

type WorkerMessage = InitMessage | SortMessage;

const workerSelf = self as unknown as DedicatedWorkerGlobalScope;

let centers: Float32Array | undefined;
let sourceIndices: Uint32Array | undefined;
let depthKeys: Uint32Array | undefined;
let countBuffer: Uint32Array | undefined;

const NUM_BINS = 32;
const WEIGHT_TIERS = [
  { maxDistance: 0, weight: 40 },
  { maxDistance: 2, weight: 20 },
  { maxDistance: 5, weight: 8 },
  { maxDistance: 10, weight: 3 },
  { maxDistance: Number.POSITIVE_INFINITY, weight: 1 },
] as const;

const binBase = new Float32Array(NUM_BINS + 1);
const binDivider = new Float32Array(NUM_BINS + 1);
const bitsPerBin = new Float32Array(NUM_BINS);
const weightByDistance = new Float32Array(NUM_BINS);

for (let distance = 0; distance < NUM_BINS; distance++) {
  let weight = 1;
  for (const tier of WEIGHT_TIERS) {
    if (distance <= tier.maxDistance) {
      weight = tier.weight;
      break;
    }
  }
  weightByDistance[distance] = weight;
}

const clampKey = (value: number, maxKey: number): number => {
  if (value < 0) {
    return 0;
  }
  if (value > maxKey) {
    return maxKey;
  }
  return value;
};

const computeCameraBin = (minDepth: number, range: number): number => {
  if (range <= 1e-6) {
    return 0;
  }
  const cameraBin = Math.floor((-minDepth / range) * NUM_BINS);
  return Math.max(0, Math.min(NUM_BINS - 1, cameraBin));
};

const updateBinWeights = (cameraBin: number, bucketCount: number): void => {
  let totalWeight = 0;
  for (let i = 0; i < NUM_BINS; i++) {
    const distance = Math.abs(i - cameraBin);
    const weight = weightByDistance[distance];
    bitsPerBin[i] = weight;
    totalWeight += weight;
  }

  let accumulated = 0;
  for (let i = 0; i < NUM_BINS; i++) {
    const divider = Math.max(1, Math.floor((bitsPerBin[i] / totalWeight) * bucketCount));
    binBase[i] = accumulated;
    binDivider[i] = divider;
    accumulated += divider;
  }

  if (accumulated > bucketCount) {
    binDivider[NUM_BINS - 1] = Math.max(1, binDivider[NUM_BINS - 1] - (accumulated - bucketCount));
  }

  binBase[NUM_BINS] = binBase[NUM_BINS - 1] + binDivider[NUM_BINS - 1];
  binDivider[NUM_BINS] = 0;
};

workerSelf.onmessage = (event: MessageEvent<WorkerMessage>) => {
  const message = event.data;

  if (message.type === "init") {
    centers = new Float32Array(message.centers);
    sourceIndices = new Uint32Array(message.indices);
    depthKeys = new Uint32Array(sourceIndices.length);
    countBuffer = undefined;
    return;
  }

  if (!centers || !sourceIndices || !depthKeys) {
    return;
  }

  const localCenters = centers;
  const localSourceIndices = sourceIndices;
  const localDepthKeys = depthKeys;
  const [cx, cy, cz] = message.cameraPosition;
  const [fx, fy, fz] = message.cameraForward;
  const cameraDepth = cx * fx + cy * fy + cz * fz;
  let minDepth = Number.POSITIVE_INFINITY;
  let maxDepth = Number.NEGATIVE_INFINITY;

  for (let i = 0; i < localSourceIndices.length; i++) {
    const centerOffset = i * 3;
    const depth =
      localCenters[centerOffset + 0] * fx +
      localCenters[centerOffset + 1] * fy +
      localCenters[centerOffset + 2] * fz -
      cameraDepth;
    minDepth = Math.min(minDepth, depth);
    maxDepth = Math.max(maxDepth, depth);
  }

  const splatCount = localSourceIndices.length;
  const compareBits = Math.max(10, Math.min(20, Math.round(Math.log2(splatCount / 4))));
  const bucketCount = 2 ** compareBits + 1;
  const maxKey = bucketCount - 1;
  if (!countBuffer || countBuffer.length !== bucketCount) {
    countBuffer = new Uint32Array(bucketCount);
  } else {
    countBuffer.fill(0);
  }

  const localCountBuffer = countBuffer;
  const range = maxDepth - minDepth;
  const invBinRange = range > 1e-6 ? NUM_BINS / range : 0;
  const cameraBin = computeCameraBin(minDepth, range);
  updateBinWeights(cameraBin, bucketCount);

  for (let i = 0; i < splatCount; i++) {
    const centerOffset = i * 3;
    const depth =
      localCenters[centerOffset + 0] * fx +
      localCenters[centerOffset + 1] * fy +
      localCenters[centerOffset + 2] * fz -
      cameraDepth;
    const binDistance = range > 1e-6 ? (maxDepth - depth) * invBinRange : 0;
    const bin = Math.max(0, Math.min(NUM_BINS, binDistance >>> 0));
    const key = clampKey((binBase[bin] + binDivider[bin] * (binDistance - bin)) >>> 0, maxKey);
    localDepthKeys[i] = key;
    localCountBuffer[key]++;
  }

  for (let i = 1; i < bucketCount; i++) {
    localCountBuffer[i] += localCountBuffer[i - 1];
  }

  const sortedIndices = new Uint32Array(splatCount);
  for (let i = splatCount - 1; i >= 0; i--) {
    const key = localDepthKeys[i];
    const dst = --localCountBuffer[key];
    sortedIndices[dst] = localSourceIndices[i];
  }

  workerSelf.postMessage(
    {
      type: "sorted",
      indices: sortedIndices.buffer,
    },
    [sortedIndices.buffer],
  );
};

export {};
