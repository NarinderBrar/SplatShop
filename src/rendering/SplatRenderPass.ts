import { Constants } from "@babylonjs/core/Engines/constants";
import { Vector2, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { Scene } from "@babylonjs/core/scene";

import type { SplatBuffers } from "../splat/SplatBuffers";
import { SplatLodManager } from "../splat/SplatLodManager";
import { ComputeTileDensityOverlayPass } from "./ComputeTileDensityOverlayPass";
import { ComputeTileDepthRangePass, type ComputeTileDepthRangeStats } from "./ComputeTileDepthRangePass";
import { ComputeTileOrderPass, type ComputeTileOrderStats } from "./ComputeTileOrderPass";
import { ComputeTilePreviewPass } from "./ComputeTilePreviewPass";
import { ComputeTileSplatPreviewPass, type ComputeTileSplatPreviewStats } from "./ComputeTileSplatPreviewPass";
import { ComputeTileStatsPass, type ComputeTileStats } from "./ComputeTileStatsPass";
import { ComputeTileWorkQueuePass, type ComputeTileWorkQueueStats } from "./ComputeTileWorkQueuePass";
import { canCreateComputeShader, GpuDepthKeyPass, type GpuDepthKeyStats } from "./GpuDepthKeyPass";
import { GpuRadixSortPass, type GpuRadixSortStats } from "./GpuRadixSortPass";
import { GpuSortHistogramPass, type GpuSortHistogramStats } from "./GpuSortHistogramPass";
import { GpuSortPrefixSumPass, type GpuSortPrefixSumStats } from "./GpuSortPrefixSumPass";
import { GpuSortScatterPass, type GpuSortScatterStats } from "./GpuSortScatterPass";
import {
  getGpuSortMode,
  getGpuSortVisibleMode,
  getGpuSortIntervalFrames,
  getSortForwardDotThreshold,
  getSortIntervalFrames,
  getSortMode,
  getSortMoveEpsilonSq,
  resolveRendererBackend,
  type EffectiveRendererMode,
  type RequestedRendererMode,
  type RendererBackend,
  type GpuSortMode,
  type GpuSortVisibleMode,
  type SortMode,
} from "./renderControls";

const BALANCED_RENDER_SPLAT_BUDGET = 2_000_000;
const FULL_RENDER_SPLAT_BUDGET = 6_000_000;
const SPLATS_PER_INSTANCE = 128;
const MIN_PIXEL_RADIUS = 2.0;
const MAX_PIXEL_RADIUS = 96;
const ALPHA_CLIP = 1 / 255;
const LOD_REBUILD_INTERVAL_FRAMES = 30;
const LOD_CAMERA_POSITION_EPSILON = 0.08;

const getRenderSplatBudget = (): number => {
  const params = new URLSearchParams(window.location.search);
  const explicitBudget = Number(params.get("splatBudget"));
  if (Number.isFinite(explicitBudget) && explicitBudget > 0) {
    return explicitBudget;
  }

  const quality = params.get("quality");
  if (quality === "fast") {
    return 1_000_000;
  }
  if (quality === "balanced") {
    return BALANCED_RENDER_SPLAT_BUDGET;
  }
  return FULL_RENDER_SPLAT_BUDGET;
};

const getPositiveNumberParam = (name: string, fallback: number): number => {
  const value = Number(new URLSearchParams(window.location.search).get(name));
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const getComputeTileUpdateInterval = (): number => {
  const params = new URLSearchParams(window.location.search);
  const explicit = Number(params.get("computeTileUpdateInterval"));
  if (Number.isFinite(explicit) && explicit > 0) {
    return Math.max(1, Math.floor(explicit));
  }
  if (
    params.get("computeTileSplatPreview") === "true" ||
    params.get("computeTileRasterPreview") === "true" ||
    params.get("computeTilePreview") === "true" ||
    params.get("computeTileDepthOverlay") === "true" ||
    params.get("computeTileDensityRender") === "true"
  ) {
    return 4;
  }
  return 1;
};

const GLSL_VERTEX_SOURCE = `
precision highp float;

attribute vec3 position;
attribute vec2 corner;
attribute vec4 splatColor;
attribute float splatScale;

uniform mat4 worldViewProjection;
uniform vec2 viewport;
uniform float gaussianScale;
uniform float minPixelRadius;
uniform float maxPixelRadius;

varying vec2 vCorner;
varying vec4 vColor;

void main(void) {
  vec4 centerClip = worldViewProjection * vec4(position, 1.0);
  float pixelRadius = clamp(exp(splatScale) * gaussianScale, minPixelRadius, maxPixelRadius);
  vec2 clipOffset = corner * pixelRadius * 2.0 / viewport * centerClip.w;

  gl_Position = vec4(centerClip.xy + clipOffset, centerClip.zw);
  vCorner = corner;
  vColor = splatColor;
}
`;

const GLSL_FRAGMENT_SOURCE = `
precision highp float;

varying vec2 vCorner;
varying vec4 vColor;

const float EXP4 = 0.01831563888873418;
const float INV_ONE_MINUS_EXP4 = 1.018657360363774;

float normExp(float x) {
  return (exp(-4.0 * x) - EXP4) * INV_ONE_MINUS_EXP4;
}

void main(void) {
  float radius2 = dot(vCorner, vCorner);
  if (radius2 > 1.0) {
    discard;
  }

  float alpha = normExp(radius2) * clamp(vColor.a, 0.0, 1.0);
  if (alpha < ${ALPHA_CLIP.toFixed(10)}) {
    discard;
  }
  gl_FragColor = vec4(max(vColor.rgb, vec3(0.0)) * alpha, alpha);
}
`;

const WGSL_VERTEX_SOURCE = `
attribute position: vec3f;

uniform worldViewProjection: mat4x4f;
uniform view: mat4x4f;
uniform world: mat4x4f;
uniform projection: mat4x4f;
uniform viewport: vec2f;
uniform gaussianScale: f32;
uniform minPixelRadius: f32;
uniform maxPixelRadius: f32;
uniform renderSplatCount: f32;

var<storage, read> centerScaleBuffer: array<vec4f>;
var<storage, read> scaleBuffer: array<vec4f>;
var<storage, read> rotationBuffer: array<vec4f>;
var<storage, read> colorBuffer: array<vec4f>;
var<storage, read> indexBuffer: array<u32>;

varying vCorner: vec2f;
varying vColor: vec4f;

#define CUSTOM_VERTEX_DEFINITIONS

fn initCornerCov(
  centerScale: vec3f, 
  rotation: vec4f, 
  scale: vec3f, 
  corner: vec2f, 
  centerClip: vec4f,
  projMat00: f32,
  modelView: mat4x4f
) -> vec4f {
  let w = rotation.x;
  let x = rotation.y;
  let y = rotation.z;
  let z = rotation.w;

  // Babylon uses a left-handed view space by default, so visible perspective-space
  // splats are in front of the camera with positive view z.
  let centerView = modelView * vec4f(centerScale, 1.0);
  if (uniforms.projection[3][3] != 1.0 && centerView.z <= 0.0) {
    return vec4f(0.0, 0.0, 2.0, 1.0);
  }
  let centerClipClamped = vec4f(centerClip.xy, clamp(centerClip.z, 0.0, abs(centerClip.w)), centerClip.w);

  // 3D rotation matrix
  let R = mat3x3f(
    vec3f(1.0 - 2.0 * (y * y + z * z), 2.0 * (x * y + w * z), 2.0 * (x * z - w * y)),
    vec3f(2.0 * (x * y - w * z), 1.0 - 2.0 * (x * x + z * z), 2.0 * (y * z + w * x)),
    vec3f(2.0 * (x * z + w * y), 2.0 * (y * z - w * x), 1.0 - 2.0 * (x * x + y * y))
  );

  // Covariance in 3D: Vrk = M * M^T where M = R * S
  let M = mat3x3f(
    R[0] * scale.x,
    R[1] * scale.y,
    R[2] * scale.z
  );
  let Vrk = M * transpose(M);

  // Upper 3x3 of modelView
  let W = transpose(mat3x3f(modelView[0].xyz, modelView[1].xyz, modelView[2].xyz));

  // Focal length (scaled by viewport width to get pixel focal length)
  let focal = uniforms.viewport.x * projMat00;
  let v = centerView.xyz / centerView.w;

  // Jacobian J
  let J1 = focal / v.z;
  let J2 = -J1 / v.z * v.xy;
  let J = mat3x3f(
    vec3f(J1, 0.0, J2.x),
    vec3f(0.0, J1, J2.y),
    vec3f(0.0, 0.0, 0.0)
  );

  let T = W * J;
  let cov = transpose(T) * Vrk * T;

  // Add EWA lowpass reconstruction filter (0.3 pixel variance)
  let diagonal1 = cov[0][0] + 0.3;
  let offDiagonal = cov[0][1];
  let diagonal2 = cov[1][1] + 0.3;

  let mid = 0.5 * (diagonal1 + diagonal2);
  let radius = length(vec2f((diagonal1 - diagonal2) / 2.0, offDiagonal));
  let lambda1 = mid + radius;
  let lambda2 = max(mid - radius, 0.1);

  // Quad size scaling (using 2.0 * sqrt(2.0 * lambda) = sqrt(8 * lambda))
  let vmin = min(1024.0, min(uniforms.viewport.x, uniforms.viewport.y));
  let l1 = 2.0 * min(sqrt(2.0 * lambda1), vmin);
  let l2 = 2.0 * min(sqrt(2.0 * lambda2), vmin);

  // Check if splat is too small or outside view frustum
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
  let splatIndex = indexBuffer[sourceOrder];
  let centerScale = centerScaleBuffer[splatIndex];
  let logScale = scaleBuffer[splatIndex];
  let rotation = normalize(rotationBuffer[splatIndex]);
  let splatColor = colorBuffer[splatIndex];
  let centerClip = uniforms.worldViewProjection * vec4f(centerScale.xyz, 1.0);
  
  let modelView = uniforms.view * uniforms.world;
  
  let pos = initCornerCov(
    centerScale.xyz, 
    rotation, 
    exp(logScale.xyz) * uniforms.gaussianScale, 
    corner, 
    centerClip,
    uniforms.projection[0][0],
    modelView
  );

  vertexOutputs.position = pos;
  vertexOutputs.vCorner = corner;
  vertexOutputs.vColor = splatColor;
}
`;

const WGSL_FRAGMENT_SOURCE = `
varying vCorner: vec2f;
varying vColor: vec4f;

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

  let alpha = normExp(radius2) * clamp(input.vColor.a, 0.0, 1.0);
  if (alpha < ${ALPHA_CLIP.toFixed(10)}) {
    discard;
  }
  fragmentOutputs.color = vec4f(max(input.vColor.rgb, vec3f(0.0)) * alpha, alpha);
}
`;

type SplatRenderStats = {
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
  computeTileOrderSplats: number;
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
  sortMode: SortMode;
  sortPending: boolean;
  lastSortMs: number;
  lastUploadMs: number;
  lastLodBuildMs: number;
  gpuDepthKeyEnabled: boolean;
  gpuDepthKeyDispatched: boolean;
  lastGpuDepthKeyMs: number;
  lastGpuDepthKeySplats: number;
  gpuSortHistogramEnabled: boolean;
  gpuSortHistogramDispatched: boolean;
  lastGpuSortHistogramMs: number;
  lastGpuSortHistogramSplats: number;
  gpuSortHistogramBuckets: number;
  gpuSortPrefixSumEnabled: boolean;
  gpuSortPrefixSumDispatched: boolean;
  lastGpuSortPrefixSumMs: number;
  gpuSortPrefixSumBuckets: number;
  gpuSortMode: GpuSortMode;
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
  gpuSortVisibleMode: GpuSortVisibleMode;
  gpuSortVisibleEffective: "cpu" | "radix" | "coarse";
  gpuRadixValidationEnabled: boolean;
  gpuRadixValidationPending: boolean;
  gpuRadixValidationSamples: number;
  gpuRadixAscendingViolations: number;
  gpuRadixDescendingViolations: number;
  gpuRadixOutOfRangeIndices: number;
  gpuRadixDuplicateAdjacentIndices: number;
  gpuRadixChecksumValid: boolean;
  gpuRadixValidatedIndexCount: number;
};

type SplatRenderPassOptions = {
  renderBudget?: number;
};

class SplatRenderPass {
  private readonly mesh: Mesh;
  private readonly material: ShaderMaterial;
  private readonly renderBudget: number;
  private readonly lodRangeMin = getPositiveNumberParam("lodRangeMin", 0.0005);
  private readonly lodRangeMax = getPositiveNumberParam("lodRangeMax", 0.15);
  private readonly lodUnderfillLimit = getPositiveNumberParam("lodUnderfillLimit", 0.85);
  private readonly rendererBackend: RendererBackend;
  private readonly gpuDepthKeyPass?: GpuDepthKeyPass;
  private readonly gpuSortHistogramPass?: GpuSortHistogramPass;
  private readonly gpuSortPrefixSumPass?: GpuSortPrefixSumPass;
  private readonly gpuSortScatterPass?: GpuSortScatterPass;
  private readonly gpuRadixSortPass?: GpuRadixSortPass;
  private readonly computeTileStatsPass?: ComputeTileStatsPass;
  private readonly computeTileDepthRangePass?: ComputeTileDepthRangePass;
  private readonly computeTileWorkQueuePass?: ComputeTileWorkQueuePass;
  private readonly computeTileOrderPass?: ComputeTileOrderPass;
  private readonly computeTilePreviewPass?: ComputeTilePreviewPass;
  private readonly computeTileSplatPreviewPass?: ComputeTileSplatPreviewPass;
  private readonly computeTileRasterPreviewPass?: ComputeTileSplatPreviewPass;
  private readonly computeTileDensityOverlayPass?: ComputeTileDensityOverlayPass;
  private readonly gpuSortMode = getGpuSortMode();
  private readonly gpuSortVisibleMode = getGpuSortVisibleMode();
  private readonly sortMode = getSortMode();
  private readonly sortIntervalFrames = getSortIntervalFrames();
  private readonly gpuSortIntervalFrames = getGpuSortIntervalFrames();
  private readonly computeTileUpdateInterval = getComputeTileUpdateInterval();
  private readonly sortMoveEpsilonSq = getSortMoveEpsilonSq();
  private readonly sortForwardDotThreshold = getSortForwardDotThreshold();
  private readonly viewport = new Vector2(1, 1);
  private readonly updateViewport: () => void;
  private sortWorker?: Worker;
  private sortPending = false;
  private enabled = true;
  private sortFrame = 0;
  private gpuSortFrame = 0;
  private computeTileFrame = 0;
  private lodFrame = 0;
  private lodManager?: SplatLodManager;
  private disposed = false;
  private lastCameraPosition = new Vector3(Number.POSITIVE_INFINITY, 0, 0);
  private lastCameraForward = new Vector3(0, 0, 0);
  private lastLodCameraPosition = new Vector3(Number.POSITIVE_INFINITY, 0, 0);
  private renderSplats = 0;
  private activeChunks = 0;
  private selectedLods = 0;
  private lastSortStart = 0;
  private lastSortMs = 0;
  private lastUploadMs = 0;
  private lastLodBuildMs = 0;
  private radixVisibleActive = false;

  constructor(scene: Scene, splatBuffers: SplatBuffers, options: SplatRenderPassOptions = {}) {
    this.mesh = new Mesh("SplatRenderPassQuads", scene);
    this.renderBudget = options.renderBudget ?? getRenderSplatBudget();
    this.rendererBackend = resolveRendererBackend(scene);
    this.mesh.isPickable = false;
    this.mesh.hasVertexAlpha = true;
    this.material = this.createMaterial(scene);
    this.mesh.material = this.material;

    if (splatBuffers.storage && scene.getEngine().isWebGPU) {
      this.gpuDepthKeyPass = this.createGpuDepthKeyPass(scene, splatBuffers);
      this.gpuSortHistogramPass = this.createGpuSortHistogramPass(scene, splatBuffers);
      this.gpuSortPrefixSumPass = this.createGpuSortPrefixSumPass(scene, splatBuffers);
      this.gpuSortScatterPass = this.createGpuSortScatterPass(scene, splatBuffers);
      this.gpuRadixSortPass = this.createGpuRadixSortPass(scene, splatBuffers);
      this.computeTileStatsPass = this.createComputeTileStatsPass(scene, splatBuffers);
      this.computeTileDepthRangePass = this.createComputeTileDepthRangePass(scene, splatBuffers);
      this.computeTileWorkQueuePass = this.createComputeTileWorkQueuePass(scene);
      this.computeTileOrderPass = this.createComputeTileOrderPass(scene, splatBuffers);
      this.computeTilePreviewPass = this.createComputeTilePreviewPass(scene);
      this.computeTileSplatPreviewPass = this.createComputeTileSplatPreviewPass(scene, splatBuffers);
      this.computeTileRasterPreviewPass = this.createComputeTileRasterPreviewPass(scene, splatBuffers);
      this.computeTileDensityOverlayPass = this.createComputeTileDensityOverlayPass(scene);
      this.buildStorageBufferGeometry(scene, splatBuffers);
      this.material.setStorageBuffer("centerScaleBuffer", splatBuffers.storage.centerScale);
      this.material.setStorageBuffer("scaleBuffer", splatBuffers.storage.scale);
      this.material.setStorageBuffer("rotationBuffer", splatBuffers.storage.rotationOpacity);
      this.material.setStorageBuffer("colorBuffer", splatBuffers.storage.color);
      this.material.setStorageBuffer("indexBuffer", splatBuffers.storage.indices);
    } else {
      this.buildExpandedQuadGeometry(splatBuffers);
    }

    this.updateViewport = () => {
      const engine = scene.getEngine();
      this.viewport.set(engine.getRenderWidth(true), engine.getRenderHeight(true));
      this.material.setVector2("viewport", this.viewport);
      this.updateComputeTilePipeline(scene);
      this.computeTilePreviewPass?.update();
      this.computeTileSplatPreviewPass?.update(this.viewport.x, this.viewport.y);
      this.computeTileRasterPreviewPass?.update(this.viewport.x, this.viewport.y);
      this.computeTileDensityOverlayPass?.update();
      this.updateSort(scene, splatBuffers);
    };
    scene.registerBeforeRender(this.updateViewport);
    this.updateViewport();
  }

  dispose(): void {
    this.disposed = true;
    this.sortWorker?.terminate();
    this.gpuDepthKeyPass?.dispose();
    this.gpuSortHistogramPass?.dispose();
    this.gpuSortPrefixSumPass?.dispose();
    this.gpuSortScatterPass?.dispose();
    this.gpuRadixSortPass?.dispose();
    this.computeTileStatsPass?.dispose();
    this.computeTileDepthRangePass?.dispose();
    this.computeTileWorkQueuePass?.dispose();
    this.computeTileOrderPass?.dispose();
    this.computeTilePreviewPass?.dispose();
    this.computeTileSplatPreviewPass?.dispose();
    this.computeTileRasterPreviewPass?.dispose();
    this.computeTileDensityOverlayPass?.dispose();
    this.mesh.getScene().unregisterBeforeRender(this.updateViewport);
    this.mesh.dispose();
    this.material.dispose();
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.mesh.setEnabled(enabled);
  }

  getStats(): SplatRenderStats {
    return {
      renderSplats: this.renderSplats,
      chunkCount: this.lodManager?.chunks.length ?? 0,
      activeChunks: this.activeChunks,
      selectedLods: this.selectedLods,
      rendererMode: `raster-${this.rendererBackend.effective}-sort-${this.sortMode}`,
      rendererRequested: this.rendererBackend.requested,
      rendererEffective: this.rendererBackend.effective,
      rendererFallbackReason: this.rendererBackend.fallbackReason,
      computeRendererEnabled: this.rendererBackend.effective === "compute",
        computeRendererPhase:
          this.rendererBackend.effective === "compute"
            ? this.computeTileRasterPreviewPass
              ? this.computeTileOrderPass
                ? "tile-raster-preview-depth-bucket"
                : "tile-raster-preview"
              : "scaffold-raster-output"
            : "disabled",
        colorMode: "dc",
        shNFileCount: 0,
        shNCodebookLength: 0,
        shBands: 0,
        shCoeffCount: 0,
        shPaletteCount: 0,
        shRenderMode: "dc",
        ...this.getComputeTileStats(),
        ...this.getComputeTileSplatPreviewStats(),
      ...this.getComputeTileRasterPreviewStats(),
      computeTileUpdateInterval: this.computeTileUpdateInterval,
      sortMode: this.sortMode,
      sortPending: this.sortPending,
      lastSortMs: this.lastSortMs,
      lastUploadMs: this.lastUploadMs,
      lastLodBuildMs: this.lastLodBuildMs,
      ...this.getGpuDepthKeyStats(),
      ...this.getGpuSortHistogramStats(),
      ...this.getGpuSortPrefixSumStats(),
      ...this.getGpuSortScatterStats(),
      ...this.getGpuRadixSortStats(),
      gpuSortVisibleMode: this.gpuSortVisibleMode,
      gpuSortVisibleEffective: this.getGpuSortVisibleEffective(),
    };
  }

  private getGpuSortVisibleEffective(): "cpu" | "radix" | "coarse" {
    if (this.gpuSortMode === "coarse" && this.gpuSortVisibleMode === "coarse") {
      return "coarse";
    }
    if (this.gpuSortMode === "active" && (this.gpuSortVisibleMode === "radix" || this.radixVisibleActive)) {
      return "radix";
    }
    return "cpu";
  }

  private createGpuDepthKeyPass(scene: Scene, splatBuffers: SplatBuffers): GpuDepthKeyPass | undefined {
    if (
      !splatBuffers.storage ||
      !canCreateComputeShader(scene) ||
      this.gpuSortMode === "off" ||
      (this.rendererBackend.effective !== "gpu" && this.rendererBackend.effective !== "compute")
    ) {
      return undefined;
    }

    return new GpuDepthKeyPass(
      scene,
      splatBuffers.storage.centerScale,
      splatBuffers.storage.depthKeys,
      splatBuffers.stats.numSplats,
      splatBuffers.stats.boundsMin,
      splatBuffers.stats.boundsMax,
    );
  }

  private createComputeTileStatsPass(scene: Scene, splatBuffers: SplatBuffers): ComputeTileStatsPass | undefined {
    if (
      !splatBuffers.storage ||
      this.rendererBackend.effective !== "compute" ||
      !ComputeTileStatsPass.isSupported(scene)
    ) {
      return undefined;
    }
    return new ComputeTileStatsPass(scene, splatBuffers.storage.centerScale, splatBuffers.stats.numSplats);
  }

  private createComputeTileDensityOverlayPass(scene: Scene): ComputeTileDensityOverlayPass | undefined {
    if (!this.computeTileStatsPass || !ComputeTileDensityOverlayPass.isEnabled()) {
      return undefined;
    }
    return new ComputeTileDensityOverlayPass(scene, this.computeTileStatsPass);
  }

  private createComputeTileDepthRangePass(
    scene: Scene,
    splatBuffers: SplatBuffers,
  ): ComputeTileDepthRangePass | undefined {
    if (
      !splatBuffers.storage ||
      !this.computeTileStatsPass ||
      this.rendererBackend.effective !== "compute" ||
      !ComputeTileDepthRangePass.isEnabled() ||
      !ComputeTileDepthRangePass.isSupported(scene)
    ) {
      return undefined;
    }
    return new ComputeTileDepthRangePass(
      scene,
      splatBuffers.storage.centerScale,
      this.computeTileStatsPass,
      splatBuffers.stats.numSplats,
    );
  }

  private createComputeTileWorkQueuePass(scene: Scene): ComputeTileWorkQueuePass | undefined {
    if (
      !this.computeTileStatsPass ||
      !this.computeTileDepthRangePass ||
      this.rendererBackend.effective !== "compute" ||
      !ComputeTileWorkQueuePass.isEnabled() ||
      !ComputeTileWorkQueuePass.isSupported(scene)
    ) {
      return undefined;
    }
    return new ComputeTileWorkQueuePass(scene, this.computeTileStatsPass, this.computeTileDepthRangePass);
  }

  private createComputeTileOrderPass(
    scene: Scene,
    splatBuffers: SplatBuffers,
  ): ComputeTileOrderPass | undefined {
    if (
      !splatBuffers.storage ||
      !this.computeTileStatsPass ||
      this.rendererBackend.effective !== "compute" ||
      !ComputeTileOrderPass.isEnabled() ||
      !ComputeTileOrderPass.isSupported(scene)
    ) {
      return undefined;
    }
    return new ComputeTileOrderPass(
      scene,
      splatBuffers.storage.centerScale,
      this.computeTileStatsPass,
      splatBuffers.stats.numSplats,
    );
  }

  private createComputeTilePreviewPass(scene: Scene): ComputeTilePreviewPass | undefined {
    if (!this.computeTileStatsPass || !this.computeTileWorkQueuePass || !ComputeTilePreviewPass.isEnabled()) {
      return undefined;
    }
    return new ComputeTilePreviewPass(scene, this.computeTileStatsPass, this.computeTileWorkQueuePass);
  }

  private createComputeTileSplatPreviewPass(
    scene: Scene,
    splatBuffers: SplatBuffers,
  ): ComputeTileSplatPreviewPass | undefined {
    if (
      !splatBuffers.storage ||
      !this.computeTileStatsPass ||
      !this.computeTileWorkQueuePass ||
      !ComputeTileSplatPreviewPass.isEnabled()
    ) {
      return undefined;
    }
    return new ComputeTileSplatPreviewPass(
      scene,
      {
        centerBuffer: splatBuffers.storage.centerScale,
        scaleBuffer: splatBuffers.storage.scale,
        rotationBuffer: splatBuffers.storage.rotationOpacity,
        colorBuffer: splatBuffers.storage.color,
        splatRadiusScale: 420,
      },
      this.computeTileStatsPass,
      this.computeTileWorkQueuePass,
    );
  }

  private createComputeTileRasterPreviewPass(
    scene: Scene,
    splatBuffers: SplatBuffers,
  ): ComputeTileSplatPreviewPass | undefined {
    if (
      !splatBuffers.storage ||
      !this.computeTileStatsPass ||
      !this.computeTileWorkQueuePass ||
      new URLSearchParams(window.location.search).get("computeTileRasterPreview") !== "true"
    ) {
      return undefined;
    }
    return new ComputeTileSplatPreviewPass(
      scene,
      {
        centerBuffer: splatBuffers.storage.centerScale,
        tileSplatListBuffer: this.computeTileOrderPass?.getOrderedTileSplatListBuffer(),
        scaleBuffer: splatBuffers.storage.scale,
        rotationBuffer: splatBuffers.storage.rotationOpacity,
        colorBuffer: splatBuffers.storage.color,
        splatRadiusScale: 420,
        coverageMode: "bounded",
        shapeMode:
          new URLSearchParams(window.location.search).get("computeTileRasterShape") === "gaussian"
            ? "gaussian"
            : "marker",
        alphaMode: "splat",
        maxMarkerPixels: 96.0,
      },
      this.computeTileStatsPass,
      this.computeTileWorkQueuePass,
    );
  }

  private updateComputeTileStats(scene: Scene): void {
    const camera = scene.activeCamera;
    if (!camera || !this.computeTileStatsPass) {
      return;
    }
    this.computeTileStatsPass.dispatch(
      camera.getTransformationMatrix(),
      this.viewport.x,
      this.viewport.y,
      this.renderSplats,
    );
  }

  private updateComputeTileDepthRange(scene: Scene): void {
    const camera = scene.activeCamera;
    if (!camera || !this.computeTileDepthRangePass) {
      return;
    }
    this.computeTileDepthRangePass.dispatch(camera.getTransformationMatrix(), this.renderSplats);
  }

  private updateComputeTileWorkQueue(): void {
    this.computeTileWorkQueuePass?.dispatch();
  }

  private updateComputeTileOrder(scene: Scene): void {
    const camera = scene.activeCamera;
    const depthStats = this.computeTileDepthRangePass?.getStats();
    if (!camera || !this.computeTileOrderPass) {
      return;
    }
    this.computeTileOrderPass.dispatch(
      camera.getTransformationMatrix(),
      this.viewport.x,
      this.viewport.y,
      this.renderSplats,
      depthStats?.minDepth ?? 0,
      depthStats?.maxDepth ?? 1,
    );
  }

  private updateComputeTilePipeline(scene: Scene): void {
    if (!this.computeTileStatsPass) {
      return;
    }
    const shouldUpdate = this.computeTileFrame === 0;
    this.computeTileFrame = (this.computeTileFrame + 1) % this.computeTileUpdateInterval;
    if (!shouldUpdate) {
      return;
    }
      this.updateComputeTileStats(scene);
      this.updateComputeTileDepthRange(scene);
      this.updateComputeTileWorkQueue();
      this.updateComputeTileOrder(scene);
    }

  private getComputeTileStats(): Pick<
    SplatRenderStats,
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
      | "computeTileOrderSplats"
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
        computeTileOrderSplats: orderStats?.orderedSplats ?? 0,
        lastComputeTileOrderMs: orderStats?.lastDispatchMs ?? 0,
      };
    }

  private getComputeTileSplatPreviewStats(): Pick<
    SplatRenderStats,
    | "computeTileSplatPreviewEnabled"
    | "computeTileSplatPreviewSamplesPerTile"
    | "computeTileSplatPreviewSplats"
    | "computeTileSplatPreviewActiveTiles"
    | "computeTileSplatPreviewWorkTiles"
    | "computeTileSplatPreviewColorMode"
    | "computeTileSplatPreviewShapeMode"
  > {
    const stats: ComputeTileSplatPreviewStats | undefined = this.computeTileSplatPreviewPass?.getStats();
    return {
      computeTileSplatPreviewEnabled: stats?.enabled ?? false,
      computeTileSplatPreviewSamplesPerTile: stats?.samplesPerTile ?? 0,
      computeTileSplatPreviewSplats: stats?.previewSplats ?? 0,
      computeTileSplatPreviewActiveTiles: stats?.activeTiles ?? 0,
      computeTileSplatPreviewWorkTiles: stats?.workTiles ?? 0,
      computeTileSplatPreviewColorMode: stats?.colorMode ?? "debug",
      computeTileSplatPreviewShapeMode: stats?.shapeMode ?? "marker",
    };
  }

  private getComputeTileRasterPreviewStats(): Pick<
    SplatRenderStats,
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
    SplatRenderStats,
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

  private createGpuSortHistogramPass(scene: Scene, splatBuffers: SplatBuffers): GpuSortHistogramPass | undefined {
    if (
      !splatBuffers.storage ||
      !GpuSortHistogramPass.isSupported(scene) ||
      this.gpuSortMode === "off" ||
      this.gpuSortMode === "active" ||
      (this.rendererBackend.effective !== "gpu" && this.rendererBackend.effective !== "compute")
    ) {
      return undefined;
    }

    return new GpuSortHistogramPass(
      scene,
      splatBuffers.storage.depthKeys,
      splatBuffers.storage.sortBucketCounts,
      splatBuffers.stats.numSplats,
    );
  }

  private getGpuSortHistogramStats(): Pick<
    SplatRenderStats,
    | "gpuSortHistogramEnabled"
    | "gpuSortHistogramDispatched"
    | "lastGpuSortHistogramMs"
    | "lastGpuSortHistogramSplats"
    | "gpuSortHistogramBuckets"
  > {
    const stats: GpuSortHistogramStats | undefined = this.gpuSortHistogramPass?.getStats();
    return {
      gpuSortHistogramEnabled: stats?.enabled ?? false,
      gpuSortHistogramDispatched: stats?.dispatched ?? false,
      lastGpuSortHistogramMs: stats?.lastDispatchMs ?? 0,
      lastGpuSortHistogramSplats: stats?.lastDispatchSplats ?? 0,
      gpuSortHistogramBuckets: stats?.bucketCount ?? 0,
    };
  }

  private createGpuSortPrefixSumPass(scene: Scene, splatBuffers: SplatBuffers): GpuSortPrefixSumPass | undefined {
    if (
      !splatBuffers.storage ||
      !GpuSortPrefixSumPass.isSupported(scene) ||
      this.gpuSortMode === "off" ||
      this.gpuSortMode === "active" ||
      (this.rendererBackend.effective !== "gpu" && this.rendererBackend.effective !== "compute")
    ) {
      return undefined;
    }

    return new GpuSortPrefixSumPass(
      scene,
      splatBuffers.storage.sortBucketCounts,
      splatBuffers.storage.sortBucketOffsets,
    );
  }

  private getGpuSortPrefixSumStats(): Pick<
    SplatRenderStats,
    | "gpuSortPrefixSumEnabled"
    | "gpuSortPrefixSumDispatched"
    | "lastGpuSortPrefixSumMs"
    | "gpuSortPrefixSumBuckets"
  > {
    const stats: GpuSortPrefixSumStats | undefined = this.gpuSortPrefixSumPass?.getStats();
    return {
      gpuSortPrefixSumEnabled: stats?.enabled ?? false,
      gpuSortPrefixSumDispatched: stats?.dispatched ?? false,
      lastGpuSortPrefixSumMs: stats?.lastDispatchMs ?? 0,
      gpuSortPrefixSumBuckets: stats?.bucketCount ?? 0,
    };
  }

  private createGpuSortScatterPass(scene: Scene, splatBuffers: SplatBuffers): GpuSortScatterPass | undefined {
    if (
      !splatBuffers.storage ||
      !GpuSortScatterPass.isSupported(scene) ||
      this.gpuSortMode === "off" ||
      this.gpuSortMode === "active" ||
      (this.rendererBackend.effective !== "gpu" && this.rendererBackend.effective !== "compute")
    ) {
      return undefined;
    }

    return new GpuSortScatterPass(
      scene,
      splatBuffers.storage.depthKeys,
      splatBuffers.storage.sortBucketOffsets,
      this.gpuSortMode === "coarse" ? splatBuffers.storage.indices : splatBuffers.storage.sortScratchIndices,
      splatBuffers.stats.numSplats,
    );
  }

  private getGpuSortScatterStats(): Pick<
    SplatRenderStats,
    | "gpuSortMode"
    | "gpuSortScatterEnabled"
    | "gpuSortScatterDispatched"
    | "lastGpuSortScatterMs"
    | "lastGpuSortScatterSplats"
  > {
    const stats: GpuSortScatterStats | undefined = this.gpuSortScatterPass?.getStats();
    return {
      gpuSortMode: this.gpuSortMode,
      gpuSortScatterEnabled: stats?.enabled ?? false,
      gpuSortScatterDispatched: stats?.dispatched ?? false,
      lastGpuSortScatterMs: stats?.lastDispatchMs ?? 0,
      lastGpuSortScatterSplats: stats?.lastDispatchSplats ?? 0,
    };
  }

  private canUseGpuSortForDraw(splatBuffers: SplatBuffers): boolean {
    return (
      ((this.gpuSortMode === "coarse" && this.gpuSortVisibleMode === "coarse" && !!this.gpuSortScatterPass) ||
        (this.gpuSortMode === "active" &&
          (this.gpuSortVisibleMode === "radix" || this.radixVisibleActive) &&
          !!this.gpuRadixSortPass)) &&
      this.renderSplats === splatBuffers.stats.numSplats
    );
  }

  private createGpuRadixSortPass(scene: Scene, splatBuffers: SplatBuffers): GpuRadixSortPass | undefined {
    if (
      !splatBuffers.storage ||
      !GpuRadixSortPass.isSupported(scene) ||
      this.gpuSortMode !== "active" ||
      (this.rendererBackend.effective !== "gpu" && this.rendererBackend.effective !== "compute")
    ) {
      return undefined;
    }

    return new GpuRadixSortPass(
      scene,
      splatBuffers.storage.depthKeys,
      this.gpuSortVisibleMode === "radix" ? splatBuffers.storage.indices : splatBuffers.storage.sortScratchIndices,
      splatBuffers.stats.numSplats,
    );
  }

  private useCpuVisibleSort(splatBuffers: SplatBuffers): void {
    if (!this.radixVisibleActive || !splatBuffers.storage) {
      return;
    }
    this.material.setStorageBuffer("indexBuffer", splatBuffers.storage.indices);
    this.radixVisibleActive = false;
  }

  private updateAutoRadixVisibility(splatBuffers: SplatBuffers): void {
    if (this.gpuSortVisibleMode !== "auto" || !this.gpuRadixSortPass || this.radixVisibleActive) {
      return;
    }
    if (!splatBuffers.storage || this.renderSplats !== splatBuffers.stats.numSplats) {
      return;
    }
    const stats = this.gpuRadixSortPass.getStats();
    const isValidAscending =
      stats.dispatched &&
      !stats.validationPending &&
      stats.validationSamples > 0 &&
      stats.ascendingViolations === 0 &&
      stats.outOfRangeIndices === 0 &&
      stats.duplicateAdjacentIndices === 0 &&
      stats.checksumValid;
    if (!isValidAscending) {
      return;
    }
    this.material.setStorageBuffer("indexBuffer", splatBuffers.storage.sortScratchIndices);
    this.radixVisibleActive = true;
  }

  private getGpuRadixSortStats(): Pick<
    SplatRenderStats,
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
    };
  }

  private updateGpuSortStages(
    cameraPosition: Vector3,
    cameraForward: Vector3,
    splatBuffers: SplatBuffers,
    forceDepth = false,
  ): void {
    const depthStats = this.gpuDepthKeyPass?.getStats();
    const histogramStats = this.gpuSortHistogramPass?.getStats();
    const radixStats = this.gpuRadixSortPass?.getStats();
    const sortAlreadyDispatched = this.gpuRadixSortPass ? radixStats?.dispatched : histogramStats?.dispatched;
    if (!this.gpuDepthKeyPass || (!forceDepth && depthStats?.dispatched && sortAlreadyDispatched)) {
      this.updateAutoRadixVisibility(splatBuffers);
      return;
    }
    if (forceDepth && depthStats?.dispatched) {
      this.gpuSortFrame = (this.gpuSortFrame + 1) % this.gpuSortIntervalFrames;
      if (this.gpuSortFrame !== 1) {
        this.updateAutoRadixVisibility(splatBuffers);
        return;
      }
    }
    if (forceDepth && this.gpuSortVisibleMode === "auto") {
      this.useCpuVisibleSort(splatBuffers);
    }

    const depthDispatched = forceDepth || !depthStats?.dispatched
      ? this.gpuDepthKeyPass.dispatch(cameraPosition, cameraForward)
      : true;
    if (depthDispatched && this.gpuSortHistogramPass && (forceDepth || !histogramStats?.dispatched)) {
      const histogramDispatched = this.gpuSortHistogramPass.dispatch();
      if (histogramDispatched) {
        const prefixDispatched = this.gpuSortPrefixSumPass?.dispatch() ?? false;
        if (prefixDispatched) {
          this.gpuSortScatterPass?.dispatch();
        }
      }
    }
    if (depthDispatched && this.gpuRadixSortPass && (forceDepth || !this.gpuRadixSortPass.getStats().dispatched)) {
      this.gpuRadixSortPass.dispatch();
    }
    this.updateAutoRadixVisibility(splatBuffers);
  }

  private createMaterial(scene: Scene): ShaderMaterial {
    const isWebGPU = scene.getEngine().isWebGPU;
    const material = new ShaderMaterial(
      "SplatRenderPassMaterial",
      scene,
      {
        vertexSource: isWebGPU ? WGSL_VERTEX_SOURCE : GLSL_VERTEX_SOURCE,
        fragmentSource: isWebGPU ? WGSL_FRAGMENT_SOURCE : GLSL_FRAGMENT_SOURCE,
      },
      {
        attributes: isWebGPU ? ["position"] : ["position", "corner", "splatColor", "splatScale"],
        uniforms: [
          "worldViewProjection",
          "view",
          "world",
          "projection",
          "viewport",
          "gaussianScale",
          "minPixelRadius",
          "maxPixelRadius",
          "renderSplatCount",
        ],
        storageBuffers: isWebGPU
          ? ["centerScaleBuffer", "scaleBuffer", "rotationBuffer", "colorBuffer", "indexBuffer"]
          : [],
        needAlphaBlending: true,
        shaderLanguage: isWebGPU ? ShaderLanguage.WGSL : ShaderLanguage.GLSL,
      },
    );

    material.backFaceCulling = false;
    material.alphaMode = Constants.ALPHA_PREMULTIPLIED;
    material.disableDepthWrite = true;
    material.setFloat("gaussianScale", isWebGPU ? 1.0 : 420);
    material.setFloat("minPixelRadius", MIN_PIXEL_RADIUS);
    material.setFloat("maxPixelRadius", MAX_PIXEL_RADIUS);
    material.setFloat("renderSplatCount", 0);

    return material;
  }

  private buildStorageBufferGeometry(scene: Scene, splatBuffers: SplatBuffers): void {
    const lodStart = performance.now();
    this.lodManager = new SplatLodManager(splatBuffers.packed.centerScale);
    const cameraPosition = scene.activeCamera?.globalPosition;
    const { centers, indices, activeChunks, selectedLods } = this.lodManager.select({
      budget: this.renderBudget,
      cameraPosition,
      lodRangeMin: this.lodRangeMin,
      lodRangeMax: this.lodRangeMax,
      lodUnderfillLimit: this.lodUnderfillLimit,
    });
    const renderCount = indices.length;
    this.activeChunks = activeChunks;
    this.selectedLods = selectedLods;
    splatBuffers.storage?.indices.update(indices, 0, indices.byteLength);
    this.lastLodBuildMs = performance.now() - lodStart;
    this.initializeSortWorker(splatBuffers, centers, indices);

    this.setRenderCount(renderCount);
    this.mesh.doNotSyncBoundingInfo = true;

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
  }

  private setRenderCount(renderCount: number): void {
    this.renderSplats = renderCount;
    this.mesh.forcedInstanceCount = Math.ceil(renderCount / SPLATS_PER_INSTANCE);
    this.material.setFloat("renderSplatCount", renderCount);
  }

  private initializeSortWorker(
    splatBuffers: SplatBuffers,
    centers: Float32Array,
    indices: Uint32Array,
  ): void {
    const shouldCreateWorker = !this.sortWorker;
    this.sortPending = false;
    if (shouldCreateWorker) {
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
        splatBuffers.storage?.indices.update(sortedIndices, 0, sortedIndices.byteLength);
        this.lastUploadMs = performance.now() - uploadStart;
      };
    }

    const sortWorker = this.sortWorker;
    if (!sortWorker) {
      return;
    }

    sortWorker.postMessage(
      {
        type: "init",
        centers: centers.buffer,
        indices: indices.buffer,
      },
      [centers.buffer, indices.buffer],
    );
  }

  private updateSort(scene: Scene, splatBuffers: SplatBuffers): void {
    const gpuSortOwnsDraw = this.canUseGpuSortForDraw(splatBuffers);
    if (!this.enabled || !splatBuffers.storage || (!gpuSortOwnsDraw && !this.sortWorker)) {
      return;
    }

    const camera = scene.activeCamera;
    if (!camera) {
      return;
    }

    const cameraPosition = camera.globalPosition;
    const cameraForward = camera.getDirection(Vector3.Forward());
    this.updateLod(cameraPosition, splatBuffers);

    const initialSort = !Number.isFinite(this.lastCameraPosition.x);
    const moved = Vector3.DistanceSquared(cameraPosition, this.lastCameraPosition) > this.sortMoveEpsilonSq;
    const turned = Vector3.Dot(cameraForward, this.lastCameraForward) < this.sortForwardDotThreshold;
    const shouldSortView = initialSort || moved || turned;

    if (shouldSortView && this.gpuSortVisibleMode === "auto") {
      this.useCpuVisibleSort(splatBuffers);
    }

    if (this.sortPending) {
      return;
    }

    this.updateGpuSortStages(cameraPosition, cameraForward, splatBuffers);

    if (this.sortMode === "static" && !initialSort) {
      return;
    }

    if (!shouldSortView && this.sortMode !== "continuous") {
      return;
    }

    this.sortFrame = (this.sortFrame + 1) % this.sortIntervalFrames;
    if (!initialSort && this.sortFrame !== 1) {
      return;
    }

    this.lastCameraPosition.copyFrom(cameraPosition);
    this.lastCameraForward.copyFrom(cameraForward);
    this.updateGpuSortStages(cameraPosition, cameraForward, splatBuffers, true);
    if (this.canUseGpuSortForDraw(splatBuffers)) {
      this.lastSortMs = 0;
      this.lastUploadMs = 0;
      this.sortPending = false;
      return;
    }

    const sortWorker = this.sortWorker;
    if (!sortWorker) {
      return;
    }
    this.sortPending = true;
    this.lastSortStart = performance.now();
    sortWorker.postMessage({
      type: "sort",
      cameraPosition: [cameraPosition.x, cameraPosition.y, cameraPosition.z],
      cameraForward: [cameraForward.x, cameraForward.y, cameraForward.z],
    });
  }

  private updateLod(cameraPosition: Vector3, splatBuffers: SplatBuffers): void {
    const splatCount = splatBuffers.packed.centerScale.length / 4;
    if (!this.lodManager || splatCount <= this.renderBudget) {
      return; // Skip LOD dynamic updates when the full splat set fits in our rendering budget
    }
    this.lodFrame = (this.lodFrame + 1) % LOD_REBUILD_INTERVAL_FRAMES;
    const moved = Vector3.DistanceSquared(cameraPosition, this.lastLodCameraPosition) > LOD_CAMERA_POSITION_EPSILON;
    if (this.lodFrame !== 1 && !moved) {
      return;
    }

    const lodStart = performance.now();
    const { centers, indices, activeChunks, selectedLods } = this.lodManager.select({
      budget: this.renderBudget,
      cameraPosition,
      lodRangeMin: this.lodRangeMin,
      lodRangeMax: this.lodRangeMax,
      lodUnderfillLimit: this.lodUnderfillLimit,
    });
    this.lastLodBuildMs = performance.now() - lodStart;
    this.lastLodCameraPosition.copyFrom(cameraPosition);
    this.activeChunks = activeChunks;
    this.selectedLods = selectedLods;
    this.setRenderCount(indices.length);
    splatBuffers.storage?.indices.update(indices, 0, indices.byteLength);
    this.initializeSortWorker(splatBuffers, centers, indices);
  }

  private buildExpandedQuadGeometry(splatBuffers: SplatBuffers): void {
    const { centerScale, color } = splatBuffers.packed;
    const splatCount = centerScale.length / 4;
    const step = Math.max(1, Math.ceil(splatCount / this.renderBudget));
    const renderCount = Math.ceil(splatCount / step);
    const vertexCount = renderCount * 4;

    const positions = new Float32Array(vertexCount * 3);
    const corners = new Float32Array(vertexCount * 2);
    const colors = new Float32Array(vertexCount * 4);
    const scales = new Float32Array(vertexCount);
    const indices = new Uint32Array(renderCount * 6);
    const quadCorners = [-1, -1, 1, -1, 1, 1, -1, 1];

    for (let src = 0, dst = 0; src < splatCount; src += step, dst++) {
      const src4 = src * 4;
      const baseVertex = dst * 4;

      for (let cornerIndex = 0; cornerIndex < 4; cornerIndex++) {
        const vertex = baseVertex + cornerIndex;
        const positionOffset = vertex * 3;
        const cornerOffset = vertex * 2;
        const colorOffset = vertex * 4;

        positions[positionOffset + 0] = centerScale[src4 + 0];
        positions[positionOffset + 1] = centerScale[src4 + 1];
        positions[positionOffset + 2] = centerScale[src4 + 2];

        corners[cornerOffset + 0] = quadCorners[cornerIndex * 2 + 0];
        corners[cornerOffset + 1] = quadCorners[cornerIndex * 2 + 1];

        colors[colorOffset + 0] = color[src4 + 0];
        colors[colorOffset + 1] = color[src4 + 1];
        colors[colorOffset + 2] = color[src4 + 2];
        colors[colorOffset + 3] = color[src4 + 3];

        scales[vertex] = centerScale[src4 + 3];
      }

      const indexOffset = dst * 6;
      indices[indexOffset + 0] = baseVertex + 0;
      indices[indexOffset + 1] = baseVertex + 1;
      indices[indexOffset + 2] = baseVertex + 2;
      indices[indexOffset + 3] = baseVertex + 0;
      indices[indexOffset + 4] = baseVertex + 2;
      indices[indexOffset + 5] = baseVertex + 3;
    }

    this.mesh.setVerticesData("position", positions, false, 3);
    this.mesh.setVerticesData("corner", corners, false, 2);
    this.mesh.setVerticesData("splatColor", colors, false, 4);
    this.mesh.setVerticesData("splatScale", scales, false, 1);
    this.mesh.setIndices(indices);
    this.renderSplats = renderCount;
  }
}

export { SplatRenderPass };
export type { SplatRenderStats };
