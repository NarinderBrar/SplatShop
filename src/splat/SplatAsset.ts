import type { Transform } from "@playcanvas/splat-transform";

import type { SplatData } from "./SplatData";

type SplatAssetKind = "expanded" | "sog" | "ssog";

type SplatAssetStats = {
  sourceSplats: number;
  sourceFormat: string;
  runtimeMode: "expanded" | "packed";
  isLod: boolean;
  boundsMin?: [number, number, number];
  boundsMax?: [number, number, number];
};

type SogPackedData = {
  numSplats: number;
  textureWidth: number;
  textureHeight: number;
  meansL: Uint32Array;
  meansU: Uint32Array;
  quats: Uint32Array;
  scales: Uint32Array;
  sh0: Uint32Array;
  scaleCodebook: Float32Array;
  sh0Codebook: Float32Array;
  shN?: {
    bands: number;
    coeffsPerChannel: number;
    paletteCount: number;
    centroids: Uint32Array;
    labels: Uint32Array;
    codebook: Float32Array;
    codebookLength: number;
    fileCount: number;
    centroidWidth: number;
    centroidHeight: number;
  };
  meansMins: [number, number, number];
  meansMaxs: [number, number, number];
  centers: Float32Array;
  boundsMin: [number, number, number];
  boundsMax: [number, number, number];
};

type SsogMetadata = {
  lodLevels: number;
  environment: unknown;
  filenames: string[];
  tree: unknown;
};

type SsogBound = {
  min: [number, number, number];
  max: [number, number, number];
};

type SsogPackedChunk = {
  filename: string;
  nodeId: number;
  parentNodeId?: number;
  depth: number;
  fileIndex: number;
  lod: number;
  offset: number;
  count: number;
  bound: SsogBound;
  data: SogPackedData;
};

type SsogChunkEntry = Omit<SsogPackedChunk, "data" | "filename">;
type SsogChunkLoader = (entry: SsogChunkEntry) => Promise<SsogPackedChunk>;

type ExpandedSplatAsset = {
  kind: "expanded";
  filename: string;
  sourceFormat: string;
  data: SplatData;
  transform: Transform;
  stats: SplatAssetStats;
};

type SogSplatAsset = {
  kind: "sog";
  filename: string;
  sourceFormat: "sog";
  data?: SplatData;
  transform: Transform;
  stats: SplatAssetStats;
  packed:
    | {
        enabled: true;
        data: SogPackedData;
      }
    | {
        enabled: false;
        reason: string;
      };
};

type SsogSplatAsset = {
  kind: "ssog";
  filename: string;
  sourceFormat: "ssog";
  data?: SplatData;
  transform: Transform;
  stats: SplatAssetStats;
  metadata?: SsogMetadata;
  entries?: SsogChunkEntry[];
  loadChunk?: SsogChunkLoader;
  chunks: SsogPackedChunk[];
};

type SplatAsset = ExpandedSplatAsset | SogSplatAsset | SsogSplatAsset;

const createExpandedSplatAsset = (
  filename: string,
  sourceFormat: string,
  data: SplatData,
  transform: Transform,
): ExpandedSplatAsset => ({
  kind: "expanded",
  filename,
  sourceFormat,
  data,
  transform,
  stats: {
    sourceSplats: data.numSplats,
    sourceFormat,
    runtimeMode: "expanded",
    isLod: false,
  },
});

const createSogSplatAsset = (
  filename: string,
  data: SplatData,
  transform: Transform,
  reason = "SOG is detected separately; packed GPU decode is the next render backend.",
): SogSplatAsset => ({
  kind: "sog",
  filename,
  sourceFormat: "sog",
  data,
  transform,
  stats: {
    sourceSplats: data.numSplats,
    sourceFormat: "sog",
    runtimeMode: "expanded",
    isLod: false,
  },
  packed: {
    enabled: false,
    reason,
  },
});

const createPackedSogSplatAsset = (
  filename: string,
  packedData: SogPackedData,
  transform: Transform,
): SogSplatAsset => ({
  kind: "sog",
  filename,
  sourceFormat: "sog",
  transform,
  stats: {
    sourceSplats: packedData.numSplats,
    sourceFormat: "sog",
    runtimeMode: "packed",
    isLod: false,
    boundsMin: packedData.boundsMin,
    boundsMax: packedData.boundsMax,
  },
  packed: {
    enabled: true,
    data: packedData,
  },
});

const createSsogSplatAsset = (
  filename: string,
  data: SplatData,
  transform: Transform,
): SsogSplatAsset => ({
  kind: "ssog",
  filename,
  sourceFormat: "ssog",
  data,
  transform,
  stats: {
    sourceSplats: data.numSplats,
    sourceFormat: "ssog",
    runtimeMode: "expanded",
    isLod: true,
  },
  chunks: [],
});

const createPackedSsogSplatAsset = (
  filename: string,
  metadata: SsogMetadata,
  chunks: SsogPackedChunk[],
  transform: Transform,
): SsogSplatAsset => {
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
  const finestLod = chunks.reduce((min, chunk) => Math.min(min, chunk.lod), Number.POSITIVE_INFINITY);
  let sourceSplats = 0;

  for (const chunk of chunks) {
    if (chunk.lod === finestLod) {
      sourceSplats += chunk.data.numSplats;
    }
    for (let axis = 0; axis < 3; axis++) {
      boundsMin[axis] = Math.min(boundsMin[axis], chunk.data.boundsMin[axis]);
      boundsMax[axis] = Math.max(boundsMax[axis], chunk.data.boundsMax[axis]);
    }
  }

  return {
    kind: "ssog",
    filename,
    sourceFormat: "ssog",
    transform,
    stats: {
      sourceSplats,
      sourceFormat: "ssog",
      runtimeMode: "packed",
      isLod: true,
      boundsMin,
      boundsMax,
    },
    metadata,
    chunks,
  };
};

const createStreamingSsogSplatAsset = (
  filename: string,
  metadata: SsogMetadata,
  entries: SsogChunkEntry[],
  loadChunk: SsogChunkLoader,
  transform: Transform,
): SsogSplatAsset => {
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
  const finestLod = entries.reduce((min, entry) => Math.min(min, entry.lod), Number.POSITIVE_INFINITY);
  let sourceSplats = 0;

  for (const entry of entries) {
    if (entry.lod === finestLod) {
      sourceSplats += entry.count;
    }
    for (let axis = 0; axis < 3; axis++) {
      boundsMin[axis] = Math.min(boundsMin[axis], entry.bound.min[axis]);
      boundsMax[axis] = Math.max(boundsMax[axis], entry.bound.max[axis]);
    }
  }

  return {
    kind: "ssog",
    filename,
    sourceFormat: "ssog",
    transform,
    stats: {
      sourceSplats,
      sourceFormat: "ssog",
      runtimeMode: "packed",
      isLod: true,
      boundsMin,
      boundsMax,
    },
    metadata,
    entries,
    loadChunk,
    chunks: [],
  };
};

export {
  createExpandedSplatAsset,
  createPackedSogSplatAsset,
  createPackedSsogSplatAsset,
  createStreamingSsogSplatAsset,
  createSogSplatAsset,
  createSsogSplatAsset,
};
export type {
  ExpandedSplatAsset,
  SsogBound,
  SsogChunkEntry,
  SsogChunkLoader,
  SsogMetadata,
  SsogPackedChunk,
  SogPackedData,
  SogSplatAsset,
  SplatAsset,
  SplatAssetKind,
  SplatAssetStats,
  SsogSplatAsset,
};
