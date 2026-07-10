/**
 * Unified loader for all splat file formats using splat-transform.
 *
 * This follows SuperSplat's `src/io/read/loader.ts` closely. SplatShop converts
 * the `DataTable` into its own runtime-neutral `SplatData` instead of
 * PlayCanvas `GSplatData`.
 */

import {
  getInputFormat,
  readFile,
  sortMortonOrder,
  type Options,
  type ReadFileSystem,
  Transform,
  WebPCodec,
  ZipReadFileSystem,
} from "@playcanvas/splat-transform";
import webpWasmUrl from "@playcanvas/splat-transform/lib/webp.wasm?url";

import { dataTableToSplatData, type SplatData } from "../../splat/SplatData";
import {
  createExpandedSplatAsset,
  createPackedSogSplatAsset,
  createPackedSsogSplatAsset,
  createStreamingSsogSplatAsset,
  createSogSplatAsset,
  createSsogSplatAsset,
  type SogPackedData,
  type SsogBound,
  type SsogChunkEntry,
  type SsogMetadata,
  type SsogPackedChunk,
  type SplatAsset,
} from "../../splat/SplatAsset";

WebPCodec.wasmUrl = webpWasmUrl;

type LoadResult = {
  splatData?: SplatData;
  transform: Transform;
  asset: SplatAsset;
};

const defaultOptions: Options = {
  iterations: 10,
  lodSelect: [0],
  unbundled: false,
  lodChunkCount: 512,
  lodChunkExtent: 16,
};

type SogMetaV2 = {
  version: 2;
  count: number;
  means: {
    mins: [number, number, number];
    maxs: [number, number, number];
    files: [string, string];
  };
  scales: {
    codebook: number[];
    files: [string];
  };
  quats: {
    files: [string];
  };
  sh0: {
    codebook: number[];
    files: [string];
  };
  shN?: {
    bands: number;
    count: number;
    codebook: number[];
    files: [string, string] | string[];
  };
};

type SogRange = {
  offset: number;
  count: number;
};

type SogDecodeMemberTiming = {
  member: string;
  bytes: number;
  readMs: number;
  decodeMs: number;
  width: number;
  height: number;
};

type SogDecodeDebugStats = {
  filename: string;
  decodeCount: number;
  totalMs: number;
  totalReadMs: number;
  totalWebpDecodeMs: number;
  totalRequestedSplats: number;
  totalSourceSplats: number;
  ranges: string[];
};

type SogDecodedBackingData = {
  sourceCount: number;
  textureWidth: number;
  textureHeight: number;
  meansL: Uint32Array;
  meansU: Uint32Array;
  quats: Uint32Array;
  scales: Uint32Array;
  sh0: Uint32Array;
  scaleCodebook: Float32Array;
  sh0Codebook: Float32Array;
  shN?: SogPackedData["shN"];
  meansMins: [number, number, number];
  meansMaxs: [number, number, number];
  centers: Float32Array;
  boundsMin: [number, number, number];
  boundsMax: [number, number, number];
};

const sogDecodeDebugStats = new Map<string, SogDecodeDebugStats>();

const isSogDecodeDebugEnabled = (): boolean => {
  const value = new URLSearchParams(window.location.search).get("ssogDecodeDebug");
  return value === "true" || value === "1" || value === "debug";
};

const updateSogDecodeDebugStats = (
  filename: string,
  sourceCount: number,
  offset: number,
  count: number,
  totalMs: number,
  timings: SogDecodeMemberTiming[],
): SogDecodeDebugStats => {
  let stats = sogDecodeDebugStats.get(filename);
  if (!stats) {
    stats = {
      filename,
      decodeCount: 0,
      totalMs: 0,
      totalReadMs: 0,
      totalWebpDecodeMs: 0,
      totalRequestedSplats: 0,
      totalSourceSplats: 0,
      ranges: [],
    };
    sogDecodeDebugStats.set(filename, stats);
  }

  stats.decodeCount++;
  stats.totalMs += totalMs;
  stats.totalReadMs += timings.reduce((sum, timing) => sum + timing.readMs, 0);
  stats.totalWebpDecodeMs += timings.reduce((sum, timing) => sum + timing.decodeMs, 0);
  stats.totalRequestedSplats += count;
  stats.totalSourceSplats += sourceCount;
  stats.ranges.push(`${offset}:${count}`);
  if (stats.ranges.length > 12) {
    stats.ranges.shift();
  }

  (window as unknown as { __splatShopSogDecodeStats?: SogDecodeDebugStats[] }).__splatShopSogDecodeStats = Array.from(
    sogDecodeDebugStats.values(),
  );

  return stats;
};

const dirname = (filename: string): string => {
  const index = filename.lastIndexOf("/");
  return index >= 0 ? filename.slice(0, index + 1) : "";
};

const joinRelative = (base: string, filename: string): string => {
  if (base.length === 0 || /^[a-z]+:\/\//i.test(filename) || filename.startsWith("/")) {
    return filename;
  }
  return `${base}${filename}`;
};

const readBytes = async (fileSystem: ReadFileSystem, filename: string): Promise<Uint8Array> => {
  const source = await fileSystem.createSource(filename);
  try {
    return await source.read().readAll();
  } finally {
    source.close();
  }
};

const rgbaToUint32 = (rgba: Uint8Array): Uint32Array =>
  new Uint32Array(rgba.buffer, rgba.byteOffset, rgba.byteLength / Uint32Array.BYTES_PER_ELEMENT);

const channel = (pixel: number, component: number): number => (pixel >>> (component * 8)) & 0xff;

const decodeSogCenter = (
  meta: SogMetaV2,
  meansL: Uint32Array,
  meansU: Uint32Array,
  index: number,
): [number, number, number] => {
  const lo = meansL[index];
  const hi = meansU[index];
  const out: [number, number, number] = [0, 0, 0];

  for (let axis = 0; axis < 3; axis++) {
    const t = ((channel(hi, axis) << 8) + channel(lo, axis)) / 65535;
    const encoded = meta.means.mins[axis] * (1 - t) + meta.means.maxs[axis] * t;
    out[axis] = Math.sign(encoded) * (Math.exp(Math.abs(encoded)) - 1);
  }

  return out;
};

const shCoeffCount = (bands: number): number => [0, 3, 8, 15][bands] ?? 0;

const decodePackedSogBackingData = async (
  filename: string,
  fileSystem: ReadFileSystem,
): Promise<SogDecodedBackingData> => {
  const debugDecode = isSogDecodeDebugEnabled();
  const totalStart = performance.now();
  const lowerFilename = filename.toLowerCase();
  const isBundledSog = lowerFilename.endsWith(".sog");
  const source = isBundledSog ? await fileSystem.createSource(filename) : undefined;
  const sogFs = source ? new ZipReadFileSystem(source) : fileSystem;
  const metaFilename = isBundledSog ? "meta.json" : filename;
  const memberBase = isBundledSog ? "" : dirname(metaFilename);
  const backingFilename = isBundledSog ? filename : metaFilename;
  const decodeTimings: SogDecodeMemberTiming[] = [];
  let metaReadMs = 0;
  let decoderCreateMs = 0;
  let primaryDecodeMs = 0;
  let shNMs = 0;
  let centersMs = 0;

  try {
    const metaReadStart = performance.now();
    const metaBytes = await readBytes(sogFs, metaFilename);
    metaReadMs = performance.now() - metaReadStart;
    const meta = JSON.parse(new TextDecoder().decode(metaBytes)) as SogMetaV2;
    if (meta.version !== 2) {
      throw new Error(`Packed SplatShop SOG currently supports SOG v2 only. Found v${meta.version}.`);
    }

    const decoderCreateStart = performance.now();
    const decoder = await WebPCodec.create();
    decoderCreateMs = performance.now() - decoderCreateStart;
    const decode = async (member: string) => {
      const readStart = performance.now();
      const bytes = await readBytes(sogFs, joinRelative(memberBase, member));
      const readMs = performance.now() - readStart;
      const decodeStart = performance.now();
      const image = await decoder.decodeRGBA(bytes);
      const decodeMs = performance.now() - decodeStart;
      decodeTimings.push({
        member,
        bytes: bytes.byteLength,
        readMs,
        decodeMs,
        width: image.width,
        height: image.height,
      });
      return image;
    };
    const primaryDecodeStart = performance.now();
    const [meansLImage, meansUImage, quatsImage, scalesImage, sh0Image] = await Promise.all([
      decode(meta.means.files[0]),
      decode(meta.means.files[1]),
      decode(meta.quats.files[0]),
      decode(meta.scales.files[0]),
      decode(meta.sh0.files[0]),
    ]);
    primaryDecodeMs = performance.now() - primaryDecodeStart;

    const sourceCount = meta.count;
    const meansL = rgbaToUint32(meansLImage.rgba).slice();
    const meansU = rgbaToUint32(meansUImage.rgba).slice();
    const quats = rgbaToUint32(quatsImage.rgba).slice();
    const scales = rgbaToUint32(scalesImage.rgba).slice();
    const sh0 = rgbaToUint32(sh0Image.rgba).slice();
    const loadShN = async (): Promise<SogPackedData["shN"]> => {
      const shN = meta.shN;
      if (!shN) {
        return undefined;
      }

      const coeffsPerChannel = shCoeffCount(shN.bands);
      if (coeffsPerChannel <= 0 || shN.files.length < 2) {
        return undefined;
      }

      const [centroidsImage, labelsImage] = await Promise.all([decode(shN.files[0]), decode(shN.files[1])]);
      const expectedCentroidWidth = 64 * coeffsPerChannel;
      if (centroidsImage.width !== expectedCentroidWidth) {
        throw new Error(
          `Invalid SOG shN centroid texture width ${centroidsImage.width}; expected ${expectedCentroidWidth}.`,
        );
      }

      const labelsSource = rgbaToUint32(labelsImage.rgba);
      if (labelsSource.length < sourceCount) {
        throw new Error(`Invalid SOG shN labels: ${labelsSource.length} entries for ${sourceCount} splats.`);
      }

      return {
        bands: shN.bands,
        coeffsPerChannel,
        paletteCount: shN.count,
        centroids: rgbaToUint32(centroidsImage.rgba).slice(),
        labels: labelsSource.slice(),
        codebook: new Float32Array(shN.codebook),
        codebookLength: shN.codebook.length,
        fileCount: shN.files.length,
        centroidWidth: centroidsImage.width,
        centroidHeight: centroidsImage.height,
      };
    };
    const shNStart = performance.now();
    const shN = await loadShN();
    shNMs = performance.now() - shNStart;
    const centers = new Float32Array(sourceCount * 3);
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

    const centersStart = performance.now();
    for (let i = 0; i < sourceCount; i++) {
      const center = decodeSogCenter(meta, meansL, meansU, i);
      const centerOffset = i * 3;
      centers[centerOffset + 0] = center[0];
      centers[centerOffset + 1] = center[1];
      centers[centerOffset + 2] = center[2];

      for (let axis = 0; axis < 3; axis++) {
        boundsMin[axis] = Math.min(boundsMin[axis], center[axis]);
        boundsMax[axis] = Math.max(boundsMax[axis], center[axis]);
      }
    }
    centersMs = performance.now() - centersStart;

    const result: SogDecodedBackingData = {
      sourceCount,
      textureWidth: meansLImage.width,
      textureHeight: meansLImage.height,
      meansL,
      meansU,
      quats,
      scales,
      sh0,
      scaleCodebook: new Float32Array(meta.scales.codebook),
      sh0Codebook: new Float32Array(meta.sh0.codebook),
      shN,
      meansMins: meta.means.mins,
      meansMaxs: meta.means.maxs,
      centers,
      boundsMin,
      boundsMax,
    };

    if (debugDecode) {
      const totalMs = performance.now() - totalStart;
      const stats = updateSogDecodeDebugStats(backingFilename, sourceCount, 0, sourceCount, totalMs, decodeTimings);
      const webpDecodeMs = decodeTimings.reduce((sum, timing) => sum + timing.decodeMs, 0);
      const readMs = metaReadMs + decodeTimings.reduce((sum, timing) => sum + timing.readMs, 0);
      console.info("[SplatShop][SOG decode]", {
        filename: backingFilename,
        requestedOffset: 0,
        requestedCount: sourceCount,
        sourceCount,
        requestedSourceRatio: 1,
        decodeCountForFile: stats.decodeCount,
        totalMs,
        readMs,
        webpDecodeMs,
        metaReadMs,
        decoderCreateMs,
        primaryDecodeMs,
        shNMs,
        centersMs,
        members: decodeTimings,
        recentRangesForFile: stats.ranges,
      });
    }

    return result;
  } finally {
    if (sogFs instanceof ZipReadFileSystem) {
      sogFs.close();
    }
  }
};

const getSogRangeBounds = (sourceCount: number, range?: SogRange): { start: number; end: number; count: number } => {
  const rangeOffset = Math.max(0, Math.floor(range?.offset ?? 0));
  const rangeCount = Math.max(0, Math.floor(range?.count ?? sourceCount - rangeOffset));
  const start = Math.min(sourceCount, rangeOffset);
  const end = Math.min(sourceCount, start + rangeCount);
  return { start, end, count: end - start };
};

const computeSogRangeBounds = (
  centers: Float32Array,
  count: number,
): { boundsMin: [number, number, number]; boundsMax: [number, number, number] } => {
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

  for (let i = 0; i < count; i++) {
    const centerOffset = i * 3;
    for (let axis = 0; axis < 3; axis++) {
      const value = centers[centerOffset + axis];
      boundsMin[axis] = Math.min(boundsMin[axis], value);
      boundsMax[axis] = Math.max(boundsMax[axis], value);
    }
  }

  return { boundsMin, boundsMax };
};

const createPackedSogDataRange = (backing: SogDecodedBackingData, range?: SogRange): SogPackedData => {
  const { start, end, count } = getSogRangeBounds(backing.sourceCount, range);
  const centers = backing.centers.slice(start * 3, end * 3);
  const { boundsMin, boundsMax } = computeSogRangeBounds(centers, count);
  const shN = backing.shN
    ? {
        ...backing.shN,
        centroids: backing.shN.centroids,
        labels: backing.shN.labels.slice(start, end),
        codebook: backing.shN.codebook,
      }
    : undefined;

  return {
    numSplats: count,
    textureWidth: backing.textureWidth,
    textureHeight: backing.textureHeight,
    meansL: backing.meansL.slice(start, end),
    meansU: backing.meansU.slice(start, end),
    quats: backing.quats.slice(start, end),
    scales: backing.scales.slice(start, end),
    sh0: backing.sh0.slice(start, end),
    scaleCodebook: backing.scaleCodebook,
    sh0Codebook: backing.sh0Codebook,
    shN,
    meansMins: backing.meansMins,
    meansMaxs: backing.meansMaxs,
    centers,
    boundsMin,
    boundsMax,
  };
};

const loadPackedSogData = async (
  filename: string,
  fileSystem: ReadFileSystem,
  range?: SogRange,
): Promise<SogPackedData> => createPackedSogDataRange(await decodePackedSogBackingData(filename, fileSystem), range);

class SogDecodedBackingStore {
  private readonly decoded = new Map<string, SogDecodedBackingData>();
  private readonly pendingDecoded = new Map<string, Promise<SogDecodedBackingData>>();
  private readonly pendingRanges = new Map<string, Promise<SogPackedData>>();

  async loadRange(filename: string, fileSystem: ReadFileSystem, range?: SogRange): Promise<SogPackedData> {
    const rangeKey = this.getRangeKey(filename, range);
    const pendingRange = this.pendingRanges.get(rangeKey);
    if (pendingRange) {
      return pendingRange;
    }

    const promise = this.loadBacking(filename, fileSystem).then((backing) => createPackedSogDataRange(backing, range));
    this.pendingRanges.set(rangeKey, promise);
    try {
      return await promise;
    } finally {
      this.pendingRanges.delete(rangeKey);
    }
  }

  private async loadBacking(filename: string, fileSystem: ReadFileSystem): Promise<SogDecodedBackingData> {
    const decoded = this.decoded.get(filename);
    if (decoded) {
      return decoded;
    }

    const pendingDecoded = this.pendingDecoded.get(filename);
    if (pendingDecoded) {
      return pendingDecoded;
    }

    const promise = decodePackedSogBackingData(filename, fileSystem);
    this.pendingDecoded.set(filename, promise);
    try {
      const result = await promise;
      this.decoded.set(filename, result);
      return result;
    } finally {
      this.pendingDecoded.delete(filename);
    }
  }

  private getRangeKey(filename: string, range?: SogRange): string {
    const offset = Math.max(0, Math.floor(range?.offset ?? 0));
    const count = Math.max(0, Math.floor(range?.count ?? Number.POSITIVE_INFINITY));
    return `${filename}:${offset}:${count}`;
  }
}

const getSsogMaxChunks = (): number => {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get("ssogMaxChunks");
  if (raw === "all") {
    return Number.POSITIVE_INFINITY;
  }

  const explicit = Number(raw);
  if (Number.isFinite(explicit) && explicit > 0) {
    return Math.floor(explicit);
  }

  const quality = params.get("quality");
  if (quality === "fast") {
    return 4;
  }
  if (quality === "balanced") {
    return 8;
  }
  return 16;
};

const isSsogBound = (value: unknown): value is SsogBound => {
  if (!value || typeof value !== "object") {
    return false;
  }

  const bound = value as Record<string, unknown>;
  return Array.isArray(bound.min) && bound.min.length === 3 && Array.isArray(bound.max) && bound.max.length === 3;
};

const toSsogBound = (value: unknown): SsogBound | undefined => {
  if (!isSsogBound(value)) {
    return undefined;
  }

  return {
    min: value.min.map(Number) as [number, number, number],
    max: value.max.map(Number) as [number, number, number],
  };
};

const collectSsogEntries = (
  node: unknown,
  entries: SsogChunkEntry[] = [],
  state = { nextNodeId: 0, parentNodeId: undefined as number | undefined, depth: 0 },
): SsogChunkEntry[] => {
  if (!node || typeof node !== "object") {
    return entries;
  }

  const record = node as Record<string, unknown>;
  const nodeId = state.nextNodeId++;
  const parentNodeId = state.parentNodeId;
  const depth = state.depth;
  const bound = toSsogBound(record.bound);
  const lods = record.lods;
  if (lods && typeof lods === "object" && bound) {
    Object.entries(lods as Record<string, unknown>).forEach(([lodKey, value]) => {
      if (!value || typeof value !== "object") {
        return;
      }

      const item = value as Record<string, unknown>;
      const fileIndex = Number(item.file);
      const offset = Number(item.offset);
      const count = Number(item.count);
      const lod = Number(lodKey);
      if (
        Number.isInteger(fileIndex) &&
        Number.isFinite(offset) &&
        Number.isFinite(count) &&
        Number.isFinite(lod) &&
        count > 0
      ) {
        entries.push({ nodeId, parentNodeId, depth, fileIndex, lod, offset, count, bound });
      }
    });
  }

  for (const value of Object.values(record)) {
    const childState = { nextNodeId: state.nextNodeId, parentNodeId: nodeId, depth: depth + 1 };
    if (Array.isArray(value)) {
      value.forEach((child) => {
        collectSsogEntries(child, entries, childState);
        state.nextNodeId = childState.nextNodeId;
      });
    } else if (value && typeof value === "object" && value !== lods) {
      collectSsogEntries(value, entries, childState);
      state.nextNodeId = childState.nextNodeId;
    }
  }

  return entries;
};

const loadPackedSsogAsset = async (
  filename: string,
  fileSystem: ReadFileSystem,
): Promise<SplatAsset> => {
  const metadata = JSON.parse(new TextDecoder().decode(await readBytes(fileSystem, filename))) as SsogMetadata;
  const backingStore = new SogDecodedBackingStore();
  const entries = collectSsogEntries(metadata.tree)
    .sort((a, b) => a.lod - b.lod || a.fileIndex - b.fileIndex || a.offset - b.offset);
  const loadChunk = async (entry: SsogChunkEntry): Promise<SsogPackedChunk> => {
    const chunkFilename = metadata.filenames[entry.fileIndex];
    if (!chunkFilename) {
      throw new Error(`SSOG chunk file index ${entry.fileIndex} is missing from lod-meta.json.`);
    }

    return {
      ...entry,
      filename: chunkFilename,
      data: await backingStore.loadRange(chunkFilename, fileSystem, {
        offset: entry.offset,
        count: entry.count,
      }),
    };
  };

  if (new URLSearchParams(window.location.search).get("ssogStreaming") === "false") {
    const maxChunks = getSsogMaxChunks();
    const chunks: SsogPackedChunk[] = [];
    for (const entry of entries.slice(0, maxChunks)) {
      chunks.push(await loadChunk(entry));
    }
    return createPackedSsogSplatAsset(filename, metadata, chunks, new Transform());
  }

  return createStreamingSsogSplatAsset(filename, metadata, entries, loadChunk, new Transform());
};

const loadSplatData = async (
  filename: string,
  fileSystem: ReadFileSystem,
  skipReorder?: boolean,
): Promise<LoadResult> => {
  const inputFormat = getInputFormat(filename);
  const lowerFilename = filename.toLowerCase();
  const isSsog = lowerFilename.endsWith("lod-meta.json");

  if (isSsog && new URLSearchParams(window.location.search).get("assetMode") !== "expanded") {
    const asset = await loadPackedSsogAsset(filename, fileSystem);
    return { transform: asset.transform, asset };
  }

  if (inputFormat === "sog" && (lowerFilename.endsWith(".sog") || lowerFilename.endsWith("meta.json"))) {
    if (new URLSearchParams(window.location.search).get("assetMode") !== "expanded") {
      const packedData = await loadPackedSogData(filename, fileSystem);
      const asset = createPackedSogSplatAsset(filename, packedData, new Transform());
      return { transform: asset.transform, asset };
    }

    const source = lowerFilename.endsWith(".sog") ? await fileSystem.createSource(filename) : undefined;
    const sogFs = source ? new ZipReadFileSystem(source) : fileSystem;
    try {
      const tables = await readFile({
        filename: source ? "meta.json" : filename,
        inputFormat: "sog",
        options: defaultOptions,
        params: [],
        fileSystem: sogFs,
      });
      const splatData = dataTableToSplatData(tables[0]);
      return {
        splatData,
        transform: tables[0].transform,
        asset: createSogSplatAsset(filename, splatData, tables[0].transform),
      };
    } finally {
      if (sogFs instanceof ZipReadFileSystem) {
        sogFs.close();
      }
    }
  }

  const tables = await readFile({
    filename,
    inputFormat,
    options: defaultOptions,
    params: [],
    fileSystem,
  });

  const isCompressedPly = lowerFilename.endsWith(".compressed.ply");
  if (inputFormat !== "sog" && !isCompressedPly && !skipReorder) {
    const indices = new Uint32Array(tables[0].numRows);
    for (let i = 0; i < indices.length; i++) {
      indices[i] = i;
    }
    sortMortonOrder(tables[0], indices);
    tables[0].permuteRowsInPlace(indices);
  }

  const splatData = dataTableToSplatData(tables[0]);
  const asset =
    inputFormat === "sog"
      ? isSsog
        ? createSsogSplatAsset(filename, splatData, tables[0].transform)
        : createSogSplatAsset(filename, splatData, tables[0].transform)
      : createExpandedSplatAsset(filename, inputFormat, splatData, tables[0].transform);

  return { splatData, transform: tables[0].transform, asset };
};

const validateSplatData = (splatData: SplatData): void => {
  const required = [
    "x",
    "y",
    "z",
    "scale_0",
    "scale_1",
    "scale_2",
    "rot_0",
    "rot_1",
    "rot_2",
    "rot_3",
    "f_dc_0",
    "f_dc_1",
    "f_dc_2",
    "opacity",
  ];

  const missing = required.filter((x) => !splatData.getProp(x));
  if (missing.length > 0) {
    throw new Error(
      `This file does not contain gaussian splatting data. The following properties are missing: ${missing.join(", ")}`,
    );
  }
};

export { loadSplatData, validateSplatData };
