import { StorageBuffer } from "@babylonjs/core/Buffers/storageBuffer";
import { ComputeShader } from "@babylonjs/core/Compute/computeShader";
import { Constants } from "@babylonjs/core/Engines/constants";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader";
import { Vector2, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { Scene } from "@babylonjs/core/scene";

import type { SogPackedData } from "../splat/SplatAsset";
import { ComputeTileDepthRangePass, type ComputeTileDepthRangeStats } from "./ComputeTileDepthRangePass";
import { ComputeTileOrderPass, type ComputeTileOrderStats } from "./ComputeTileOrderPass";
import { ComputeTileSplatPreviewPass, type ComputeTileSplatPreviewStats } from "./ComputeTileSplatPreviewPass";
import { ColorSegmentationPass } from "./ColorSegmentationPass";
import { ComputeTileStatsPass, type ComputeTileStats } from "./ComputeTileStatsPass";
import { ComputeTileWorkQueuePass, type ComputeTileWorkQueueStats } from "./ComputeTileWorkQueuePass";
import { canCreateComputeShader, GpuDepthKeyPass, type GpuDepthKeyStats } from "./GpuDepthKeyPass";
import { GpuRadixSortPass, type GpuRadixSortStats } from "./GpuRadixSortPass";
import { getRequestedRendererMode, type EffectiveRendererMode, type RequestedRendererMode } from "./renderControls";

type SsogGlobalPackedChunk = {
  key: string;
  data: SogPackedData;
};

type InitialSortView = {
  cameraPosition: Vector3;
  cameraForward: Vector3;
};

type GlobalPackedShChunk = {
  splatOffset: number;
  data: SogPackedData;
};

type GlobalPackedShStats = {
  colorMode: "dc" | "sh";
  shNFileCount: number;
  shNCodebookLength: number;
  shBands: number;
  shCoeffCount: number;
  shPaletteCount: number;
  shRenderMode: "dc" | "loaded" | "cpu";
};

type SsogGlobalPackedStats = {
  renderSplats: number;
  chunkCount: number;
  activeChunks: number;
  selectedLods: number;
  rendererMode: string;
  rendererRequested: RequestedRendererMode;
  rendererEffective: EffectiveRendererMode;
  rendererFallbackReason: string;
  computeRendererEnabled: boolean;
  computeRendererPhase: string;
  computeRendererVisibility: string;
  colorMode: "dc" | "sh";
  shNFileCount: number;
  shNCodebookLength: number;
  shBands: number;
  shCoeffCount: number;
  shPaletteCount: number;
  shRenderMode: "dc" | "loaded" | "cpu";
  computeTileStatsEnabled: boolean;
  computeTileStatsDispatched: boolean;
  computeTileSize: number;
  computeTileCount: number;
  computeTileCols: number;
  computeTileRows: number;
  computeOccupiedTiles: number;
  computeMaxTileOccupancy: number;
  computeTileOccupancy?: Uint32Array;
  computeVisibleSplats: number;
  computeBehindSplats: number;
  computeClippedSplats: number;
  computeOverflowSplats: number;
  computeTileOffsetsDispatched: boolean;
  computeTileListScatterDispatched: boolean;
  computeTileListValidated: boolean;
  computeTileListEntries: number;
  computeTileListCapacity: number;
  computeTileOffsetEntries: number;
  computeTileCursorEntries: number;
  computeTileListMismatchedTiles: number;
  lastComputeTileStatsMs: number;
  lastComputeTileOffsetMs: number;
  lastComputeTileListScatterMs: number;
  computeTileDepthEnabled: boolean;
  computeTileDepthDispatched: boolean;
  computeTileDepthTiles: number;
  computeTileDepthMin: number;
  computeTileDepthMax: number;
  computeTileDepthMaxSpan: number;
  computeTileDepthAvgSpan: number;
  computeTileDepthSpans?: Float32Array;
  lastComputeTileDepthMs: number;
  computeTileWorkQueueEnabled: boolean;
  computeTileWorkQueueDispatched: boolean;
  computeTileWorkQueueOrderMode: "compact" | "depth-band";
  computeTileWorkQueueDepthBands: number;
  computeTileWorkQueueStableOrder: boolean;
  computeTileWorkQueueMaxSplatsPerItemConfig: number;
  computeTileWorkQueueBudget: number;
  computeTileWorkQueueBudgetCap: number;
  computeTileWorkQueueCoverageTarget: number;
  computeTileWorkQueueExplicitBudget: boolean;
  computeTileWorkQueueTiles: number;
  computeTileWorkQueueSplats: number;
  computeTileWorkQueueMaxTileSplats: number;
  computeTileWorkQueueAvgTileSplats: number;
  computeTileWorkQueueOverflowTiles: number;
  lastComputeTileWorkQueueMs: number;
  computeTileOrderEnabled: boolean;
  computeTileOrderDispatched: boolean;
  computeTileOrderBuckets: number;
  computeTileOrderTiles: number;
  computeTileOrderTrackedTiles: number;
  computeTileOrderSplats: number;
  computeTileOrderTruncatedSplats: number;
  computeTileOrderOverflowSplats: number;
  computeTileOrderOverflowTiles: number;
  lastComputeTileOrderMs: number;
  computeTileSplatPreviewEnabled: boolean;
  computeTileSplatPreviewSamplesPerTile: number;
  computeTileSplatPreviewSplats: number;
  computeTileSplatPreviewActiveTiles: number;
  computeTileSplatPreviewWorkTiles: number;
  computeTileSplatPreviewColorMode: "asset" | "debug" | "opacity" | "depth";
  computeTileSplatPreviewShapeMode: "gaussian" | "marker";
  computeTileRasterPreviewEnabled: boolean;
  computeTileRasterPreviewSamplesPerTile: number;
  computeTileRasterPreviewSplats: number;
  computeTileRasterPreviewWindowSplats: number;
  computeTileRasterPreviewSampledCoverage: number;
  computeTileRasterPreviewWindowCoverage: number;
  computeTileRasterPreviewActiveTiles: number;
  computeTileRasterPreviewWorkTiles: number;
  computeTileRasterPreviewDrawLimit: number;
  computeTileRasterPreviewRequestedDrawLimit: number;
  computeTileRasterPreviewStaticDrawLimit: number;
  computeTileRasterPreviewMotionDrawLimit: number;
  computeTileRasterPreviewAdaptiveScale: number;
  computeTileRasterPreviewFrameMs: number;
  computeTileRasterPreviewMaxMarkerPixels: number;
  computeTileRasterPreviewStaticRamp: number;
  computeTileRasterPreviewColorMode: "asset" | "debug" | "opacity" | "depth";
  computeTileRasterPreviewShapeMode: "gaussian" | "marker";
  computeTileRasterPreviewDrawOrder: "coverage" | "far" | "near";
  computeTileRasterPreviewWindowMode: "sampled" | "full";
  computeTileRasterPreviewCoverageMode: "sampled" | "full";
  computeTileRasterPreviewTruncatedSplats: number;
  computeTileRasterPreviewNearWindowMargin: number;
  computeTileRasterPreviewSampleAlphaCompensation: number;
  computeTileRasterPreviewRuntimeSampleAlphaCompensation: number;
  computeTileRasterPreviewSamplePasses: number;
  computeTileRasterPreviewMaxUsefulSamplePasses: number;
  computeTileRasterPreviewStaticSamplePasses: number;
  computeTileRasterPreviewMotionSamplePasses: number;
  computeTileRasterPreviewSampleCoverageTarget: number;
  computeTileRasterPreviewMotionSampleCoverageTarget: number;
  computeTileRasterPreviewRuntimeSampleCoverageTarget: number;
  computeTileRasterPreviewSamplePassesAdaptive: boolean;
  computeTileRasterPreviewDrawCoverageTarget: number;
  computeTileRasterPreviewMotionDrawCoverageTarget: number;
  computeTileRasterPreviewRuntimeDrawCoverageTarget: number;
  computeTileRasterPreviewDrawCoverageAdaptive: boolean;
  computeTileUpdateInterval: number;
  sortMode: "auto";
  sortPending: boolean;
  lastSortMs: number;
  lastUploadMs: number;
  lastLodBuildMs: number;
  gpuDepthKeyEnabled: boolean;
  gpuDepthKeyDispatched: boolean;
  lastGpuDepthKeyMs: number;
  lastGpuDepthKeySplats: number;
  gpuSortHistogramEnabled: false;
  gpuSortHistogramDispatched: false;
  lastGpuSortHistogramMs: number;
  lastGpuSortHistogramSplats: number;
  gpuSortHistogramBuckets: number;
  gpuSortPrefixSumEnabled: false;
  gpuSortPrefixSumDispatched: false;
  lastGpuSortPrefixSumMs: number;
  gpuSortPrefixSumBuckets: number;
  gpuSortMode: "off" | "active";
  gpuSortScatterEnabled: boolean;
  gpuSortScatterDispatched: boolean;
  lastGpuSortScatterMs: number;
  lastGpuSortScatterSplats: number;
  gpuRadixSortEnabled: boolean;
  gpuRadixSortDispatched: boolean;
  lastGpuRadixSortMs: number;
  lastGpuRadixSortSplats: number;
  gpuRadixSortBits: number;
  gpuRadixSortPasses: number;
  gpuSortVisibleMode: "cpu" | "auto" | "radix";
  gpuSortVisibleEffective: "cpu" | "radix";
  gpuRadixValidationEnabled: boolean;
  gpuRadixValidationPending: boolean;
  gpuRadixValidationSamples: number;
  gpuRadixAscendingViolations: number;
  gpuRadixDescendingViolations: number;
  gpuRadixOutOfRangeIndices: number;
  gpuRadixDuplicateAdjacentIndices: number;
  gpuRadixChecksumValid: boolean;
  gpuRadixValidatedIndexCount: number;
  gpuBufferArenaBuffers: number;
  gpuBufferArenaBytes: number;
  gpuBufferArenaPeakBytes: number;
  gpuBufferArenaAllocations: number;
  gpuBufferArenaReuses: number;
  gpuBufferArenaGrows: number;
};

const SPLATS_PER_INSTANCE = 128;
const MIN_PIXEL_RADIUS = 2.0;
const MAX_PIXEL_RADIUS = 96;
const ALPHA_CLIP = 1 / 255;
const SORT_MOVE_EPSILON_SQ = 0.0001;
const SORT_FORWARD_DOT_THRESHOLD = Math.cos((0.25 * Math.PI) / 180);
const SORT_INTERVAL_FRAMES = 6;
const AUTO_GPU_SORT_SPLAT_THRESHOLD = 2_000_000;
const GPU_INDEX_GATHER_WORKGROUP_SIZE = 256;
const DEFAULT_COMPUTE_PRIMARY_MIN_COVERAGE = 0.45;
const DEFAULT_COMPUTE_PRIMARY_DROP_COVERAGE = 0.25;
const DEFAULT_COMPUTE_PRIMARY_READY_FRAMES = 12;
const DEFAULT_COMPUTE_PRIMARY_DROP_FRAMES = 1;
const DEFAULT_COMPUTE_PRIMARY_MIN_ADAPTIVE_SCALE = 0.75;
const DEFAULT_COMPUTE_PRIMARY_MAX_FRAME_MS = 40;

const getSsogComputeTileUpdateInterval = (): number => {
  const params = new URLSearchParams(window.location.search);
  const explicit = Number(params.get("computeTileUpdateInterval"));
  if (Number.isFinite(explicit) && explicit > 0) {
    return Math.max(1, Math.floor(explicit));
  }
  if (
    getRequestedRendererMode() === "compute" ||
    params.get("computeTileRasterPreview") === "true" ||
    params.get("computeTileDepthOverlay") === "true" ||
    params.get("computeTileOverlay") === "true"
  ) {
    return 4;
  }
  return 1;
};

const getSsogComputePrimaryCoverageThreshold = (name: string, fallback: number): number => {
  const value = Number(new URLSearchParams(window.location.search).get(name));
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback;
};

const getSsogComputePrimaryFrameThreshold = (name: string, fallback: number): number => {
  const value = Number(new URLSearchParams(window.location.search).get(name));
  return Number.isFinite(value) && value > 0 ? Math.max(1, Math.floor(value)) : fallback;
};

const getSsogComputePrimaryFrameBudget = (name: string, fallback: number): number => {
  const value = Number(new URLSearchParams(window.location.search).get(name));
  return Number.isFinite(value) && value > 0 ? Math.max(8, value) : fallback;
};

const getCpuShIntervalFrames = (): number => {
  const value = Number(new URLSearchParams(window.location.search).get("sogShInterval"));
  return Number.isFinite(value) && value > 0 ? Math.max(1, Math.floor(value)) : 30;
};

const isCpuShEnabled = (): boolean => {
  const value = new URLSearchParams(window.location.search).get("sogSh");
  return value === "cpu" || value === "true";
};

const GPU_INDEX_GATHER_SOURCE = `
@group(0) @binding(0) var<storage, read> sortedOrdinals: array<u32>;
@group(0) @binding(1) var<storage, read> ordinalToPacked: array<u32>;
@group(0) @binding(2) var<storage, read_write> drawIndices: array<u32>;
@group(0) @binding(3) var<storage, read> paramsBuffer: array<u32>;

@compute @workgroup_size(${GPU_INDEX_GATHER_WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) globalId: vec3u) {
  let index = globalId.x;
  let count = paramsBuffer[0];
  if (index >= count) {
    return;
  }

  let ordinal = sortedOrdinals[index];
  if (ordinal >= count) {
    return;
  }
  drawIndices[index] = ordinalToPacked[ordinal];
}
`;

const WGSL_VERTEX_SOURCE = `
attribute position: vec3f;

uniform worldViewProjection: mat4x4f;
uniform view: mat4x4f;
uniform world: mat4x4f;
uniform projection: mat4x4f;
uniform viewport: vec2f;
uniform minPixelRadius: f32;
uniform maxPixelRadius: f32;
uniform renderSplatCount: f32;
uniform vizMode: f32;

var<storage, read> meansLBuffer: array<u32>;
var<storage, read> meansUBuffer: array<u32>;
var<storage, read> quatsBuffer: array<u32>;
var<storage, read> scalesBuffer: array<u32>;
var<storage, read> colorBuffer: array<vec4f>;
var<storage, read> colorGroupBuffer: array<u32>;
var<storage, read> scaleCodebookBuffer: array<f32>;
var<storage, read> chunkInfoBuffer: array<vec4f>;
var<storage, read> indexBuffer: array<u32>;

varying vCorner: vec2f;
varying vColor: vec4f;

#define CUSTOM_VERTEX_DEFINITIONS

const SQRT2: f32 = 1.4142135623730951;

fn chan(pixel: u32, component: u32) -> u32 {
  return (pixel >> (component * 8u)) & 255u;
}

fn chanf(pixel: u32, component: u32) -> f32 {
  return f32(chan(pixel, component));
}

fn chunkIndex(packedIndex: u32) -> u32 {
  return packedIndex >> 24u;
}

fn localIndex(packedIndex: u32) -> u32 {
  return packedIndex & 16777215u;
}

fn sourceIndex(packedIndex: u32) -> u32 {
  let chunk = chunkIndex(packedIndex);
  return u32(chunkInfoBuffer[chunk * 2u].w) + localIndex(packedIndex);
}

fn decodeCenter(packedIndex: u32) -> vec3f {
  let chunk = chunkIndex(packedIndex);
  let index = sourceIndex(packedIndex);
  let meansMin = chunkInfoBuffer[chunk * 2u].xyz;
  let meansMaxAndScaleOffset = chunkInfoBuffer[chunk * 2u + 1u];
  let meansMax = meansMaxAndScaleOffset.xyz;
  let lo = meansLBuffer[index];
  let hi = meansUBuffer[index];
  let q = vec3f(
    f32((chan(hi, 0u) << 8u) + chan(lo, 0u)) / 65535.0,
    f32((chan(hi, 1u) << 8u) + chan(lo, 1u)) / 65535.0,
    f32((chan(hi, 2u) << 8u) + chan(lo, 2u)) / 65535.0
  );
  let encoded = meansMin * (vec3f(1.0) - q) + meansMax * q;
  return sign(encoded) * (exp(abs(encoded)) - vec3f(1.0));
}

fn decodeRotation(packedIndex: u32) -> vec4f {
  let index = sourceIndex(packedIndex);
  let pixel = quatsBuffer[index];
  let a = (chanf(pixel, 0u) / 255.0 - 0.5) * SQRT2;
  let b = (chanf(pixel, 1u) / 255.0 - 0.5) * SQRT2;
  let c = (chanf(pixel, 2u) / 255.0 - 0.5) * SQRT2;
  let d = sqrt(max(0.0, 1.0 - (a * a + b * b + c * c)));
  let mode = chan(pixel, 3u) - 252u;
  if (mode == 0u) {
    return vec4f(d, a, b, c);
  }
  if (mode == 1u) {
    return vec4f(a, d, b, c);
  }
  if (mode == 2u) {
    return vec4f(a, b, d, c);
  }
  return vec4f(a, b, c, d);
}

fn decodeScale(packedIndex: u32) -> vec3f {
  let chunk = chunkIndex(packedIndex);
  let index = sourceIndex(packedIndex);
  let scaleCodebookOffset = u32(chunkInfoBuffer[chunk * 2u + 1u].w);
  let pixel = scalesBuffer[index];
  return vec3f(
    scaleCodebookBuffer[scaleCodebookOffset + chan(pixel, 0u)],
    scaleCodebookBuffer[scaleCodebookOffset + chan(pixel, 1u)],
    scaleCodebookBuffer[scaleCodebookOffset + chan(pixel, 2u)]
  );
}

fn initCornerCov(center: vec3f, rotation: vec4f, scale: vec3f, corner: vec2f, centerClip: vec4f) -> vec4f {
  let w = rotation.x;
  let x = rotation.y;
  let y = rotation.z;
  let z = rotation.w;
  let modelView = uniforms.view * uniforms.world;
  let centerView = modelView * vec4f(center, 1.0);
  if (uniforms.projection[3][3] != 1.0 && centerView.z <= 0.0) {
    return vec4f(0.0, 0.0, 2.0, 1.0);
  }
  let centerClipClamped = vec4f(centerClip.xy, clamp(centerClip.z, 0.0, abs(centerClip.w)), centerClip.w);

  let R = mat3x3f(
    vec3f(1.0 - 2.0 * (y * y + z * z), 2.0 * (x * y + w * z), 2.0 * (x * z - w * y)),
    vec3f(2.0 * (x * y - w * z), 1.0 - 2.0 * (x * x + z * z), 2.0 * (y * z + w * x)),
    vec3f(2.0 * (x * z + w * y), 2.0 * (y * z - w * x), 1.0 - 2.0 * (x * x + y * y))
  );
  let M = mat3x3f(R[0] * scale.x, R[1] * scale.y, R[2] * scale.z);
  let Vrk = M * transpose(M);
  let W = transpose(mat3x3f(modelView[0].xyz, modelView[1].xyz, modelView[2].xyz));
  let focal = uniforms.viewport.x * uniforms.projection[0][0];
  let v = centerView.xyz / centerView.w;
  let J1 = focal / v.z;
  let J2 = -J1 / v.z * v.xy;
  let J = mat3x3f(vec3f(J1, 0.0, J2.x), vec3f(0.0, J1, J2.y), vec3f(0.0, 0.0, 0.0));
  let T = W * J;
  let cov = transpose(T) * Vrk * T;
  let diagonal1 = cov[0][0] + 0.3;
  let offDiagonal = cov[0][1];
  let diagonal2 = cov[1][1] + 0.3;
  let mid = 0.5 * (diagonal1 + diagonal2);
  let radius = length(vec2f((diagonal1 - diagonal2) / 2.0, offDiagonal));
  let lambda1 = mid + radius;
  let lambda2 = max(mid - radius, 0.1);
  let vmin = min(1024.0, min(uniforms.viewport.x, uniforms.viewport.y));
  let l1 = 2.0 * min(sqrt(2.0 * lambda1), vmin);
  let l2 = 2.0 * min(sqrt(2.0 * lambda2), vmin);
  let maxL = max(l1, l2);
  if (maxL < uniforms.minPixelRadius) {
    return vec4f(0.0, 0.0, 2.0, 1.0);
  }
  if (any(abs(centerClipClamped.xy) - vec2f(maxL, maxL) * centerClipClamped.w / uniforms.viewport > vec2f(centerClipClamped.w))) {
    return vec4f(0.0, 0.0, 2.0, 1.0);
  }
  let c = centerClipClamped.w / uniforms.viewport;
  let diagonalVector = normalize(vec2f(offDiagonal, lambda1 - diagonal1));
  let v1 = l1 * diagonalVector;
  let v2 = l2 * vec2f(diagonalVector.y, -diagonalVector.x);
  let offset = (corner.x * v1 + corner.y * v2) * c;
  return vec4f(centerClipClamped.xy + offset, centerClipClamped.zw);
}

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
  let sourceOrder = vertexInputs.instanceIndex * 128u + u32(vertexInputs.position.z);
  if (f32(sourceOrder) >= uniforms.renderSplatCount) {
    vertexOutputs.position = vec4f(0.0, 0.0, 2.0, 1.0);
    vertexOutputs.vCorner = vec2f(2.0, 2.0);
    vertexOutputs.vColor = vec4f(0.0);
    return vertexOutputs;
  }
  let corner = vertexInputs.position.xy;
  let packedSplatIndex = indexBuffer[sourceOrder];
  let splatIndex = sourceIndex(packedSplatIndex);
  let center = decodeCenter(packedSplatIndex);
  let rotation = normalize(decodeRotation(packedSplatIndex));
  let logScale = decodeScale(packedSplatIndex);
  let centerClip = uniforms.worldViewProjection * vec4f(center, 1.0);

  if (uniforms.vizMode >= 1.0) {
    let pixelRadius = 2.0;
    let clipOffset = corner * pixelRadius * 2.0 / uniforms.viewport * centerClip.w;
    vertexOutputs.position = vec4f(centerClip.xy + clipOffset, centerClip.zw);
    vertexOutputs.vCorner = corner;
    if (uniforms.vizMode == 2.0) {
      let chunkId = f32(chunkIndex(packedSplatIndex));
      let rng = vec3f(
        fract(sin(chunkId * 12.9898 + 1.0) * 43758.5453),
        fract(sin(chunkId * 78.233 + 2.0) * 43758.5453),
        fract(sin(chunkId * 45.164 + 3.0) * 43758.5453),
      );
      vertexOutputs.vColor = vec4f(rng, 1.0);
    } else if (uniforms.vizMode == 3.0) {
      let groupId = f32(colorGroupBuffer[splatIndex]);
      let palette = vec3f(
        fract(sin(groupId * 12.9898 + 1.0) * 43758.5453),
        fract(sin(groupId * 78.233 + 2.0) * 43758.5453),
        fract(sin(groupId * 45.164 + 3.0) * 43758.5453),
      );
      vertexOutputs.vColor = vec4f(palette, 1.0);
    } else {
      vertexOutputs.vColor = colorBuffer[splatIndex];
    }
    return vertexOutputs;
  }

  vertexOutputs.position = initCornerCov(center, rotation, exp(logScale), corner, centerClip);
  vertexOutputs.vCorner = corner;
  vertexOutputs.vColor = colorBuffer[splatIndex];
}
`;

const WGSL_FRAGMENT_SOURCE = `
varying vCorner: vec2f;
varying vColor: vec4f;

uniform vizMode: f32;

const EXP4: f32 = 0.01831563888873418;
const INV_ONE_MINUS_EXP4: f32 = 1.018657360363774;

#define CUSTOM_FRAGMENT_DEFINITIONS

fn normExp(x: f32) -> f32 {
  return (exp(-4.0 * x) - EXP4) * INV_ONE_MINUS_EXP4;
}

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  let radius2 = dot(input.vCorner, input.vCorner);
  if (radius2 > 1.0) {
    discard;
  }
  let splatAlpha = clamp(input.vColor.a, 0.0, 1.0);
  let effectiveAlpha = select(splatAlpha, 1.0, uniforms.vizMode == 1.0);
  let alpha = normExp(radius2) * effectiveAlpha;
  if (alpha < ${ALPHA_CLIP.toFixed(10)}) {
    discard;
  }
  fragmentOutputs.color = vec4f(max(input.vColor.rgb, vec3f(0.0)) * alpha, alpha);
}
`;

class SsogGlobalPackedRenderPass {
  private readonly mesh: Mesh;
  private readonly material: ShaderMaterial;
  private readonly buffers: {
    meansL: StorageBuffer;
    meansU: StorageBuffer;
    quats: StorageBuffer;
    scales: StorageBuffer;
    color: StorageBuffer;
    scaleCodebook: StorageBuffer;
    chunkInfo: StorageBuffer;
    indices: StorageBuffer;
    centers?: StorageBuffer;
    depthKeys?: StorageBuffer;
    gpuSortIndices?: StorageBuffer;
    ordinalToPacked?: StorageBuffer;
    colorGroup?: StorageBuffer;
  };
  private readonly indices: Uint32Array;
  private readonly colorData: Float32Array;
  private readonly dcColorData: Float32Array;
  private readonly shChunks: GlobalPackedShChunk[];
  private readonly shStats: GlobalPackedShStats;
  private readonly updateViewport: () => void;
  private readonly viewport = new Vector2(1, 1);
  private sortWorker?: Worker;
  private sortPending = false;
  private sortFrame = 0;
  private enabled = true;
  private disposed = false;
  private lastCameraPosition = new Vector3(Number.POSITIVE_INFINITY, 0, 0);
  private lastCameraForward = new Vector3(0, 0, 0);
  private lastSortStart = 0;
  private lastSortMs = 0;
  private lastUploadMs = 0;
  private lastGpuGatherMs = 0;
  private gpuSortFrame = 0;
  private gpuVisibleActive = false;
  private gpuGatheredCurrentSort = false;
  private computePreviewDrawableFrames = 0;
  private computePreviewLowCoverageFrames = 0;
  private computeTileRasterPrimaryActive = false;
  private computeTileRasterPrimaryFallbackReason = "";
  private computeTileFrame = 0;
  private cpuShFrame = 0;
  private lastCpuShMs = 0;
  private readonly computeTileUpdateInterval = getSsogComputeTileUpdateInterval();
  private readonly computePrimaryMinCoverage = getSsogComputePrimaryCoverageThreshold(
    "computeTileRasterPrimaryMinCoverage",
    DEFAULT_COMPUTE_PRIMARY_MIN_COVERAGE,
  );
  private readonly computePrimaryDropCoverage = getSsogComputePrimaryCoverageThreshold(
    "computeTileRasterPrimaryDropCoverage",
    DEFAULT_COMPUTE_PRIMARY_DROP_COVERAGE,
  );
  private readonly computePrimaryReadyFrames = getSsogComputePrimaryFrameThreshold(
    "computeTileRasterPrimaryReadyFrames",
    DEFAULT_COMPUTE_PRIMARY_READY_FRAMES,
  );
  private readonly computePrimaryDropFrames = getSsogComputePrimaryFrameThreshold(
    "computeTileRasterPrimaryDropFrames",
    DEFAULT_COMPUTE_PRIMARY_DROP_FRAMES,
  );
  private readonly computePrimaryMinAdaptiveScale = getSsogComputePrimaryCoverageThreshold(
    "computeTileRasterPrimaryMinAdaptiveScale",
    DEFAULT_COMPUTE_PRIMARY_MIN_ADAPTIVE_SCALE,
  );
  private readonly computePrimaryMaxFrameMs = getSsogComputePrimaryFrameBudget(
    "computeTileRasterPrimaryMaxFrameMs",
    DEFAULT_COMPUTE_PRIMARY_MAX_FRAME_MS,
  );
  private readonly gpuSortVisibleMode: "cpu" | "auto" | "radix";
  private readonly rendererBackend: {
    requested: RequestedRendererMode;
    effective: EffectiveRendererMode;
    fallbackReason: string;
  };
  private readonly gpuDepthKeyPass?: GpuDepthKeyPass;
  private readonly gpuRadixSortPass?: GpuRadixSortPass;
  private readonly gpuIndexGatherPass?: SsogGlobalPackedIndexGatherPass;
  private readonly cpuSortWorkerEnabled: boolean;
  private readonly colorSegmentationPass?: ColorSegmentationPass;
  private readonly computeTileStatsPass?: ComputeTileStatsPass;
  private readonly computeTileDepthRangePass?: ComputeTileDepthRangePass;
  private readonly computeTileWorkQueuePass?: ComputeTileWorkQueuePass;
  private readonly computeTileOrderPass?: ComputeTileOrderPass;
  private readonly computeTileRasterPreviewPass?: ComputeTileSplatPreviewPass;
  private readonly computeTileRasterPreviewOnly = isSsogComputeTileRasterPreviewOnlyEnabled();
  private readonly computeTileRasterStrictPreviewOnly = isSsogComputeTileRasterStrictPreviewOnlyEnabled();
  private readonly computeTileRasterPrimaryAllowed = isSsogComputeTileRasterPrimaryEnabled();
  private readonly cpuShEnabled = isCpuShEnabled();
  private readonly cpuShIntervalFrames = getCpuShIntervalFrames();

  readonly signature: string;
  readonly keys: Set<string>;
  readonly numSplats: number;
  readonly chunkCount: number;

  constructor(private readonly scene: Scene, chunks: SsogGlobalPackedChunk[], initialSortView?: InitialSortView) {
    const engine = scene.getEngine();
    if (!(engine instanceof WebGPUEngine)) {
      throw new Error("Global packed SSOG rendering requires Babylon WebGPU storage buffers.");
    }

    this.signature = chunks.map((chunk) => chunk.key).sort().join("|");
    this.keys = new Set(chunks.map((chunk) => chunk.key));
    this.chunkCount = chunks.length;
    this.numSplats = chunks.reduce((sum, chunk) => sum + chunk.data.numSplats, 0);
    this.rendererBackend = resolveSsogGlobalPackedRendererBackend();
    this.gpuSortVisibleMode = getSsogGpuSortVisibleMode(this.rendererBackend.requested, this.numSplats);
    this.cpuSortWorkerEnabled = this.gpuSortVisibleMode !== "radix" || !isSsogGpuSortForceVisible();

    const packed = buildGlobalPackedArrays(chunks, initialSortView);
    this.colorData = packed.color;
    this.dcColorData = packed.dcColor;
    this.shChunks = packed.shChunks;
    this.shStats = packed.shStats;
    this.indices = new Uint32Array(this.numSplats);
    for (let i = 0; i < this.indices.length; i++) {
      this.indices[i] = packed.initialDrawIndices[i];
    }

    this.mesh = new Mesh("SsogGlobalPackedRenderPassQuads", scene);
    this.mesh.isPickable = false;
    this.mesh.hasVertexAlpha = true;
    this.material = this.createMaterial(scene);
    this.mesh.material = this.material;
    this.buffers = {
      meansL: createStorageBuffer(engine, "SsogGlobalMeansL", packed.meansL),
      meansU: createStorageBuffer(engine, "SsogGlobalMeansU", packed.meansU),
      quats: createStorageBuffer(engine, "SsogGlobalQuats", packed.quats),
      scales: createStorageBuffer(engine, "SsogGlobalScales", packed.scales),
      color: createStorageBuffer(engine, "SsogGlobalColor", packed.color),
      scaleCodebook: createStorageBuffer(engine, "SsogGlobalScaleCodebook", packed.scaleCodebook),
      chunkInfo: createStorageBuffer(engine, "SsogGlobalChunkInfo", packed.chunkInfo),
      indices: createStorageBuffer(engine, "SsogGlobalIndices", this.indices),
      ...((isSsogGpuSortShadowEnabled(this.rendererBackend.requested, this.numSplats) ||
        isSsogComputeTileStatsEnabled(this.rendererBackend.requested) ||
        isSsogComputeTileOrderEnabled(this.rendererBackend.requested)) &&
      canCreateComputeShader(scene)
        ? {
            centers: createStorageBuffer(engine, "SsogGlobalCenters", packed.centerScale),
            depthKeys: createStorageBuffer(engine, "SsogGlobalDepthKeys", new Uint32Array(this.numSplats)),
            gpuSortIndices: createStorageBuffer(engine, "SsogGlobalGpuSortIndices", new Uint32Array(this.numSplats)),
            ordinalToPacked: createStorageBuffer(engine, "SsogGlobalOrdinalToPacked", packed.globalIndices),
          }
        : {}),
    };
    if (this.buffers.centers && this.buffers.depthKeys && this.buffers.gpuSortIndices) {
      this.gpuDepthKeyPass = new GpuDepthKeyPass(
        scene,
        this.buffers.centers,
        this.buffers.depthKeys,
        this.numSplats,
        packed.boundsMin,
        packed.boundsMax,
      );
      this.gpuRadixSortPass = new GpuRadixSortPass(
        scene,
        this.buffers.depthKeys,
        this.buffers.gpuSortIndices,
        this.numSplats,
        undefined,
        !isSsogGpuSortForceVisible(),
      );
      if (this.gpuSortVisibleMode !== "cpu" && this.buffers.ordinalToPacked) {
        this.gpuIndexGatherPass = new SsogGlobalPackedIndexGatherPass(
          scene,
          this.buffers.gpuSortIndices,
          this.buffers.ordinalToPacked,
          this.buffers.indices,
          this.numSplats,
        );
        }
    }
    if (this.buffers.centers && isSsogComputeTileStatsEnabled(this.rendererBackend.requested)) {
      this.computeTileStatsPass = new ComputeTileStatsPass(scene, this.buffers.centers, this.numSplats);
      if (isSsogComputeTileDepthEnabled(this.rendererBackend.requested)) {
        this.computeTileDepthRangePass = new ComputeTileDepthRangePass(
          scene,
          this.buffers.centers,
          this.computeTileStatsPass,
          this.numSplats,
        );
      }
      if (this.computeTileDepthRangePass && isSsogComputeTileWorkQueueEnabled(this.rendererBackend.requested)) {
        this.computeTileWorkQueuePass = new ComputeTileWorkQueuePass(
          scene,
          this.computeTileStatsPass,
          this.computeTileDepthRangePass,
        );
      }
      if (isSsogComputeTileOrderEnabled(this.rendererBackend.requested)) {
        this.computeTileOrderPass = new ComputeTileOrderPass(
          scene,
          this.buffers.centers,
          this.computeTileStatsPass,
          this.numSplats,
          this.buffers.ordinalToPacked,
        );
      }
      if (
        this.computeTileWorkQueuePass &&
        this.computeTileOrderPass &&
        this.buffers.ordinalToPacked &&
        isSsogComputeTileRasterPreviewEnabled(this.rendererBackend.requested)
      ) {
        const params = new URLSearchParams(window.location.search);
        this.computeTileRasterPreviewPass = new ComputeTileSplatPreviewPass(
          scene,
          {
            centerBuffer: this.buffers.centers,
            tileSplatListBuffer: this.computeTileOrderPass.getOrderedTileSplatListBuffer(),
            sogChunkInfoBuffer: this.buffers.chunkInfo,
            sogQuatBuffer: this.buffers.quats,
            colorBuffer: this.buffers.color,
            sogScalesBuffer: this.buffers.scales,
            sogScaleCodebookBuffer: this.buffers.scaleCodebook,
            coverageMode: "bounded",
            shapeMode: params.get("computeTileRasterShape") === "marker" ? "marker" : "gaussian",
            alphaMode: "splat",
            splatRadiusScale: 2.0,
            maxMarkerPixels: 96.0,
          },
          this.computeTileStatsPass,
          this.computeTileWorkQueuePass,
        );
      }
    }
    this.colorSegmentationPass = this.createColorSegmentationPass(scene);
    this.buildGeometry();
    this.bindStorageBuffers();
    this.setRenderCount(this.numSplats);
    this.mesh.setEnabled(!(this.computeTileRasterStrictPreviewOnly && this.computeTileRasterPreviewPass));
    if (!(this.computeTileRasterStrictPreviewOnly && this.computeTileRasterPreviewPass) && this.cpuSortWorkerEnabled) {
      this.initializeSortWorker(packed.centers, packed.globalIndices);
    }

    this.updateViewport = () => {
      const renderEngine = scene.getEngine();
      this.viewport.set(renderEngine.getRenderWidth(true), renderEngine.getRenderHeight(true));
      this.material.setVector2("viewport", this.viewport);
      this.updateComputeTilePipeline();
      this.updateSort();
    };
    scene.registerBeforeRender(this.updateViewport);
    this.updateViewport();
  }

  dispose(): void {
    this.disposed = true;
    this.sortWorker?.terminate();
    this.gpuDepthKeyPass?.dispose();
    this.gpuRadixSortPass?.dispose();
    this.gpuIndexGatherPass?.dispose();
    this.computeTileStatsPass?.dispose();
    this.computeTileDepthRangePass?.dispose();
    this.computeTileWorkQueuePass?.dispose();
    this.computeTileOrderPass?.dispose();
    this.computeTileRasterPreviewPass?.dispose();
    this.colorSegmentationPass?.dispose();
    this.scene.unregisterBeforeRender(this.updateViewport);
    Object.values(this.buffers).forEach((buffer) => buffer.dispose());
    this.mesh.dispose();
    this.material.dispose();
  }

  private createColorSegmentationPass(scene: Scene): ColorSegmentationPass | undefined {
    if (!canCreateComputeShader(scene) || !this.buffers.color) {
      return undefined;
    }
    const pass = new ColorSegmentationPass(scene, this.buffers.color, this.numSplats);
    pass.dispatch();
    return pass;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.mesh.setEnabled(enabled && !(this.computeTileRasterStrictPreviewOnly && this.computeTileRasterPreviewPass));
    this.computeTileRasterPreviewPass?.setEnabled(enabled);
  }

  getStats(): SsogGlobalPackedStats {
    return {
      renderSplats: this.numSplats,
      chunkCount: this.chunkCount,
      activeChunks: this.chunkCount,
      selectedLods: this.chunkCount,
      rendererMode:
        this.computeTileRasterStrictPreviewOnly && this.computeTileRasterPreviewPass
          ? "ssog-global-packed-compute-preview-strict"
          : this.isComputeTileRasterPrimaryActive()
            ? "ssog-global-packed-compute-tile-raster-primary"
          : `ssog-global-packed-raster-sort-${this.gpuVisibleActive ? "gpu-radix" : "cpu-worker"}`,
      rendererRequested: this.rendererBackend.requested,
      rendererEffective: this.isComputeTileRasterPrimaryActive()
        ? "compute"
        : this.gpuVisibleActive
          ? "gpu"
          : this.rendererBackend.effective,
      rendererFallbackReason: this.getRendererFallbackReason(),
      computeRendererEnabled: this.rendererBackend.requested === "compute",
      computeRendererPhase: this.getComputeRendererPhase(),
      computeRendererVisibility: this.getComputeRendererVisibility(),
      colorMode: this.shStats.colorMode,
      shNFileCount: this.shStats.shNFileCount,
      shNCodebookLength: this.shStats.shNCodebookLength,
      shBands: this.shStats.shBands,
      shCoeffCount: this.shStats.shCoeffCount,
      shPaletteCount: this.shStats.shPaletteCount,
      shRenderMode: this.shStats.shRenderMode,
      ...this.getComputeTileStats(),
      ...this.getComputeTileSplatPreviewStats(),
      ...this.getComputeTileRasterPreviewStats(),
      computeTileUpdateInterval: this.computeTileUpdateInterval,
      sortMode: "auto",
      sortPending: this.sortPending,
      lastSortMs: this.lastSortMs,
      lastUploadMs: this.lastUploadMs,
      lastLodBuildMs: 0,
      ...this.getGpuDepthKeyStats(),
      gpuSortHistogramEnabled: false,
      gpuSortHistogramDispatched: false,
      lastGpuSortHistogramMs: 0,
      lastGpuSortHistogramSplats: 0,
      gpuSortHistogramBuckets: 0,
      gpuSortPrefixSumEnabled: false,
      gpuSortPrefixSumDispatched: false,
      lastGpuSortPrefixSumMs: 0,
      gpuSortPrefixSumBuckets: 0,
      gpuSortMode: this.gpuRadixSortPass ? "active" : "off",
      gpuSortScatterEnabled: !!this.gpuIndexGatherPass,
      gpuSortScatterDispatched: this.gpuGatheredCurrentSort,
      lastGpuSortScatterMs: this.lastGpuGatherMs,
      lastGpuSortScatterSplats: this.gpuGatheredCurrentSort ? this.numSplats : 0,
      ...this.getGpuRadixSortStats(),
      gpuSortVisibleMode: this.gpuSortVisibleMode,
      gpuSortVisibleEffective: this.gpuVisibleActive ? "radix" : "cpu",
    };
  }

  private getRendererFallbackReason(): string {
    if (this.isComputeTileRasterPrimaryActive()) {
      return "";
    }
    if (this.isComputeTileRasterPrimaryMode()) {
      return this.computeTileRasterPrimaryFallbackReason || "compute-tile-raster-warming-stable-fallback";
    }
    if (
      this.rendererBackend.requested === "compute" &&
      this.computeTileRasterPreviewPass &&
      !this.computeTileRasterStrictPreviewOnly
    ) {
      return "compute-tile-raster-diagnostic-over-stable";
    }
    if (this.gpuVisibleActive) {
      return "";
    }
    if (this.gpuSortVisibleMode !== "cpu" && this.gpuRadixSortPass) {
      const stats = this.gpuRadixSortPass.getStats();
      if (stats.validationPending) {
        return "global-packed-ssog-gpu-sort-validating";
      }
      if (stats.dispatched && stats.validationSamples > 0) {
        return "global-packed-ssog-gpu-sort-validation-failed";
      }
    }
    if (this.rendererBackend.requested === "auto" && this.gpuSortVisibleMode === "cpu") {
      return `auto-kept-cpu-worker-below-${Math.floor(getSsogAutoGpuSortSplatThreshold()).toLocaleString("en-US")}-splats`;
    }
    return this.rendererBackend.fallbackReason;
  }

  private getComputeRendererPhase(): string {
    if (this.rendererBackend.requested !== "compute") {
      return "disabled";
    }
    if (!this.computeTileRasterPreviewPass) {
      return "global-packed-ssog-raster-fallback";
    }
    if (this.computeTileRasterStrictPreviewOnly) {
      return "global-packed-ssog-tile-raster-preview-only";
    }
    if (this.isComputeTileRasterPrimaryMode()) {
      return this.isComputeTileRasterPrimaryActive()
        ? "global-packed-ssog-tile-raster-primary"
        : "global-packed-ssog-tile-raster-warming-stable-fallback";
    }
    return "global-packed-ssog-tile-raster-diagnostic-over-stable";
  }

  private getComputeRendererVisibility(): string {
    if (this.rendererBackend.requested !== "compute") {
      return "disabled";
    }
    if (!this.computeTileRasterPreviewPass) {
      return "stable-raster-fallback";
    }
    if (this.computeTileRasterStrictPreviewOnly) {
      return "strict-compute-preview-only";
    }
    if (this.isComputeTileRasterPrimaryMode()) {
      return this.isComputeTileRasterPrimaryActive()
        ? "compute-primary"
        : "warming-stable-fallback";
    }
    return "diagnostic-over-stable";
  }

  private updateComputeTilePipeline(): void {
    const camera = this.scene.activeCamera;
    if (!camera || !this.computeTileStatsPass) {
      return;
    }

    const shouldUpdate = this.computeTileFrame === 0;
    this.computeTileFrame = (this.computeTileFrame + 1) % this.computeTileUpdateInterval;
    if (shouldUpdate) {
      const transform = this.scene.getTransformMatrix();
      this.computeTileStatsPass.dispatch(
        transform,
        this.viewport.x,
        this.viewport.y,
        this.numSplats,
      );
      this.computeTileDepthRangePass?.dispatch(transform, this.numSplats);
      this.computeTileWorkQueuePass?.dispatch();
      const depthStats = this.computeTileDepthRangePass?.getStats();
      this.computeTileOrderPass?.dispatch(
        transform,
        this.viewport.x,
        this.viewport.y,
        this.numSplats,
        depthStats?.minDepth ?? 0,
        depthStats?.maxDepth ?? 1,
      );
    }
    this.computeTileRasterPreviewPass?.update(this.viewport.x, this.viewport.y);
    if (this.computeTileRasterStrictPreviewOnly && this.computeTileRasterPreviewPass) {
      const previewStats = this.computeTileRasterPreviewPass.getStats();
      const previewDrawable =
        previewStats.activeTiles > 0 &&
        previewStats.previewSplats > 0 &&
        previewStats.workTiles > 0;
      this.computePreviewDrawableFrames = previewDrawable ? this.computePreviewDrawableFrames + 1 : 0;
      this.mesh.setEnabled(this.enabled && this.computePreviewDrawableFrames < 6);
    } else if (this.isComputeTileRasterPrimaryMode()) {
      const previewStats = this.computeTileRasterPreviewPass?.getStats();
      const previewDrawable =
        !!previewStats &&
        previewStats.activeTiles > 0 &&
        previewStats.previewSplats > 0 &&
        previewStats.workTiles > 0;
      const windowCoverage = previewStats?.windowCoverage ?? 0;
      const sampledCoverage = previewStats?.sampledCoverage ?? 0;
      const adaptiveScale = previewStats?.adaptiveDrawScale ?? 0;
      const frameMs = previewStats?.smoothedFrameMs ?? 0;
      const runtimeDrawCoverageTarget = previewStats?.runtimeDrawCoverageTarget ?? this.computePrimaryMinCoverage;
      const primaryReady =
        previewDrawable &&
        windowCoverage >= this.getComputePrimaryRuntimeMinCoverage(runtimeDrawCoverageTarget) &&
        sampledCoverage >= 0.95 &&
        adaptiveScale >= this.computePrimaryMinAdaptiveScale &&
        (frameMs <= 0 || frameMs <= this.computePrimaryMaxFrameMs);
      const primaryDropped =
        !previewDrawable ||
        windowCoverage < this.computePrimaryDropCoverage ||
        sampledCoverage < 0.9 ||
        adaptiveScale < this.computePrimaryMinAdaptiveScale ||
        (frameMs > 0 && frameMs > this.computePrimaryMaxFrameMs * 1.25);
      this.computeTileRasterPrimaryFallbackReason = this.getComputeTileRasterPrimaryFallbackReason(
        previewDrawable,
        windowCoverage,
        sampledCoverage,
        adaptiveScale,
        frameMs,
        runtimeDrawCoverageTarget,
      );

      if (this.computeTileRasterPrimaryActive) {
        this.computePreviewLowCoverageFrames = primaryDropped ? this.computePreviewLowCoverageFrames + 1 : 0;
        if (this.computePreviewLowCoverageFrames >= this.computePrimaryDropFrames) {
          this.computeTileRasterPrimaryActive = false;
          this.computePreviewDrawableFrames = 0;
        }
      } else {
        this.computePreviewDrawableFrames = primaryReady ? this.computePreviewDrawableFrames + 1 : 0;
        this.computePreviewLowCoverageFrames = 0;
        if (this.computePreviewDrawableFrames >= this.computePrimaryReadyFrames) {
          this.computeTileRasterPrimaryActive = true;
          this.computeTileRasterPrimaryFallbackReason = "";
        }
      }

      this.mesh.setEnabled(this.enabled && !this.computeTileRasterPrimaryActive);
    } else if (this.computeTileRasterPreviewPass) {
      this.computePreviewDrawableFrames = 0;
      this.computePreviewLowCoverageFrames = 0;
      this.computeTileRasterPrimaryActive = false;
      this.computeTileRasterPrimaryFallbackReason = "";
      this.mesh.setEnabled(this.enabled);
    }
  }

  private getComputeTileRasterPrimaryFallbackReason(
    previewDrawable: boolean,
    windowCoverage: number,
    sampledCoverage: number,
    adaptiveScale: number,
    frameMs: number,
    runtimeDrawCoverageTarget: number,
  ): string {
    if (!previewDrawable) {
      return "compute-primary-waiting-for-drawable-work";
    }
    if (adaptiveScale < this.computePrimaryMinAdaptiveScale) {
      return "compute-primary-waiting-for-adaptive-budget";
    }
    if (frameMs > 0 && frameMs > this.computePrimaryMaxFrameMs) {
      return "compute-primary-waiting-for-frame-budget";
    }
    if (sampledCoverage < 0.95) {
      return "compute-primary-waiting-for-full-sample-coverage";
    }
    if (windowCoverage < this.getComputePrimaryRuntimeMinCoverage(runtimeDrawCoverageTarget)) {
      return "compute-primary-waiting-for-window-coverage";
    }
    if (this.computePreviewDrawableFrames < this.computePrimaryReadyFrames) {
      return "compute-primary-waiting-for-stable-frames";
    }
    return "";
  }

  private getComputePrimaryRuntimeMinCoverage(runtimeDrawCoverageTarget: number): number {
    return Math.max(this.computePrimaryMinCoverage, runtimeDrawCoverageTarget * 0.9);
  }

  private getComputeTileStats(): Pick<
    SsogGlobalPackedStats,
    | "computeTileStatsEnabled"
    | "computeTileStatsDispatched"
    | "computeTileSize"
    | "computeTileCount"
    | "computeTileCols"
    | "computeTileRows"
    | "computeOccupiedTiles"
    | "computeMaxTileOccupancy"
    | "computeTileOccupancy"
    | "computeVisibleSplats"
    | "computeBehindSplats"
    | "computeClippedSplats"
    | "computeOverflowSplats"
    | "computeTileOffsetsDispatched"
    | "computeTileListScatterDispatched"
    | "computeTileListValidated"
    | "computeTileListEntries"
    | "computeTileListCapacity"
    | "computeTileOffsetEntries"
    | "computeTileCursorEntries"
    | "computeTileListMismatchedTiles"
    | "lastComputeTileStatsMs"
    | "lastComputeTileOffsetMs"
    | "lastComputeTileListScatterMs"
    | "computeTileDepthEnabled"
    | "computeTileDepthDispatched"
    | "computeTileDepthTiles"
    | "computeTileDepthMin"
    | "computeTileDepthMax"
    | "computeTileDepthMaxSpan"
    | "computeTileDepthAvgSpan"
    | "computeTileDepthSpans"
    | "lastComputeTileDepthMs"
    | "computeTileWorkQueueEnabled"
    | "computeTileWorkQueueDispatched"
    | "computeTileWorkQueueOrderMode"
    | "computeTileWorkQueueDepthBands"
    | "computeTileWorkQueueStableOrder"
    | "computeTileWorkQueueMaxSplatsPerItemConfig"
    | "computeTileWorkQueueBudget"
    | "computeTileWorkQueueBudgetCap"
    | "computeTileWorkQueueCoverageTarget"
    | "computeTileWorkQueueExplicitBudget"
    | "computeTileWorkQueueTiles"
    | "computeTileWorkQueueSplats"
    | "computeTileWorkQueueMaxTileSplats"
    | "computeTileWorkQueueAvgTileSplats"
    | "computeTileWorkQueueOverflowTiles"
    | "lastComputeTileWorkQueueMs"
    | "computeTileOrderEnabled"
    | "computeTileOrderDispatched"
    | "computeTileOrderBuckets"
    | "computeTileOrderTiles"
    | "computeTileOrderTrackedTiles"
    | "computeTileOrderSplats"
    | "computeTileOrderTruncatedSplats"
    | "computeTileOrderOverflowSplats"
    | "computeTileOrderOverflowTiles"
    | "lastComputeTileOrderMs"
  > {
    const stats: ComputeTileStats | undefined = this.computeTileStatsPass?.getStats();
    const depthStats: ComputeTileDepthRangeStats | undefined = this.computeTileDepthRangePass?.getStats();
    const workQueueStats: ComputeTileWorkQueueStats | undefined = this.computeTileWorkQueuePass?.getStats();
    const orderStats: ComputeTileOrderStats | undefined = this.computeTileOrderPass?.getStats();
    return {
      computeTileStatsEnabled: stats?.enabled ?? false,
      computeTileStatsDispatched: stats?.dispatched ?? false,
      computeTileSize: stats?.tileSize ?? 0,
      computeTileCount: stats?.tileCount ?? 0,
      computeTileCols: stats?.tileCols ?? 0,
      computeTileRows: stats?.tileRows ?? 0,
      computeOccupiedTiles: stats?.occupiedTiles ?? 0,
      computeMaxTileOccupancy: stats?.maxTileOccupancy ?? 0,
      computeTileOccupancy: stats?.tileOccupancy,
      computeVisibleSplats: stats?.visibleSplats ?? 0,
      computeBehindSplats: stats?.behindSplats ?? 0,
      computeClippedSplats: stats?.clippedSplats ?? 0,
      computeOverflowSplats: stats?.overflowSplats ?? 0,
      computeTileOffsetsDispatched: stats?.tileOffsetsDispatched ?? false,
      computeTileListScatterDispatched: stats?.tileListScatterDispatched ?? false,
      computeTileListValidated: stats?.tileListValidated ?? false,
      computeTileListEntries: stats?.tileListEntries ?? 0,
      computeTileListCapacity: stats?.tileListCapacity ?? 0,
      computeTileOffsetEntries: stats?.tileOffsetEntries ?? 0,
      computeTileCursorEntries: stats?.tileCursorEntries ?? 0,
      computeTileListMismatchedTiles: stats?.tileListMismatchedTiles ?? 0,
      lastComputeTileStatsMs: stats?.lastDispatchMs ?? 0,
      lastComputeTileOffsetMs: stats?.lastTileOffsetMs ?? 0,
      lastComputeTileListScatterMs: stats?.lastTileListScatterMs ?? 0,
      computeTileDepthEnabled: depthStats?.enabled ?? false,
      computeTileDepthDispatched: depthStats?.dispatched ?? false,
      computeTileDepthTiles: depthStats?.depthTiles ?? 0,
      computeTileDepthMin: depthStats?.minDepth ?? 0,
      computeTileDepthMax: depthStats?.maxDepth ?? 0,
      computeTileDepthMaxSpan: depthStats?.maxDepthSpan ?? 0,
      computeTileDepthAvgSpan: depthStats?.avgDepthSpan ?? 0,
      computeTileDepthSpans: depthStats?.depthSpans,
      lastComputeTileDepthMs: depthStats?.lastDispatchMs ?? 0,
      computeTileWorkQueueEnabled: workQueueStats?.enabled ?? false,
      computeTileWorkQueueDispatched: workQueueStats?.dispatched ?? false,
      computeTileWorkQueueOrderMode: workQueueStats?.orderMode ?? "compact",
      computeTileWorkQueueDepthBands: workQueueStats?.depthBandCount ?? 0,
      computeTileWorkQueueStableOrder: workQueueStats?.stableOrder ?? false,
      computeTileWorkQueueMaxSplatsPerItemConfig: workQueueStats?.maxSplatsPerWorkItem ?? 0,
      computeTileWorkQueueBudget: workQueueStats?.workItemBudget ?? 0,
      computeTileWorkQueueBudgetCap: workQueueStats?.workItemBudgetCap ?? 0,
      computeTileWorkQueueCoverageTarget: workQueueStats?.coverageTarget ?? 1,
      computeTileWorkQueueExplicitBudget: workQueueStats?.explicitWorkItemBudget ?? false,
      computeTileWorkQueueTiles: workQueueStats?.workTiles ?? 0,
      computeTileWorkQueueSplats: workQueueStats?.queuedSplats ?? 0,
      computeTileWorkQueueMaxTileSplats: workQueueStats?.maxTileSplats ?? 0,
      computeTileWorkQueueAvgTileSplats: workQueueStats?.avgTileSplats ?? 0,
      computeTileWorkQueueOverflowTiles: workQueueStats?.overflowTiles ?? 0,
      lastComputeTileWorkQueueMs: workQueueStats?.lastDispatchMs ?? 0,
      computeTileOrderEnabled: orderStats?.enabled ?? false,
      computeTileOrderDispatched: orderStats?.dispatched ?? false,
      computeTileOrderBuckets: orderStats?.bucketCount ?? 0,
      computeTileOrderTiles: orderStats?.tileCount ?? 0,
      computeTileOrderTrackedTiles: orderStats?.trackedTileCount ?? 0,
      computeTileOrderSplats: orderStats?.orderedSplats ?? 0,
      computeTileOrderTruncatedSplats: orderStats?.truncatedSplats ?? 0,
      computeTileOrderOverflowSplats: orderStats?.overflowSplats ?? 0,
      computeTileOrderOverflowTiles: orderStats?.overflowTiles ?? 0,
      lastComputeTileOrderMs: orderStats?.lastDispatchMs ?? 0,
    };
  }

  private getComputeTileSplatPreviewStats(): Pick<
    SsogGlobalPackedStats,
    | "computeTileSplatPreviewEnabled"
    | "computeTileSplatPreviewSamplesPerTile"
    | "computeTileSplatPreviewSplats"
    | "computeTileSplatPreviewActiveTiles"
    | "computeTileSplatPreviewWorkTiles"
    | "computeTileSplatPreviewColorMode"
    | "computeTileSplatPreviewShapeMode"
  > {
    return {
      computeTileSplatPreviewEnabled: false,
      computeTileSplatPreviewSamplesPerTile: 0,
      computeTileSplatPreviewSplats: 0,
      computeTileSplatPreviewActiveTiles: 0,
      computeTileSplatPreviewWorkTiles: 0,
      computeTileSplatPreviewColorMode: "debug",
      computeTileSplatPreviewShapeMode: "marker",
    };
  }

  private getComputeTileRasterPreviewStats(): Pick<
    SsogGlobalPackedStats,
    | "computeTileRasterPreviewEnabled"
    | "computeTileRasterPreviewSamplesPerTile"
    | "computeTileRasterPreviewSplats"
    | "computeTileRasterPreviewWindowSplats"
    | "computeTileRasterPreviewSampledCoverage"
    | "computeTileRasterPreviewWindowCoverage"
    | "computeTileRasterPreviewActiveTiles"
    | "computeTileRasterPreviewWorkTiles"
    | "computeTileRasterPreviewDrawLimit"
    | "computeTileRasterPreviewRequestedDrawLimit"
    | "computeTileRasterPreviewStaticDrawLimit"
    | "computeTileRasterPreviewMotionDrawLimit"
    | "computeTileRasterPreviewAdaptiveScale"
    | "computeTileRasterPreviewFrameMs"
    | "computeTileRasterPreviewMaxMarkerPixels"
    | "computeTileRasterPreviewStaticRamp"
    | "computeTileRasterPreviewColorMode"
    | "computeTileRasterPreviewShapeMode"
    | "computeTileRasterPreviewDrawOrder"
    | "computeTileRasterPreviewWindowMode"
    | "computeTileRasterPreviewCoverageMode"
    | "computeTileRasterPreviewTruncatedSplats"
    | "computeTileRasterPreviewNearWindowMargin"
    | "computeTileRasterPreviewSampleAlphaCompensation"
    | "computeTileRasterPreviewRuntimeSampleAlphaCompensation"
    | "computeTileRasterPreviewSamplePasses"
    | "computeTileRasterPreviewMaxUsefulSamplePasses"
    | "computeTileRasterPreviewStaticSamplePasses"
    | "computeTileRasterPreviewMotionSamplePasses"
    | "computeTileRasterPreviewSampleCoverageTarget"
    | "computeTileRasterPreviewMotionSampleCoverageTarget"
    | "computeTileRasterPreviewRuntimeSampleCoverageTarget"
    | "computeTileRasterPreviewSamplePassesAdaptive"
    | "computeTileRasterPreviewDrawCoverageTarget"
    | "computeTileRasterPreviewMotionDrawCoverageTarget"
    | "computeTileRasterPreviewRuntimeDrawCoverageTarget"
    | "computeTileRasterPreviewDrawCoverageAdaptive"
  > {
    const stats: ComputeTileSplatPreviewStats | undefined = this.computeTileRasterPreviewPass?.getStats();
    return {
      computeTileRasterPreviewEnabled: stats?.enabled ?? false,
      computeTileRasterPreviewSamplesPerTile: stats?.samplesPerTile ?? 0,
      computeTileRasterPreviewSplats: stats?.previewSplats ?? 0,
      computeTileRasterPreviewWindowSplats: stats?.windowSplats ?? 0,
      computeTileRasterPreviewSampledCoverage: stats?.sampledCoverage ?? 0,
      computeTileRasterPreviewWindowCoverage: stats?.windowCoverage ?? 0,
      computeTileRasterPreviewActiveTiles: stats?.activeTiles ?? 0,
      computeTileRasterPreviewWorkTiles: stats?.workTiles ?? 0,
      computeTileRasterPreviewDrawLimit: stats?.drawLimit ?? 0,
      computeTileRasterPreviewRequestedDrawLimit: stats?.requestedDrawLimit ?? 0,
      computeTileRasterPreviewStaticDrawLimit: stats?.staticDrawLimit ?? 0,
      computeTileRasterPreviewMotionDrawLimit: stats?.motionDrawLimit ?? 0,
      computeTileRasterPreviewAdaptiveScale: stats?.adaptiveDrawScale ?? 1,
      computeTileRasterPreviewFrameMs: stats?.smoothedFrameMs ?? 0,
      computeTileRasterPreviewMaxMarkerPixels: stats?.maxMarkerPixels ?? 0,
      computeTileRasterPreviewStaticRamp: stats?.staticRamp ?? 1,
      computeTileRasterPreviewColorMode: stats?.colorMode ?? "debug",
      computeTileRasterPreviewShapeMode: stats?.shapeMode ?? "marker",
      computeTileRasterPreviewDrawOrder: stats?.drawOrder ?? "far",
      computeTileRasterPreviewWindowMode: stats?.windowMode ?? "sampled",
      computeTileRasterPreviewCoverageMode: stats?.rasterCoverageMode ?? "sampled",
      computeTileRasterPreviewTruncatedSplats: stats?.truncatedSplats ?? 0,
      computeTileRasterPreviewNearWindowMargin: stats?.nearWindowMargin ?? 0,
      computeTileRasterPreviewSampleAlphaCompensation: stats?.sampleAlphaCompensation ?? 1,
      computeTileRasterPreviewRuntimeSampleAlphaCompensation:
        stats?.runtimeSampleAlphaCompensation ?? 1,
      computeTileRasterPreviewSamplePasses: stats?.samplePasses ?? 1,
      computeTileRasterPreviewMaxUsefulSamplePasses: stats?.maxUsefulSamplePasses ?? 1,
      computeTileRasterPreviewStaticSamplePasses: stats?.staticSamplePasses ?? 1,
      computeTileRasterPreviewMotionSamplePasses: stats?.motionSamplePasses ?? 1,
      computeTileRasterPreviewSampleCoverageTarget: stats?.sampleCoverageTarget ?? 1,
      computeTileRasterPreviewMotionSampleCoverageTarget: stats?.motionSampleCoverageTarget ?? 1,
      computeTileRasterPreviewRuntimeSampleCoverageTarget: stats?.runtimeSampleCoverageTarget ?? 1,
      computeTileRasterPreviewSamplePassesAdaptive: stats?.samplePassesAdaptive ?? false,
      computeTileRasterPreviewDrawCoverageTarget: stats?.drawCoverageTarget ?? 0,
      computeTileRasterPreviewMotionDrawCoverageTarget: stats?.motionDrawCoverageTarget ?? 0,
      computeTileRasterPreviewRuntimeDrawCoverageTarget: stats?.runtimeDrawCoverageTarget ?? 0,
      computeTileRasterPreviewDrawCoverageAdaptive: stats?.drawCoverageAdaptive ?? false,
    };
  }

  private getGpuDepthKeyStats(): Pick<
    SsogGlobalPackedStats,
    "gpuDepthKeyEnabled" | "gpuDepthKeyDispatched" | "lastGpuDepthKeyMs" | "lastGpuDepthKeySplats"
  > {
    const stats: GpuDepthKeyStats | undefined = this.gpuDepthKeyPass?.getStats();
    return {
      gpuDepthKeyEnabled: stats?.enabled ?? false,
      gpuDepthKeyDispatched: stats?.dispatched ?? false,
      lastGpuDepthKeyMs: stats?.lastDispatchMs ?? 0,
      lastGpuDepthKeySplats: stats?.lastDispatchSplats ?? 0,
    };
  }

  private getGpuRadixSortStats(): Pick<
    SsogGlobalPackedStats,
    | "gpuRadixSortEnabled"
    | "gpuRadixSortDispatched"
    | "lastGpuRadixSortMs"
    | "lastGpuRadixSortSplats"
    | "gpuRadixSortBits"
    | "gpuRadixSortPasses"
    | "gpuRadixValidationEnabled"
    | "gpuRadixValidationPending"
    | "gpuRadixValidationSamples"
    | "gpuRadixAscendingViolations"
    | "gpuRadixDescendingViolations"
    | "gpuRadixOutOfRangeIndices"
    | "gpuRadixDuplicateAdjacentIndices"
    | "gpuRadixChecksumValid"
    | "gpuRadixValidatedIndexCount"
    | "gpuBufferArenaBuffers"
    | "gpuBufferArenaBytes"
    | "gpuBufferArenaPeakBytes"
    | "gpuBufferArenaAllocations"
    | "gpuBufferArenaReuses"
    | "gpuBufferArenaGrows"
  > {
    const stats: GpuRadixSortStats | undefined = this.gpuRadixSortPass?.getStats();
    return {
      gpuRadixSortEnabled: stats?.enabled ?? false,
      gpuRadixSortDispatched: stats?.dispatched ?? false,
      lastGpuRadixSortMs: stats?.lastDispatchMs ?? 0,
      lastGpuRadixSortSplats: stats?.lastDispatchSplats ?? 0,
      gpuRadixSortBits: stats?.sortBits ?? 0,
      gpuRadixSortPasses: stats?.passes ?? 0,
      gpuRadixValidationEnabled: stats?.validationEnabled ?? false,
      gpuRadixValidationPending: stats?.validationPending ?? false,
      gpuRadixValidationSamples: stats?.validationSamples ?? 0,
      gpuRadixAscendingViolations: stats?.ascendingViolations ?? 0,
      gpuRadixDescendingViolations: stats?.descendingViolations ?? 0,
      gpuRadixOutOfRangeIndices: stats?.outOfRangeIndices ?? 0,
      gpuRadixDuplicateAdjacentIndices: stats?.duplicateAdjacentIndices ?? 0,
      gpuRadixChecksumValid: stats?.checksumValid ?? false,
      gpuRadixValidatedIndexCount: stats?.validatedIndexCount ?? 0,
      gpuBufferArenaBuffers: stats?.gpuBufferArenaBuffers ?? 0,
      gpuBufferArenaBytes: stats?.gpuBufferArenaBytes ?? 0,
      gpuBufferArenaPeakBytes: stats?.gpuBufferArenaPeakBytes ?? 0,
      gpuBufferArenaAllocations: stats?.gpuBufferArenaAllocations ?? 0,
      gpuBufferArenaReuses: stats?.gpuBufferArenaReuses ?? 0,
      gpuBufferArenaGrows: stats?.gpuBufferArenaGrows ?? 0,
    };
  }

  private createMaterial(scene: Scene): ShaderMaterial {
    const material = new ShaderMaterial(
      "SsogGlobalPackedRenderPassMaterial",
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
          "minPixelRadius",
          "maxPixelRadius",
          "renderSplatCount",
          "vizMode",
        ],
        storageBuffers: [
          "meansLBuffer",
          "meansUBuffer",
          "quatsBuffer",
          "scalesBuffer",
          "colorBuffer",
          "colorGroupBuffer",
          "scaleCodebookBuffer",
          "chunkInfoBuffer",
          "indexBuffer",
        ],
        needAlphaBlending: true,
        shaderLanguage: ShaderLanguage.WGSL,
      },
    );

    material.backFaceCulling = false;
    material.alphaMode = Constants.ALPHA_PREMULTIPLIED;
    material.disableDepthWrite = true;
    material.setFloat("minPixelRadius", MIN_PIXEL_RADIUS);
    material.setFloat("maxPixelRadius", MAX_PIXEL_RADIUS);
    material.setFloat("renderSplatCount", 0);
    material.setFloat("vizMode", 0);
    return material;
  }

  setVizMode(mode: number): void {
    this.material.setFloat("vizMode", mode);
  }

  private bindStorageBuffers(): void {
    this.material.setStorageBuffer("meansLBuffer", this.buffers.meansL);
    this.material.setStorageBuffer("meansUBuffer", this.buffers.meansU);
    this.material.setStorageBuffer("quatsBuffer", this.buffers.quats);
    this.material.setStorageBuffer("scalesBuffer", this.buffers.scales);
    this.material.setStorageBuffer("colorBuffer", this.buffers.color);
    if (this.colorSegmentationPass) {
      this.material.setStorageBuffer("colorGroupBuffer", this.colorSegmentationPass.getColorGroupBuffer());
    }
    this.material.setStorageBuffer("scaleCodebookBuffer", this.buffers.scaleCodebook);
    this.material.setStorageBuffer("chunkInfoBuffer", this.buffers.chunkInfo);
    this.material.setStorageBuffer("indexBuffer", this.buffers.indices);
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
    this.mesh.alwaysSelectAsActiveMesh = true;
    this.mesh.doNotSyncBoundingInfo = true;
  }

  private setRenderCount(renderCount: number): void {
    this.mesh.forcedInstanceCount = Math.ceil(renderCount / SPLATS_PER_INSTANCE);
    this.material.setFloat("renderSplatCount", renderCount);
  }

  private isComputeTileRasterPrimaryMode(): boolean {
    return (
      this.rendererBackend.requested === "compute" &&
      this.computeTileRasterPrimaryAllowed &&
      !!this.computeTileRasterPreviewPass &&
      !this.computeTileRasterPreviewOnly &&
      !this.computeTileRasterStrictPreviewOnly
    );
  }

  private isComputeTileRasterPrimaryActive(): boolean {
    return this.isComputeTileRasterPrimaryMode() && this.computeTileRasterPrimaryActive;
  }

  private updateSort(): void {
    if (
      (this.computeTileRasterStrictPreviewOnly && this.computeTileRasterPreviewPass) ||
      this.isComputeTileRasterPrimaryActive()
    ) {
      return;
    }
    if (!this.enabled || this.disposed) {
      return;
    }

    const camera = this.scene.activeCamera;
    if (!camera) {
      return;
    }

    const cameraPosition = camera.globalPosition;
    const cameraForward = camera.getDirection(Vector3.Forward());
    this.updateCpuShColors(cameraPosition);
    const initialSort = !Number.isFinite(this.lastCameraPosition.x);
    const moved = Vector3.DistanceSquared(cameraPosition, this.lastCameraPosition) > SORT_MOVE_EPSILON_SQ;
    const turned = Vector3.Dot(cameraForward, this.lastCameraForward) < SORT_FORWARD_DOT_THRESHOLD;
    if (!initialSort && !moved && !turned) {
      this.updateGpuVisibleState();
      return;
    }
    if (this.sortPending) {
      this.updateGpuSortStages(cameraPosition, cameraForward);
      return;
    }

    this.sortFrame = (this.sortFrame + 1) % SORT_INTERVAL_FRAMES;
    if (!initialSort && this.sortFrame !== 1) {
      return;
    }

    this.lastCameraPosition.copyFrom(cameraPosition);
    this.lastCameraForward.copyFrom(cameraForward);
    if (this.updateGpuSortStages(cameraPosition, cameraForward, true)) {
      this.sortPending = false;
      this.lastSortMs = 0;
      this.lastUploadMs = 0;
      return;
    }
    if (!this.sortWorker) {
      return;
    }

    this.sortPending = true;
    this.lastSortStart = performance.now();
    this.sortWorker.postMessage({
      type: "sort",
      cameraPosition: [cameraPosition.x, cameraPosition.y, cameraPosition.z],
      cameraForward: [cameraForward.x, cameraForward.y, cameraForward.z],
    });
  }

  private updateGpuSortStages(cameraPosition: Vector3, cameraForward: Vector3, forceDepth = false): boolean {
    if (!this.gpuDepthKeyPass || !this.gpuRadixSortPass) {
      return false;
    }

    const depthStats = this.gpuDepthKeyPass.getStats();
    const radixStats = this.gpuRadixSortPass.getStats();
    if (this.gpuSortVisibleMode === "cpu" && !isSsogGpuSortShadowContinuous() && radixStats.dispatched) {
      return false;
    }
    if (!forceDepth && depthStats.dispatched && radixStats.dispatched) {
      this.updateGpuVisibleState();
      return this.gpuVisibleActive;
    }

    if (forceDepth && depthStats.dispatched) {
      this.gpuSortFrame = (this.gpuSortFrame + 1) % SORT_INTERVAL_FRAMES;
      if (this.gpuSortFrame !== 1) {
        this.updateGpuVisibleState();
        return this.gpuVisibleActive;
      }
    }

    const depthDispatched = forceDepth || !depthStats.dispatched
      ? this.gpuDepthKeyPass.dispatch(cameraPosition, cameraForward)
      : true;
    if (depthDispatched && (forceDepth || !this.gpuRadixSortPass.getStats().dispatched)) {
      if (this.gpuRadixSortPass.dispatch()) {
        this.gpuVisibleActive = false;
        this.gpuGatheredCurrentSort = false;
      }
    }
    this.updateGpuVisibleState();
    return this.gpuVisibleActive;
  }

  private updateGpuVisibleState(): void {
    if (this.gpuSortVisibleMode === "cpu" || !this.gpuRadixSortPass || !this.gpuIndexGatherPass) {
      return;
    }

    const stats = this.gpuRadixSortPass.getStats();
    const forceVisible = isSsogGpuSortForceVisible();
    const isValidAscending =
      stats.dispatched &&
      !stats.validationPending &&
      stats.validationSamples > 0 &&
      stats.ascendingViolations === 0 &&
      stats.outOfRangeIndices === 0 &&
      stats.duplicateAdjacentIndices === 0 &&
      stats.checksumValid;
    if (!isValidAscending && !(forceVisible && stats.dispatched)) {
      return;
    }

    if (this.gpuGatheredCurrentSort && this.gpuVisibleActive) {
      return;
    }
    const gatherStart = performance.now();
    this.gpuVisibleActive = this.gpuIndexGatherPass.dispatch();
    this.lastGpuGatherMs = this.gpuVisibleActive ? performance.now() - gatherStart : 0;
    this.gpuGatheredCurrentSort = this.gpuVisibleActive;
  }

  private initializeSortWorker(centers: Float32Array, indices: Uint32Array): void {
    this.sortWorker = new Worker(new URL("../workers/splatSort.worker.ts", import.meta.url), {
      type: "module",
    });
    this.sortWorker.onmessage = (event: MessageEvent<{ type: "sorted"; indices: ArrayBuffer }>) => {
      if (this.disposed || event.data.type !== "sorted") {
        return;
      }

      this.sortPending = false;
      this.lastSortMs = this.lastSortStart > 0 ? performance.now() - this.lastSortStart : 0;
      const sortedIndices = new Uint32Array(event.data.indices);
      const uploadStart = performance.now();
      this.buffers.indices.update(sortedIndices, 0, sortedIndices.byteLength);
      this.lastUploadMs = performance.now() - uploadStart;
    };
    this.sortWorker.postMessage({ type: "init", centers: centers.buffer, indices: indices.buffer }, [
      centers.buffer,
      indices.buffer,
    ]);
  }

  private updateCpuShColors(cameraPosition: Vector3): void {
    if (!this.cpuShEnabled || this.shChunks.length === 0) {
      return;
    }

    this.cpuShFrame = (this.cpuShFrame + 1) % this.cpuShIntervalFrames;
    if (this.cpuShFrame !== 1 && this.lastCpuShMs > 0) {
      return;
    }

    const start = performance.now();
    this.colorData.set(this.dcColorData);
    for (const chunk of this.shChunks) {
      bakePackedShColors(chunk.data, chunk.splatOffset, cameraPosition, this.colorData);
    }
    this.buffers.color.update(this.colorData, 0, this.colorData.byteLength);
    this.shStats.shRenderMode = "cpu";
    this.lastCpuShMs = performance.now() - start;
  }
}

const createStorageBuffer = (engine: WebGPUEngine, name: string, data: Uint32Array | Float32Array): StorageBuffer => {
  const buffer = new StorageBuffer(engine, data.byteLength, undefined, name);
  buffer.update(data);
  return buffer;
};

class SsogGlobalPackedIndexGatherPass {
  private readonly shader: ComputeShader;
  private readonly params: StorageBuffer;
  private readonly paramsData = new Uint32Array(4);
  private readonly dispatchCount: number;

  constructor(
    scene: Scene,
    sortedOrdinals: StorageBuffer,
    ordinalToPacked: StorageBuffer,
    drawIndices: StorageBuffer,
    private readonly splatCount: number,
  ) {
    const engine = scene.getEngine() as WebGPUEngine;
    this.paramsData[0] = splatCount;
    this.params = new StorageBuffer(engine, this.paramsData.byteLength, undefined, "SsogGlobalIndexGatherParams");
    this.params.update(this.paramsData);
    this.dispatchCount = Math.ceil(splatCount / GPU_INDEX_GATHER_WORKGROUP_SIZE);
    this.shader = new ComputeShader(
      "SsogGlobalPackedIndexGatherPass",
      engine,
      { computeSource: GPU_INDEX_GATHER_SOURCE },
      {
        bindingsMapping: {
          sortedOrdinals: { group: 0, binding: 0 },
          ordinalToPacked: { group: 0, binding: 1 },
          drawIndices: { group: 0, binding: 2 },
          paramsBuffer: { group: 0, binding: 3 },
        },
      },
    );
    this.shader.setStorageBuffer("sortedOrdinals", sortedOrdinals);
    this.shader.setStorageBuffer("ordinalToPacked", ordinalToPacked);
    this.shader.setStorageBuffer("drawIndices", drawIndices);
    this.shader.setStorageBuffer("paramsBuffer", this.params);
  }

  dispose(): void {
    this.params.dispose();
  }

  dispatch(): boolean {
    if (this.splatCount <= 0) {
      return false;
    }
    return this.shader.dispatch(this.dispatchCount);
  }
}

const resolveSsogGlobalPackedRendererBackend = (): {
  requested: RequestedRendererMode;
  effective: EffectiveRendererMode;
  fallbackReason: string;
} => {
  const requested = getRequestedRendererMode();
  if (requested === "cpu") {
    return { requested, effective: "cpu", fallbackReason: "" };
  }

  if (requested === "compute") {
    return {
      requested,
      effective: "cpu",
      fallbackReason: "global-packed-ssog-compute-tile-raster-not-ready",
    };
  }

  return {
    requested,
    effective: "cpu",
    fallbackReason:
      requested === "gpu"
        ? "global-packed-ssog-gpu-sort-not-ready"
        : "auto-kept-cpu-worker-for-global-packed-ssog",
  };
};

const isSsogGpuSortShadowEnabled = (requested: RequestedRendererMode, splatCount: number): boolean =>
  requested === "gpu" ||
  getSsogGpuSortVisibleParam() !== "cpu" ||
  getSsogGpuSortVisibleMode(requested, splatCount) !== "cpu" ||
  new URLSearchParams(window.location.search).get("ssogGpuSortShadow") === "true";

const getSsogGpuSortVisibleMode = (
  requested: RequestedRendererMode,
  splatCount: number,
): "cpu" | "auto" | "radix" => {
  if (requested === "cpu") {
    return "cpu";
  }

  const explicit = getSsogGpuSortVisibleParam();
  if (explicit === "radix") {
    return "radix";
  }
  if (explicit === "auto") {
    return "auto";
  }
  if (explicit === "cpu") {
    return "cpu";
  }

  if (requested === "compute") {
    return "cpu";
  }
  if (requested === "gpu") {
    return "auto";
  }
  return splatCount >= getSsogAutoGpuSortSplatThreshold() ? "auto" : "cpu";
};

const getSsogGpuSortVisibleParam = (): "unset" | "cpu" | "auto" | "radix" => {
  const value = new URLSearchParams(window.location.search).get("ssogGpuSortVisible");
  if (value === "false" || value === "cpu") {
    return "cpu";
  }
  if (value === "true" || value === "radix") {
    return "radix";
  }
  if (value === "auto") {
    return "auto";
  }
  return "unset";
};

const getSsogAutoGpuSortSplatThreshold = (): number => {
  const value = Number(new URLSearchParams(window.location.search).get("ssogAutoGpuSortSplats"));
  return Number.isFinite(value) && value >= 0 ? value : AUTO_GPU_SORT_SPLAT_THRESHOLD;
};

const isSsogGpuSortShadowContinuous = (): boolean =>
  new URLSearchParams(window.location.search).get("ssogGpuSortShadow") === "continuous";

const isSsogGpuSortForceVisible = (): boolean => {
  const value = new URLSearchParams(window.location.search).get("ssogGpuSortForce");
  return value === "true" || value === "radix";
};

const isSsogComputeTileStatsEnabled = (requested: RequestedRendererMode): boolean => {
  const params = new URLSearchParams(window.location.search);
  return (
    requested === "compute" ||
    params.get("computeTileOverlay") === "true" ||
    params.get("computeTileStats") === "true" ||
    params.get("computeTileOrder") === "depth-bucket" ||
    isSsogComputeTileRasterPreviewEnabled(requested)
  );
};

const isSsogComputeTileDepthEnabled = (requested: RequestedRendererMode): boolean => {
  const params = new URLSearchParams(window.location.search);
  return (
    requested === "compute" ||
    params.get("computeTileDepth") === "true" ||
    params.get("computeTileDepthOverlay") === "true" ||
    params.get("computeTileWorkQueue") === "true" ||
    isSsogComputeTileRasterPreviewEnabled(requested)
  );
};

const isSsogComputeTileWorkQueueEnabled = (requested: RequestedRendererMode): boolean => {
  const params = new URLSearchParams(window.location.search);
  return requested === "compute" || params.get("computeTileWorkQueue") === "true" || isSsogComputeTileRasterPreviewEnabled(requested);
};

const isSsogComputeTileOrderEnabled = (requested: RequestedRendererMode): boolean => {
  const params = new URLSearchParams(window.location.search);
  return requested === "compute" || params.get("computeTileOrder") === "depth-bucket" || isSsogComputeTileRasterPreviewEnabled(requested);
};

const isSsogComputeTileRasterPreviewEnabled = (requested = getRequestedRendererMode()): boolean =>
  requested === "compute" || new URLSearchParams(window.location.search).get("computeTileRasterPreview") === "true";

const isSsogComputeTileRasterPreviewOnlyEnabled = (): boolean =>
  new URLSearchParams(window.location.search).get("computeTileRasterPreviewOnly") === "true";

const isSsogComputeTileRasterStrictPreviewOnlyEnabled = (): boolean =>
  new URLSearchParams(window.location.search).get("computeTileRasterStrictPreviewOnly") === "true";

const isSsogComputeTileRasterPrimaryEnabled = (): boolean =>
  new URLSearchParams(window.location.search).get("computeTileRasterPrimary") === "true";

const INITIAL_SORT_BUCKETS = 8192;

const seedGlobalDepthOrder = (
  centers: Float32Array,
  sourceIndices: Uint32Array,
  out: Uint32Array,
  view: InitialSortView,
): void => {
  const { cameraPosition, cameraForward } = view;
  const count = sourceIndices.length;
  const depths = new Float32Array(count);
  let minDepth = Number.POSITIVE_INFINITY;
  let maxDepth = Number.NEGATIVE_INFINITY;

  for (let i = 0; i < count; i++) {
    const offset = i * 3;
    const depth =
      (centers[offset + 0] - cameraPosition.x) * cameraForward.x +
      (centers[offset + 1] - cameraPosition.y) * cameraForward.y +
      (centers[offset + 2] - cameraPosition.z) * cameraForward.z;
    depths[i] = depth;
    minDepth = Math.min(minDepth, depth);
    maxDepth = Math.max(maxDepth, depth);
  }

  const bucketCount = Math.min(INITIAL_SORT_BUCKETS, Math.max(1, count));
  const counts = new Uint32Array(bucketCount);
  const range = maxDepth - minDepth;
  const scale = range > 1e-6 ? (bucketCount - 1) / range : 0;
  for (let i = 0; i < count; i++) {
    const bucket = Math.max(0, Math.min(bucketCount - 1, Math.floor((maxDepth - depths[i]) * scale)));
    counts[bucket]++;
  }

  for (let i = 1; i < bucketCount; i++) {
    counts[i] += counts[i - 1];
  }

  for (let i = count - 1; i >= 0; i--) {
    const bucket = Math.max(0, Math.min(bucketCount - 1, Math.floor((maxDepth - depths[i]) * scale)));
    const dst = --counts[bucket];
    out[dst] = sourceIndices[i];
  }
};

const buildGlobalPackedArrays = (chunks: SsogGlobalPackedChunk[], initialSortView?: InitialSortView) => {
  if (chunks.length > 255) {
    throw new Error(`Global packed SSOG supports up to 255 selected chunks. Received ${chunks.length}.`);
  }

  const numSplats = chunks.reduce((sum, chunk) => sum + chunk.data.numSplats, 0);
  const meansL = new Uint32Array(numSplats);
  const meansU = new Uint32Array(numSplats);
  const quats = new Uint32Array(numSplats);
  const scales = new Uint32Array(numSplats);
  const color = new Float32Array(numSplats * 4);
  const dcColor = new Float32Array(numSplats * 4);
  const centers = new Float32Array(numSplats * 3);
  const centerScale = new Float32Array(numSplats * 4);
  const globalIndices = new Uint32Array(numSplats);
  const initialDrawIndices = new Uint32Array(numSplats);
  const chunkBaseOffsets = new Uint32Array(chunks.length);
  const chunkInfo = new Float32Array(chunks.length * 8);
  const scaleCodebookLength = chunks.reduce((sum, chunk) => sum + chunk.data.scaleCodebook.length, 0);
  const scaleCodebook = new Float32Array(scaleCodebookLength);
  const shChunks: GlobalPackedShChunk[] = [];
  const shStats: GlobalPackedShStats = {
    colorMode: "dc",
    shNFileCount: 0,
    shNCodebookLength: 0,
    shBands: 0,
    shCoeffCount: 0,
    shPaletteCount: 0,
    shRenderMode: "dc",
  };
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

  let splatOffset = 0;
  let codebookOffset = 0;
  chunks.forEach((chunk, chunkIndex) => {
    const data = chunk.data;
    if (data.numSplats > 0x00ffffff) {
      throw new Error(`Global packed SSOG chunk ${chunk.key} has too many splats for packed indices.`);
    }

    meansL.set(data.meansL, splatOffset);
    meansU.set(data.meansU, splatOffset);
    quats.set(data.quats, splatOffset);
    scales.set(data.scales, splatOffset);
    centers.set(data.centers, splatOffset * 3);
    scaleCodebook.set(data.scaleCodebook, codebookOffset);
    if (data.shN) {
      shChunks.push({ splatOffset, data });
      shStats.colorMode = "sh";
      shStats.shRenderMode = "loaded";
      shStats.shNFileCount += data.shN.fileCount;
      shStats.shNCodebookLength += data.shN.codebookLength;
      shStats.shBands = Math.max(shStats.shBands, data.shN.bands);
      shStats.shCoeffCount = Math.max(shStats.shCoeffCount, data.shN.coeffsPerChannel);
      shStats.shPaletteCount = Math.max(shStats.shPaletteCount, data.shN.paletteCount);
    }
    for (let axis = 0; axis < 3; axis++) {
      boundsMin[axis] = Math.min(boundsMin[axis], data.boundsMin[axis]);
      boundsMax[axis] = Math.max(boundsMax[axis], data.boundsMax[axis]);
    }
    chunkBaseOffsets[chunkIndex] = splatOffset;
    chunkInfo[chunkIndex * 8 + 0] = data.meansMins[0];
    chunkInfo[chunkIndex * 8 + 1] = data.meansMins[1];
    chunkInfo[chunkIndex * 8 + 2] = data.meansMins[2];
    chunkInfo[chunkIndex * 8 + 3] = splatOffset;
    chunkInfo[chunkIndex * 8 + 4] = data.meansMaxs[0];
    chunkInfo[chunkIndex * 8 + 5] = data.meansMaxs[1];
    chunkInfo[chunkIndex * 8 + 6] = data.meansMaxs[2];
    chunkInfo[chunkIndex * 8 + 7] = codebookOffset;

    for (let i = 0; i < data.numSplats; i++) {
      globalIndices[splatOffset + i] = (chunkIndex << 24) | i;
      centerScale[(splatOffset + i) * 4 + 0] = data.centers[i * 3 + 0];
      centerScale[(splatOffset + i) * 4 + 1] = data.centers[i * 3 + 1];
      centerScale[(splatOffset + i) * 4 + 2] = data.centers[i * 3 + 2];
      centerScale[(splatOffset + i) * 4 + 3] = 1;
      const pixel = data.sh0[i];
      const colorOffset = (splatOffset + i) * 4;
      color[colorOffset + 0] = 0.5 + data.sh0Codebook[chan(pixel, 0)] * SH_C0;
      color[colorOffset + 1] = 0.5 + data.sh0Codebook[chan(pixel, 1)] * SH_C0;
      color[colorOffset + 2] = 0.5 + data.sh0Codebook[chan(pixel, 2)] * SH_C0;
      color[colorOffset + 3] = chan(pixel, 3) / 255;
      dcColor[colorOffset + 0] = color[colorOffset + 0];
      dcColor[colorOffset + 1] = color[colorOffset + 1];
      dcColor[colorOffset + 2] = color[colorOffset + 2];
      dcColor[colorOffset + 3] = color[colorOffset + 3];
    }

    splatOffset += data.numSplats;
    codebookOffset += data.scaleCodebook.length;
  });

  if (initialSortView) {
    seedGlobalDepthOrder(centers, globalIndices, initialDrawIndices, initialSortView);
  } else {
    initialDrawIndices.set(globalIndices);
  }

  return {
    meansL,
    meansU,
    quats,
    scales,
    color,
    dcColor,
    centers,
    centerScale,
    globalIndices,
    initialDrawIndices,
    chunkBaseOffsets,
    chunkInfo,
    scaleCodebook,
    shChunks,
    shStats,
    boundsMin,
    boundsMax,
  };
};

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

const bakePackedShColors = (
  data: SogPackedData,
  splatOffset: number,
  cameraPosition: Vector3,
  colors: Float32Array,
): void => {
  const shN = data.shN;
  if (!shN) {
    return;
  }

  const coeffs = shN.coeffsPerChannel;
  const codebook = shN.codebook;
  const centroids = shN.centroids;
  const labels = shN.labels;
  const stride = shN.centroidWidth;

  for (let i = 0; i < data.numSplats; i++) {
    const centerOffset = i * 3;
    const dx = cameraPosition.x - data.centers[centerOffset + 0];
    const dy = cameraPosition.y - data.centers[centerOffset + 1];
    const dz = cameraPosition.z - data.centers[centerOffset + 2];
    const invLen = 1 / Math.max(1e-6, Math.hypot(dx, dy, dz));
    const basis = evalShBasis(dx * invLen, dy * invLen, dz * invLen, coeffs);
    const label = labels[i];
    const paletteIndex = (label & 0xff) | (((label >>> 8) & 0xff) << 8);
    const paletteX = paletteIndex % 64;
    const paletteY = Math.floor(paletteIndex / 64);
    const colorOffset = (splatOffset + i) * 4;

    for (let coeff = 0; coeff < coeffs; coeff++) {
      const pixel = centroids[paletteY * stride + paletteX * coeffs + coeff];
      const basisValue = basis[coeff];
      colors[colorOffset + 0] += codebook[pixel & 0xff] * basisValue;
      colors[colorOffset + 1] += codebook[(pixel >>> 8) & 0xff] * basisValue;
      colors[colorOffset + 2] += codebook[(pixel >>> 16) & 0xff] * basisValue;
    }
  }
};

export { SsogGlobalPackedRenderPass };
export type { SsogGlobalPackedChunk, SsogGlobalPackedStats };
