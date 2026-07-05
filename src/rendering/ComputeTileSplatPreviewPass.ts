import type { StorageBuffer } from "@babylonjs/core/Buffers/storageBuffer";
import { Constants } from "@babylonjs/core/Engines/constants";
import { Vector2, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { Scene } from "@babylonjs/core/scene";

import type { ComputeTileStatsPass } from "./ComputeTileStatsPass";
import type { ComputeTileWorkQueuePass } from "./ComputeTileWorkQueuePass";
import ComputeTileSplatPreviewPass_FRAGMENT_SOURCE_raw from "./shaders/compute-tile-splat-preview-pass.fragment-source.wgsl?raw";
import ComputeTileSplatPreviewPass_CHAN_HELPERS_raw from "./shaders/compute-tile-splat-preview-pass.chan-helpers.wgsl?raw";

const DEFAULT_SPLAT_SAMPLES_PER_TILE = 32;
const DEFAULT_RASTER_SPLATS_PER_TILE = 128;
const MAX_SPLAT_SAMPLES_PER_TILE = 64;
const MAX_RASTER_SPLATS_PER_TILE = 512;
const DEFAULT_PREVIEW_TILE_LIMIT = 512;
const DEFAULT_RASTER_PREVIEW_WORK_ITEM_LIMIT = 4096;
const DEFAULT_RASTER_PREVIEW_WORK_ITEM_CAP = 16384;
const DEFAULT_FAST_RASTER_PREVIEW_DRAW_ITEMS = 1536;
const DEFAULT_BALANCED_RASTER_PREVIEW_DRAW_ITEMS = 2048;
const DEFAULT_QUALITY_RASTER_PREVIEW_DRAW_ITEMS = 1536;
const DEFAULT_FAST_RASTER_PREVIEW_MOTION_DRAW_ITEMS = 768;
const DEFAULT_BALANCED_RASTER_PREVIEW_MOTION_DRAW_ITEMS = 1024;
const DEFAULT_QUALITY_RASTER_PREVIEW_MOTION_DRAW_ITEMS = 1024;
const MOTION_DRAW_HOLD_FRAMES = 8;
const MOTION_DRAW_MOVE_EPSILON_SQ = 0.0025;
const MOTION_DRAW_FORWARD_DOT = 0.9995;
const ADAPTIVE_FRAME_TARGET_MS = 36;
const ADAPTIVE_FRAME_RECOVER_MS = 24;
const ADAPTIVE_MIN_DRAW_SCALE = 0.2;
const ADAPTIVE_DECAY = 0.75;
const ADAPTIVE_RECOVER = 1.1;
const STATIC_DRAW_RAMP_FRAMES = 12;
const DEFAULT_PREVIEW_NEAR_WINDOW_MARGIN = 0.35;
const DEFAULT_RASTER_SAMPLE_ALPHA_COMPENSATION = 1.6;
const MAX_RASTER_SAMPLE_PASSES = 4;
const MAX_RASTER_FULL_SAMPLE_PASSES = 16;

type RasterCoverageMode = "sampled" | "full";

const isRasterPreviewRequested = (params = new URLSearchParams(window.location.search)): boolean =>
  params.get("computeTileRasterPreview") === "true" || params.get("renderer") === "compute";

const getRasterPreviewQuality = (): "fast" | "balanced" | "quality" => {
  const value = new URLSearchParams(window.location.search).get("computeTileRasterQuality");
  return value === "fast" || value === "quality" ? value : "balanced";
};

const getDefaultRasterPreviewWorkItemCap = (): number => {
  const quality = getRasterPreviewQuality();
  if (quality === "fast") {
    return 8192;
  }
  if (quality === "quality") {
    return 16384;
  }
  return DEFAULT_RASTER_PREVIEW_WORK_ITEM_CAP;
};

const getDefaultRasterSamplesPerTile = (): number => {
  const quality = getRasterPreviewQuality();
  if (quality === "fast") {
    return 192;
  }
  if (quality === "quality") {
    return 64;
  }
  return DEFAULT_RASTER_SPLATS_PER_TILE;
};

const getRasterPreviewWorkItemCap = (): number => {
  const value = Number(new URLSearchParams(window.location.search).get("computeTileRasterWorkItemCap"));
  if (!Number.isFinite(value) || value <= 0) {
    return getDefaultRasterPreviewWorkItemCap();
  }
  return Math.max(1, Math.floor(value));
};

const getDefaultRasterPreviewDrawItems = (): number => {
  const quality = getRasterPreviewQuality();
  if (quality === "fast") {
    return DEFAULT_FAST_RASTER_PREVIEW_DRAW_ITEMS;
  }
  if (quality === "quality") {
    return DEFAULT_QUALITY_RASTER_PREVIEW_DRAW_ITEMS;
  }
  return DEFAULT_BALANCED_RASTER_PREVIEW_DRAW_ITEMS;
};

const getDefaultRasterPreviewMotionDrawItems = (): number => {
  const quality = getRasterPreviewQuality();
  if (quality === "fast") {
    return DEFAULT_FAST_RASTER_PREVIEW_MOTION_DRAW_ITEMS;
  }
  if (quality === "quality") {
    return DEFAULT_QUALITY_RASTER_PREVIEW_MOTION_DRAW_ITEMS;
  }
  return DEFAULT_BALANCED_RASTER_PREVIEW_MOTION_DRAW_ITEMS;
};

const hasExplicitPreviewTileLimit = (): boolean => {
  const value = Number(new URLSearchParams(window.location.search).get("computeTilePreviewTileLimit"));
  return Number.isFinite(value) && value > 0;
};

const getRasterPreviewMotionDrawItems = (previewTileLimit: number): number => {
  const params = new URLSearchParams(window.location.search);
  if (params.get("computeTilePreviewMotionDraw") === "false") {
    return previewTileLimit;
  }
  const value = Number(params.get("computeTilePreviewMotionTileLimit"));
  if (Number.isFinite(value) && value > 0) {
    return Math.min(previewTileLimit, Math.max(1, Math.floor(value)));
  }
  return Math.min(previewTileLimit, getDefaultRasterPreviewMotionDrawItems());
};

const isAdaptivePreviewDrawEnabled = (): boolean =>
  new URLSearchParams(window.location.search).get("computeTilePreviewAdaptiveDraw") !== "false";

const getAdaptivePreviewFrameTargetMs = (): number => {
  const value = Number(new URLSearchParams(window.location.search).get("computeTilePreviewAdaptiveFrameMs"));
  return Number.isFinite(value) && value > 0 ? Math.max(8, value) : ADAPTIVE_FRAME_TARGET_MS;
};

const getAdaptivePreviewRecoverMs = (targetMs: number): number => {
  const value = Number(new URLSearchParams(window.location.search).get("computeTilePreviewAdaptiveRecoverMs"));
  return Number.isFinite(value) && value > 0 ? Math.min(targetMs, Math.max(4, value)) : ADAPTIVE_FRAME_RECOVER_MS;
};

const getAdaptivePreviewMinScale = (): number => {
  const value = Number(new URLSearchParams(window.location.search).get("computeTilePreviewAdaptiveMinScale"));
  return Number.isFinite(value) && value > 0 ? Math.min(1, Math.max(0.1, value)) : ADAPTIVE_MIN_DRAW_SCALE;
};

const getStaticDrawRampFrames = (): number => {
  const value = Number(new URLSearchParams(window.location.search).get("computeTilePreviewStaticRampFrames"));
  if (!Number.isFinite(value) || value < 0) {
    return STATIC_DRAW_RAMP_FRAMES;
  }
  return Math.min(120, Math.floor(value));
};

const getDefaultRasterDrawCoverageTarget = (): number => {
  const quality = getRasterPreviewQuality();
  if (quality === "fast") {
    return 0.3;
  }
  if (quality === "quality") {
    return 0.55;
  }
  return 0.45;
};

const getRasterDrawCoverageTarget = (): number => {
  const params = new URLSearchParams(window.location.search);
  if (params.get("computeTileRasterDrawCoverage") === "false") {
    return 0;
  }
  const value = Number(params.get("computeTileRasterDrawCoverageTarget"));
  if (Number.isFinite(value) && value > 0) {
    return Math.min(1, Math.max(0.05, value));
  }
  return getDefaultRasterDrawCoverageTarget();
};

const getDefaultRasterMotionDrawCoverageTarget = (): number => {
  const quality = getRasterPreviewQuality();
  if (quality === "fast") {
    return 0.15;
  }
  if (quality === "quality") {
    return 0.3;
  }
  return 0.2;
};

const getRasterMotionDrawCoverageTarget = (staticTarget: number): number => {
  const params = new URLSearchParams(window.location.search);
  if (staticTarget <= 0 || params.get("computeTileRasterDrawCoverage") === "false") {
    return 0;
  }
  const value = Number(params.get("computeTileRasterMotionDrawCoverageTarget"));
  if (Number.isFinite(value) && value > 0) {
    return Math.min(staticTarget, Math.max(0.05, value));
  }
  return Math.min(staticTarget, getDefaultRasterMotionDrawCoverageTarget());
};

const getDefaultRasterMaxMarkerPixels = (): number => {
  const quality = getRasterPreviewQuality();
  if (quality === "fast") {
    return 32;
  }
  if (quality === "quality") {
    return 48;
  }
  return 40;
};

const getRasterMaxMarkerPixels = (fallback: number): number => {
  const params = new URLSearchParams(window.location.search);
  const value = Number(params.get("computeTileRasterMaxMarkerPixels"));
  if (Number.isFinite(value) && value > 0) {
    return Math.min(fallback, Math.max(8, value));
  }
  if (isRasterPreviewRequested(params)) {
    return Math.min(fallback, getDefaultRasterMaxMarkerPixels());
  }
  return fallback;
};

const isRasterPreviewMotionMarkerEnabled = (): boolean => {
  const params = new URLSearchParams(window.location.search);
  const value = params.get("computeTileRasterMotionShape");
  if (value === "gaussian" || value === "false" || value === "off") {
    return false;
  }
  if (value === "marker" || value === "true") {
    return true;
  }
  return false;
};

type ComputeTilePreviewColorMode = "asset" | "debug" | "opacity" | "depth";

type ComputeTileSplatPreviewStats = {
  enabled: boolean;
  samplesPerTile: number;
  previewSplats: number;
  windowSplats: number;
  sampledCoverage: number;
  windowCoverage: number;
  activeTiles: number;
  workTiles: number;
  drawLimit: number;
  requestedDrawLimit: number;
  staticDrawLimit: number;
  motionDrawLimit: number;
  adaptiveDrawScale: number;
  smoothedFrameMs: number;
  maxMarkerPixels: number;
  staticRamp: number;
  colorMode: ComputeTilePreviewColorMode;
  shapeMode: "gaussian" | "marker";
  orderMode: "source" | "depth-bucket";
  coverageMode: "sampled" | "bounded";
  rasterCoverageMode: RasterCoverageMode;
  truncatedSplats: number;
  drawOrder: "coverage" | "far" | "near";
  windowMode: "sampled" | "full";
  nearWindowMargin: number;
  sampleAlphaCompensation: number;
  runtimeSampleAlphaCompensation: number;
  samplePasses: number;
  maxUsefulSamplePasses: number;
  staticSamplePasses: number;
  motionSamplePasses: number;
  sampleCoverageTarget: number;
  motionSampleCoverageTarget: number;
  runtimeSampleCoverageTarget: number;
  samplePassesAdaptive: boolean;
  drawCoverageTarget: number;
  motionDrawCoverageTarget: number;
  runtimeDrawCoverageTarget: number;
  drawCoverageAdaptive: boolean;
};

type ComputeTileSplatPreviewOptions = {
  centerBuffer: StorageBuffer;
  sogCenterOffset?: number;
  tileSplatListBuffer?: StorageBuffer;
  sogChunkInfoBuffer?: StorageBuffer;
  scaleBuffer?: StorageBuffer;
  rotationBuffer?: StorageBuffer;
  colorBuffer?: StorageBuffer;
  sogQuatBuffer?: StorageBuffer;
  sogScalesBuffer?: StorageBuffer;
  sogQuatOffset?: number;
  sogScalesOffset?: number;
  sogScaleCodebookBuffer?: StorageBuffer;
  sogScaleCodebookOffset?: number;
  splatRadiusScale?: number;
  coverageMode?: "sampled" | "bounded";
  shapeMode?: "gaussian" | "marker";
  alphaMode?: "preview" | "splat";
  maxMarkerPixels?: number;
};

const getSamplesPerTile = (): number => {
  const params = new URLSearchParams(window.location.search);
  const rasterValue = Number(params.get("computeTileRasterMaxSplatsPerTile"));
  if (isRasterPreviewRequested(params)) {
    if (Number.isFinite(rasterValue) && rasterValue > 0) {
      return Math.min(MAX_RASTER_SPLATS_PER_TILE, Math.max(1, Math.floor(rasterValue)));
    }
    return getDefaultRasterSamplesPerTile();
  }

  const value = Number(params.get("computeTileSplatSamples"));
  if (!Number.isFinite(value) || value <= 0) {
    return DEFAULT_SPLAT_SAMPLES_PER_TILE;
  }
  return Math.min(MAX_SPLAT_SAMPLES_PER_TILE, Math.max(1, Math.floor(value)));
};

const getPreviewTileLimit = (): number => {
  const params = new URLSearchParams(window.location.search);
  const value = Number(params.get("computeTilePreviewTileLimit"));
  if (!Number.isFinite(value) || value <= 0) {
    if (params.get("computeTileWorkQueueOrder") === "depth-band") {
      const workItemValue = Number(params.get("computeTileRasterWorkItems"));
      if (Number.isFinite(workItemValue) && workItemValue > 0) {
        return Math.min(Math.max(1, Math.floor(workItemValue)), getDefaultRasterPreviewDrawItems());
      }
      return Math.min(getRasterPreviewWorkItemCap(), getDefaultRasterPreviewDrawItems());
    }
    if (params.get("computeTileRasterBatch") === "true") {
      const workItemValue = Number(params.get("computeTileRasterWorkItems"));
      if (Number.isFinite(workItemValue) && workItemValue > 0) {
        return Math.min(Math.max(1, Math.floor(workItemValue)), getDefaultRasterPreviewDrawItems());
      }
      return Math.min(DEFAULT_RASTER_PREVIEW_WORK_ITEM_LIMIT, getDefaultRasterPreviewDrawItems());
    }
    return DEFAULT_PREVIEW_TILE_LIMIT;
  }
  return Math.max(1, Math.floor(value));
};

const getPreviewDrawOrder = (): "coverage" | "far" | "near" => {
  const params = new URLSearchParams(window.location.search);
  const value = params.get("computeTileRasterPreviewDrawOrder");
  if (value === "coverage" || value === "far" || value === "near") {
    return value;
  }
  if (isRasterPreviewRequested(params)) {
    return "near";
  }
  return "far";
};

const getPreviewWindowMode = (): "sampled" | "full" => {
  const params = new URLSearchParams(window.location.search);
  const value = params.get("computeTileRasterPreviewWindowMode");
  if (value === "sampled" || value === "full") {
    return value;
  }
  if (isRasterPreviewRequested(params) && getRasterPreviewQuality() !== "fast") {
    return "full";
  }
  return "sampled";
};

const getRasterCoverageMode = (): RasterCoverageMode => {
  const params = new URLSearchParams(window.location.search);
  const value = params.get("computeTileRasterCoverageMode");
  if (value === "sampled" || value === "full") {
    return value;
  }
  if (isRasterPreviewRequested(params) && getRasterPreviewQuality() !== "fast") {
    return "full";
  }
  return "sampled";
};

const getPreviewNearWindowMargin = (): number => {
  const value = Number(new URLSearchParams(window.location.search).get("computeTileRasterPreviewNearWindowMargin"));
  if (!Number.isFinite(value) || value < 0) {
    return DEFAULT_PREVIEW_NEAR_WINDOW_MARGIN;
  }
  return Math.min(2, Math.max(0, value));
};

const getRasterSampleAlphaCompensation = (): number => {
  const params = new URLSearchParams(window.location.search);
  if (params.get("computeTileRasterAdaptiveAlphaCompensation") === "false") {
    return 1;
  }
  const value = Number(params.get("computeTileRasterSampleAlphaCompensation"));
  if (Number.isFinite(value) && value > 0) {
    return Math.min(4, Math.max(1, value));
  }
  return isRasterPreviewRequested(params) ? DEFAULT_RASTER_SAMPLE_ALPHA_COMPENSATION : 1;
};

const getDefaultRasterSamplePasses = (): number => (getRasterPreviewQuality() === "quality" ? 2 : 1);

const getRasterSamplePasses = (): number => {
  const value = Number(new URLSearchParams(window.location.search).get("computeTileRasterSamplePasses"));
  if (!Number.isFinite(value) || value <= 0) {
    return getDefaultRasterSamplePasses();
  }
  return Math.min(MAX_RASTER_SAMPLE_PASSES, Math.max(1, Math.floor(value)));
};

const getRasterMotionSamplePasses = (samplePasses: number): number => {
  const value = Number(new URLSearchParams(window.location.search).get("computeTileRasterMotionSamplePasses"));
  if (Number.isFinite(value) && value > 0) {
    return Math.min(samplePasses, Math.max(1, Math.floor(value)));
  }
  return 1;
};

const getDefaultRasterSampleCoverageTarget = (): number => {
  const quality = getRasterPreviewQuality();
  if (quality === "fast") {
    return 0.25;
  }
  if (quality === "quality") {
    return 0.5;
  }
  return 0.35;
};

const getRasterSampleCoverageTarget = (): number => {
  const params = new URLSearchParams(window.location.search);
  if (params.get("computeTileRasterSampleCoverage") === "false") {
    return 1;
  }
  const value = Number(params.get("computeTileRasterSampleCoverageTarget"));
  if (Number.isFinite(value) && value > 0) {
    return Math.min(1, Math.max(0.05, value));
  }
  return getDefaultRasterSampleCoverageTarget();
};

const getDefaultRasterMotionSampleCoverageTarget = (): number => {
  const quality = getRasterPreviewQuality();
  if (quality === "fast") {
    return 0.15;
  }
  if (quality === "quality") {
    return 0.25;
  }
  return 0.2;
};

const getRasterMotionSampleCoverageTarget = (staticTarget: number): number => {
  const params = new URLSearchParams(window.location.search);
  if (params.get("computeTileRasterSampleCoverage") === "false") {
    return staticTarget;
  }
  const value = Number(params.get("computeTileRasterMotionSampleCoverageTarget"));
  if (Number.isFinite(value) && value > 0) {
    return Math.min(staticTarget, Math.max(0.05, value));
  }
  return Math.min(staticTarget, getDefaultRasterMotionSampleCoverageTarget());
};

const getColorMode = (): ComputeTilePreviewColorMode => {
  const value = new URLSearchParams(window.location.search).get("computeTileSplatColor");
  if (value === "debug" || value === "opacity" || value === "depth") {
    return value;
  }
  return "asset";
};

const getShapeMode = (): "gaussian" | "marker" =>
  new URLSearchParams(window.location.search).get("computeTileSplatShape") === "gaussian" ? "gaussian" : "marker";

const getAlphaScale = (): number => {
  const params = new URLSearchParams(window.location.search);
  const rasterValue = Number(params.get("computeTileRasterAlphaScale"));
  if (isRasterPreviewRequested(params) && Number.isFinite(rasterValue) && rasterValue > 0) {
    return Math.min(2.0, Math.max(0.02, rasterValue));
  }
  const value = Number(params.get("computeTileSplatAlphaScale"));
  if (!Number.isFinite(value) || value <= 0) {
    return 1.0;
  }
  return Math.min(2.0, Math.max(0.02, value));
};

const chanHelpers = ComputeTileSplatPreviewPass_CHAN_HELPERS_raw;

const getVertexSource = (
  mode: "expanded" | "sog" | "globalSog" | "debug",
  shape: "gaussian" | "marker",
  colorMode: ComputeTilePreviewColorMode,
) => `
attribute position: vec3f;

${mode === "sog" || mode === "globalSog" ? chanHelpers : ""}

uniform worldViewProjection: mat4x4f;
uniform world: mat4x4f;
uniform view: mat4x4f;
uniform projection: mat4x4f;
uniform viewport: vec2f;
uniform workTileCount: f32;
uniform workSourceTileCount: f32;
uniform workSourceTileOffset: f32;
uniform maxTileSplats: f32;
uniform markerPixels: f32;
uniform samplesPerTile: f32;
uniform coverageMode: f32;
uniform splatRadiusScale: f32;
uniform maxMarkerPixels: f32;
uniform useGaussianShape: f32;
  uniform sampleAlphaCompensation: f32;
  uniform samplePassCount: f32;
  uniform sogCenterOffset: f32;
  uniform sogQuatOffset: f32;
  uniform sogScalesOffset: f32;
  uniform sogScaleCodebookOffset: f32;

var<storage, read> centerBuffer: array<vec4f>;
var<storage, read> tileSplatList: array<u32>;
var<storage, read> workQueue: array<vec4u>;
${mode === "expanded" || mode === "sog" ? "var<storage, read> colorBuffer: array<vec4f>;" : ""}
${mode === "globalSog" ? "var<storage, read> colorBuffer: array<vec4f>;" : ""}
${shape === "gaussian" && mode === "expanded" ? "var<storage, read> scaleBuffer: array<vec4f>;" : ""}
${shape === "gaussian" && mode === "expanded" ? "var<storage, read> rotationBuffer: array<vec4f>;" : ""}
${shape === "gaussian" && (mode === "sog" || mode === "globalSog") ? "var<storage, read> quatsBuffer: array<u32>;" : ""}
${mode === "sog" || mode === "globalSog" ? "var<storage, read> scalesBuffer: array<u32>;" : ""}
${mode === "sog" || mode === "globalSog" ? "var<storage, read> scaleCodebookBuffer: array<f32>;" : ""}
${mode === "globalSog" ? "var<storage, read> chunkInfoBuffer: array<vec4f>;" : ""}

varying vIntensity: f32;
varying vSampleT: f32;
varying vCorner: vec2f;
varying vColor: vec4f;
varying vCoverageAlpha: f32;

const SH_C0: f32 = 0.28209479177387814;
const SQRT2: f32 = 1.4142135623730951;

fn debugColor(intensity: f32, sampleT: f32) -> vec4f {
  let cool = vec3f(0.1, 0.9, 1.0);
  let warm = vec3f(1.0, 0.18, 0.04);
  let sampleTint = vec3f(0.5 + sampleT * 0.5, 0.9 - sampleT * 0.5, 1.0);
  return vec4f((cool * (1.0 - intensity) + warm * intensity) * sampleTint, 0.55 + intensity * 0.35);
}

fn depthColor(depth: f32) -> vec4f {
  let t = clamp(depth / 48.0, 0.0, 1.0);
  let nearColor = vec3f(1.0, 0.78, 0.15);
  let farColor = vec3f(0.05, 0.45, 1.0);
  return vec4f(nearColor * (1.0 - t) + farColor * t, 0.75);
}

fn decodeAssetColor(index: u32, intensity: f32, sampleT: f32) -> vec4f {
${colorMode === "debug" ? "  return debugColor(intensity, sampleT);" : ""}
${colorMode === "opacity" && (mode === "expanded" || mode === "sog" || mode === "globalSog") ? "  let asset = colorBuffer[index]; return vec4f(vec3f(clamp(asset.a, 0.0, 1.0)), asset.a);" : ""}
${colorMode === "asset" && (mode === "expanded" || mode === "sog" || mode === "globalSog") ? "  return colorBuffer[index];" : ""}
${(colorMode === "depth" || (colorMode === "opacity" && mode === "debug") || (colorMode === "asset" && mode === "debug")) ? "  return debugColor(intensity, sampleT);" : ""}
}

fn sourceIndex(splatEntry: u32) -> u32 {
${mode === "globalSog" ? `  let chunk = splatEntry >> 24u;
  let local = splatEntry & 16777215u;
  return u32(chunkInfoBuffer[chunk * 2u].w) + local;` : ""}
${mode !== "globalSog" ? "  return splatEntry;" : ""}
}

fn centerBufferIndex(splatEntry: u32) -> u32 {
${mode === "globalSog" ? "  return sourceIndex(splatEntry);" : ""}
${mode !== "globalSog" ? "  return u32(uniforms.sogCenterOffset) + splatEntry;" : ""}
}

fn scaleCodebookOffset(splatEntry: u32) -> u32 {
${mode === "globalSog" ? `  let chunk = splatEntry >> 24u;
  return u32(chunkInfoBuffer[chunk * 2u + 1u].w);` : ""}
${mode !== "globalSog" ? "  return u32(uniforms.sogScaleCodebookOffset);" : ""}
}

fn quatBufferIndex(index: u32) -> u32 {
${mode === "globalSog" ? "  return index;" : ""}
${mode !== "globalSog" ? "  return u32(uniforms.sogQuatOffset) + index;" : ""}
}

fn scalesBufferIndex(index: u32) -> u32 {
${mode === "globalSog" ? "  return index;" : ""}
${mode !== "globalSog" ? "  return u32(uniforms.sogScalesOffset) + index;" : ""}
}

fn decodeLogRadius(index: u32, fallback: f32, splatEntry: u32) -> f32 {
${mode === "sog" || mode === "globalSog" ? `  let pixel = scalesBuffer[scalesBufferIndex(index)];
  let scaleOffset = scaleCodebookOffset(splatEntry);
  return max(
    max(scaleCodebookBuffer[scaleOffset + chan(pixel, 0u)], scaleCodebookBuffer[scaleOffset + chan(pixel, 1u)]),
    scaleCodebookBuffer[scaleOffset + chan(pixel, 2u)]
  );` : ""}
${mode !== "sog" && mode !== "globalSog" ? "  return fallback;" : ""}
}

${shape === "gaussian" ? `fn decodeScale(index: u32, fallback: f32, splatEntry: u32) -> vec3f {
${mode === "expanded" ? "  return exp(scaleBuffer[index].xyz);" : ""}
${mode === "sog" || mode === "globalSog" ? `  let pixel = scalesBuffer[scalesBufferIndex(index)];
  let scaleOffset = scaleCodebookOffset(splatEntry);
  return exp(vec3f(
    scaleCodebookBuffer[scaleOffset + chan(pixel, 0u)],
    scaleCodebookBuffer[scaleOffset + chan(pixel, 1u)],
    scaleCodebookBuffer[scaleOffset + chan(pixel, 2u)]
  ));` : ""}
${mode === "debug" ? "  let scale = exp(fallback); return vec3f(scale);" : ""}
}

fn decodeRotation(index: u32) -> vec4f {
${mode === "expanded" ? "  return normalize(rotationBuffer[index]);" : ""}
${mode === "sog" || mode === "globalSog" ? `  let pixel = quatsBuffer[quatBufferIndex(index)];
  let a = (chanf(pixel, 0u) / 255.0 - 0.5) * SQRT2;
  let b = (chanf(pixel, 1u) / 255.0 - 0.5) * SQRT2;
  let c = (chanf(pixel, 2u) / 255.0 - 0.5) * SQRT2;
  let d = sqrt(max(0.0, 1.0 - (a * a + b * b + c * c)));
  let quatMode = chan(pixel, 3u) - 252u;
  if (quatMode == 0u) {
    return vec4f(d, a, b, c);
  }
  if (quatMode == 1u) {
    return vec4f(a, d, b, c);
  }
  if (quatMode == 2u) {
    return vec4f(a, b, d, c);
  }
  return vec4f(a, b, c, d);` : ""}
${mode === "debug" ? "  return vec4f(1.0, 0.0, 0.0, 0.0);" : ""}
}

fn initCornerCov(center: vec3f, rotation: vec4f, scale: vec3f, corner: vec2f, centerClip: vec4f, markerClip: vec2f) -> vec4f {
  let centerView = (uniforms.view * uniforms.world) * vec4f(center, 1.0);
  if (uniforms.projection[3][3] != 1.0 && centerView.z <= 0.0) {
    return vec4f(0.0, 0.0, 2.0, 1.0);
  }
  let centerClipClamped = vec4f(centerClip.xy, clamp(centerClip.z, 0.0, abs(centerClip.w)), centerClip.w);

  let w = rotation.x;
  let x = rotation.y;
  let y = rotation.z;
  let z = rotation.w;
  let R = mat3x3f(
    vec3f(1.0 - 2.0 * (y * y + z * z), 2.0 * (x * y + w * z), 2.0 * (x * z - w * y)),
    vec3f(2.0 * (x * y - w * z), 1.0 - 2.0 * (x * x + z * z), 2.0 * (y * z + w * x)),
    vec3f(2.0 * (x * z + w * y), 2.0 * (y * z - w * x), 1.0 - 2.0 * (x * x + y * y))
  );
  let M = mat3x3f(R[0] * scale.x, R[1] * scale.y, R[2] * scale.z);
  let Vrk = M * transpose(M);
  let modelView = uniforms.view * uniforms.world;
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
  let l1 = min(uniforms.maxMarkerPixels, 2.0 * min(sqrt(2.0 * lambda1), vmin));
  let l2 = min(uniforms.maxMarkerPixels, 2.0 * min(sqrt(2.0 * lambda2), vmin));
  let maxL = max(max(l1, l2), uniforms.markerPixels);
  if (maxL <= uniforms.markerPixels + 0.001) {
    return vec4f(centerClipClamped.xy + markerClip, centerClipClamped.zw);
  }
  let c = centerClipClamped.w / uniforms.viewport;
  let diagonalVector = normalize(vec2f(offDiagonal, lambda1 - diagonal1));
  let v1 = max(uniforms.markerPixels, l1) * diagonalVector;
  let v2 = max(uniforms.markerPixels, l2) * vec2f(diagonalVector.y, -diagonalVector.x);
  let offset = (corner.x * v1 + corner.y * v2) * c;
  return vec4f(centerClipClamped.xy + offset, centerClipClamped.zw);
}` : ""}

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
  let passCount = max(1u, u32(uniforms.samplePassCount));
  let workInstanceIndex = vertexInputs.instanceIndex / passCount;
  let samplePassIndex = vertexInputs.instanceIndex - workInstanceIndex * passCount;
  let sourceCount = max(1u, u32(uniforms.workSourceTileCount));
  let workSlot = min(
    sourceCount - 1u,
    u32((f32(workInstanceIndex) + 0.5) * max(1.0, uniforms.workSourceTileCount) / max(1.0, uniforms.workTileCount))
  ) + u32(max(0.0, uniforms.workSourceTileOffset));
  let sampleSlot = u32(vertexInputs.position.z);
  let corner = vertexInputs.position.xy;
  if (f32(workSlot) >= uniforms.workSourceTileOffset + uniforms.workSourceTileCount) {
    vertexOutputs.position = vec4f(0.0, 0.0, 2.0, 1.0);
    vertexOutputs.vIntensity = 0.0;
    vertexOutputs.vSampleT = 0.0;
    vertexOutputs.vCorner = vec2f(2.0);
    vertexOutputs.vColor = vec4f(0.0);
    vertexOutputs.vCoverageAlpha = 1.0;
    return vertexOutputs;
  }

  let entry = workQueue[workSlot];
  let tileOffset = entry.y;
  let tileCount = entry.z;
  if (tileCount == 0u) {
    vertexOutputs.position = vec4f(0.0, 0.0, 2.0, 1.0);
    vertexOutputs.vIntensity = 0.0;
    vertexOutputs.vSampleT = 0.0;
    vertexOutputs.vCorner = vec2f(2.0);
    vertexOutputs.vColor = vec4f(0.0);
    vertexOutputs.vCoverageAlpha = 1.0;
    return vertexOutputs;
  }

  let sampleCount = max(1u, u32(uniforms.samplesPerTile));
  let sampleIndex = sampleSlot + samplePassIndex * sampleCount;
  if (uniforms.coverageMode >= 0.5 && sampleIndex >= tileCount) {
    vertexOutputs.position = vec4f(0.0, 0.0, 2.0, 1.0);
    vertexOutputs.vIntensity = 0.0;
    vertexOutputs.vSampleT = 0.0;
    vertexOutputs.vCorner = vec2f(2.0);
    vertexOutputs.vColor = vec4f(0.0);
    vertexOutputs.vCoverageAlpha = 1.0;
    return vertexOutputs;
  }
  let totalSampleCount = max(1u, sampleCount * passCount);
  let drawnSampleCount = max(1u, min(totalSampleCount, tileCount));
  let coverageAlpha = min(max(1.0, uniforms.sampleAlphaCompensation), max(1.0, f32(tileCount) / f32(drawnSampleCount)));
  let local = select(
    min(tileCount - 1u, (sampleIndex * max(1u, tileCount)) / totalSampleCount),
    min(tileCount - 1u, sampleIndex),
    uniforms.coverageMode >= 0.5
  );
  let splatEntry = tileSplatList[tileOffset + local];
  let splatIndex = sourceIndex(splatEntry);
  let centerAndScale = centerBuffer[centerBufferIndex(splatEntry)];
  let clip = uniforms.worldViewProjection * vec4f(centerAndScale.xyz, 1.0);
  if (clip.w <= 0.000001) {
    vertexOutputs.position = vec4f(0.0, 0.0, 2.0, 1.0);
    vertexOutputs.vIntensity = 0.0;
    vertexOutputs.vSampleT = 0.0;
    vertexOutputs.vCorner = vec2f(2.0);
    vertexOutputs.vColor = vec4f(0.0);
    vertexOutputs.vCoverageAlpha = 1.0;
    return vertexOutputs;
  }

  let pixelSize = vec2f(2.0 / max(1.0, uniforms.viewport.x), 2.0 / max(1.0, uniforms.viewport.y));
  let logRadius = decodeLogRadius(splatIndex, centerAndScale.w, splatEntry);
  let pixelRadius = clamp(exp(logRadius) * uniforms.splatRadiusScale, uniforms.markerPixels, uniforms.maxMarkerPixels);
  let marker = pixelSize * pixelRadius * clip.w;
  let intensity = clamp(log2(f32(tileCount) + 1.0) / log2(max(2.0, uniforms.maxTileSplats + 1.0)), 0.0, 1.0);
  let sampleT = f32(sampleSlot) / f32(max(1u, sampleCount - 1u));
${shape === "gaussian" ? `  if (uniforms.useGaussianShape < 0.5) {
    vertexOutputs.position = vec4f(clip.xy + corner * marker, clip.zw);
  } else {
  let scale = decodeScale(splatIndex, centerAndScale.w, splatEntry) * uniforms.splatRadiusScale;
  let rotation = decodeRotation(splatIndex);
  vertexOutputs.position = initCornerCov(centerAndScale.xyz, rotation, scale, corner, clip, corner * marker);
  }` : "  vertexOutputs.position = vec4f(clip.xy + corner * marker, clip.zw);"}
  vertexOutputs.vIntensity = intensity;
  vertexOutputs.vSampleT = sampleT;
  vertexOutputs.vCorner = corner;
  vertexOutputs.vColor = ${colorMode === "depth" ? "depthColor(clip.w)" : "decodeAssetColor(splatIndex, intensity, sampleT)"};
  vertexOutputs.vCoverageAlpha = coverageAlpha;
}
`;

const FRAGMENT_SOURCE = ComputeTileSplatPreviewPass_FRAGMENT_SOURCE_raw;

const isEnabled = (): boolean =>
  new URLSearchParams(window.location.search).get("computeTileSplatPreview") === "true";

class ComputeTileSplatPreviewPass {
  private readonly mesh: Mesh;
  private readonly material: ShaderMaterial;
  private readonly viewport = new Vector2(1, 1);
  private readonly samplesPerTile = getSamplesPerTile();
  private readonly previewTileLimit = getPreviewTileLimit();
  private readonly explicitPreviewTileLimit = hasExplicitPreviewTileLimit();
  private readonly motionPreviewTileLimit = getRasterPreviewMotionDrawItems(this.previewTileLimit);
  private readonly adaptivePreviewDrawEnabled = isAdaptivePreviewDrawEnabled();
  private readonly adaptiveFrameTargetMs = getAdaptivePreviewFrameTargetMs();
  private readonly adaptiveFrameRecoverMs = getAdaptivePreviewRecoverMs(this.adaptiveFrameTargetMs);
  private readonly adaptiveMinDrawScale = getAdaptivePreviewMinScale();
  private readonly staticDrawRampFrames = getStaticDrawRampFrames();
  private readonly colorMode: ComputeTilePreviewColorMode = getColorMode();
  private readonly shapeMode: "gaussian" | "marker";
  private readonly orderMode: "source" | "depth-bucket";
  private readonly coverageMode: "sampled" | "bounded";
  private readonly rasterCoverageMode = getRasterCoverageMode();
  private readonly alphaMode: "preview" | "splat";
  private readonly alphaScale = getAlphaScale();
  private readonly previewDrawOrder = getPreviewDrawOrder();
  private readonly previewWindowMode = getPreviewWindowMode();
  private readonly previewNearWindowMargin = getPreviewNearWindowMargin();
  private readonly sampleAlphaCompensation = getRasterSampleAlphaCompensation();
  private readonly drawCoverageTarget = getRasterDrawCoverageTarget();
  private readonly motionDrawCoverageTarget = getRasterMotionDrawCoverageTarget(this.drawCoverageTarget);
  private readonly staticSamplePasses = getRasterSamplePasses();
  private readonly motionSamplePasses = getRasterMotionSamplePasses(this.staticSamplePasses);
  private readonly sampleCoverageTarget = getRasterSampleCoverageTarget();
  private readonly motionSampleCoverageTarget = getRasterMotionSampleCoverageTarget(this.sampleCoverageTarget);
  private readonly motionMarkerEnabled = isRasterPreviewMotionMarkerEnabled();
  private readonly lastMotionCameraPosition = new Vector3(Number.POSITIVE_INFINITY, 0, 0);
  private readonly lastMotionCameraForward = new Vector3(0, 0, 0);
  private motionDrawFrames = 0;
  private staticRampFrame = this.staticDrawRampFrames;
  private wasMotionLimited = false;
  private adaptiveDrawScale = 1;
  private lastAdaptiveFrameTime = 0;
  private smoothedFrameMs = 0;
  private maxMarkerPixels = 0;
  private enabled = true;
  private stats: ComputeTileSplatPreviewStats = {
    enabled: true,
    samplesPerTile: this.samplesPerTile,
    previewSplats: 0,
    windowSplats: 0,
    sampledCoverage: 0,
    windowCoverage: 0,
    activeTiles: 0,
    workTiles: 0,
    drawLimit: this.previewTileLimit,
    requestedDrawLimit: this.previewTileLimit,
    staticDrawLimit: this.previewTileLimit,
    motionDrawLimit: this.motionPreviewTileLimit,
    adaptiveDrawScale: 1,
    smoothedFrameMs: 0,
    maxMarkerPixels: 0,
    staticRamp: 1,
    colorMode: this.colorMode,
    shapeMode: "marker",
    orderMode: "source",
    coverageMode: "sampled",
    rasterCoverageMode: this.rasterCoverageMode,
    truncatedSplats: 0,
    drawOrder: this.previewDrawOrder,
    windowMode: this.previewWindowMode,
    nearWindowMargin: this.previewNearWindowMargin,
    sampleAlphaCompensation: this.sampleAlphaCompensation,
    runtimeSampleAlphaCompensation: this.sampleAlphaCompensation,
    samplePasses: this.staticSamplePasses,
    maxUsefulSamplePasses: this.staticSamplePasses,
    staticSamplePasses: this.staticSamplePasses,
    motionSamplePasses: this.motionSamplePasses,
    sampleCoverageTarget: this.sampleCoverageTarget,
    motionSampleCoverageTarget: this.motionSampleCoverageTarget,
    runtimeSampleCoverageTarget: this.sampleCoverageTarget,
    samplePassesAdaptive: true,
    drawCoverageTarget: this.drawCoverageTarget,
    motionDrawCoverageTarget: this.motionDrawCoverageTarget,
    runtimeDrawCoverageTarget: this.drawCoverageTarget,
    drawCoverageAdaptive: this.drawCoverageTarget > 0,
  };

  constructor(
    private readonly scene: Scene,
    options: ComputeTileSplatPreviewOptions,
    private readonly tileStatsPass: ComputeTileStatsPass,
    private readonly workQueuePass: ComputeTileWorkQueuePass,
  ) {
    this.orderMode = options.tileSplatListBuffer ? "depth-bucket" : "source";
    this.coverageMode = options.coverageMode ?? "sampled";
    this.shapeMode = options.shapeMode ?? getShapeMode();
    this.alphaMode = options.alphaMode ?? "preview";
    const shaderMode =
      options.sogChunkInfoBuffer &&
            options.sogQuatBuffer &&
            options.colorBuffer &&
            options.sogScalesBuffer &&
            options.sogScaleCodebookBuffer
          ? "globalSog"
          : options.sogQuatBuffer &&
            options.colorBuffer &&
            options.sogScalesBuffer &&
            options.sogScaleCodebookBuffer
          ? "sog"
          : options.colorBuffer && options.scaleBuffer && options.rotationBuffer
            ? "expanded"
            : "debug";
    const splatRadiusScale = options.splatRadiusScale ?? 2.0;
    this.mesh = new Mesh("ComputeTileSplatPreview", scene);
    this.mesh.renderingGroupId = 3;
    this.mesh.isPickable = false;
    this.mesh.alwaysSelectAsActiveMesh = true;
    this.mesh.doNotSyncBoundingInfo = true;

    const positions = new Float32Array(this.samplesPerTile * 4 * 3);
    const indices = new Uint32Array(this.samplesPerTile * 6);
    const corners = [-1, -1, 1, -1, 1, 1, -1, 1];
    for (let sample = 0; sample < this.samplesPerTile; sample++) {
      for (let cornerIndex = 0; cornerIndex < 4; cornerIndex++) {
        const offset = (sample * 4 + cornerIndex) * 3;
        positions[offset + 0] = corners[cornerIndex * 2 + 0];
        positions[offset + 1] = corners[cornerIndex * 2 + 1];
        positions[offset + 2] = sample;
      }
      const baseVertex = sample * 4;
      const indexOffset = sample * 6;
      indices[indexOffset + 0] = baseVertex + 0;
      indices[indexOffset + 1] = baseVertex + 1;
      indices[indexOffset + 2] = baseVertex + 2;
      indices[indexOffset + 3] = baseVertex + 0;
      indices[indexOffset + 4] = baseVertex + 2;
      indices[indexOffset + 5] = baseVertex + 3;
    }
    this.mesh.setVerticesData("position", positions, false, 3);
    this.mesh.setIndices(indices);

    this.material = new ShaderMaterial(
      "ComputeTileSplatPreviewMaterial",
      scene,
      {
        vertexSource: getVertexSource(shaderMode, this.shapeMode, this.colorMode),
        fragmentSource: FRAGMENT_SOURCE,
      },
      {
        attributes: ["position"],
        uniforms: [
          "worldViewProjection",
          "world",
          "view",
          "projection",
          "viewport",
          "workTileCount",
          "workSourceTileCount",
          "workSourceTileOffset",
          "maxTileSplats",
          "markerPixels",
          "samplesPerTile",
          "coverageMode",
          "splatRadiusScale",
          "maxMarkerPixels",
          "useGaussianShape",
          "sampleAlphaCompensation",
          "samplePassCount",
          "sogCenterOffset",
          "sogQuatOffset",
          "sogScalesOffset",
          "sogScaleCodebookOffset",
          "minAlpha",
          "maxAlpha",
          "alphaClip",
          "alphaScale",
        ],
        storageBuffers: [
          "centerBuffer",
          "tileSplatList",
          "workQueue",
          ...(shaderMode === "expanded"
            ? [
                "colorBuffer",
                ...(this.shapeMode === "gaussian" ? ["scaleBuffer", "rotationBuffer"] : []),
              ]
            : []),
          ...(shaderMode === "sog" || shaderMode === "globalSog"
            ? [
                ...(this.shapeMode === "gaussian" ? ["quatsBuffer"] : []),
                "colorBuffer",
                "scalesBuffer",
                "scaleCodebookBuffer",
                ...(shaderMode === "globalSog" ? ["chunkInfoBuffer"] : []),
              ]
            : []),
        ],
        needAlphaBlending: true,
        shaderLanguage: ShaderLanguage.WGSL,
      },
    );
    this.material.alphaMode = Constants.ALPHA_PREMULTIPLIED;
    this.material.disableDepthWrite = true;
    this.material.setStorageBuffer("centerBuffer", options.centerBuffer);
    this.material.setStorageBuffer("tileSplatList", options.tileSplatListBuffer ?? this.tileStatsPass.getTileSplatListBuffer());
    this.material.setStorageBuffer("workQueue", this.workQueuePass.getWorkQueueBuffer());
    if (shaderMode === "expanded" && options.colorBuffer) {
      this.material.setStorageBuffer("colorBuffer", options.colorBuffer);
    }
    if (
      this.shapeMode === "gaussian" &&
      shaderMode === "expanded" &&
      options.scaleBuffer &&
      options.rotationBuffer
    ) {
      this.material.setStorageBuffer("scaleBuffer", options.scaleBuffer);
      this.material.setStorageBuffer("rotationBuffer", options.rotationBuffer);
    }
    if (
      this.shapeMode === "gaussian" &&
      (shaderMode === "sog" || shaderMode === "globalSog") &&
      options.sogQuatBuffer &&
      options.sogScalesBuffer &&
      options.sogScaleCodebookBuffer
    ) {
      this.material.setStorageBuffer("quatsBuffer", options.sogQuatBuffer);
    }
    if (
      (shaderMode === "sog" || shaderMode === "globalSog") &&
      options.colorBuffer &&
      options.sogScalesBuffer &&
      options.sogScaleCodebookBuffer
    ) {
      this.material.setStorageBuffer("colorBuffer", options.colorBuffer);
      this.material.setStorageBuffer("scalesBuffer", options.sogScalesBuffer);
      this.material.setStorageBuffer("scaleCodebookBuffer", options.sogScaleCodebookBuffer);
    }
    if (
      shaderMode === "globalSog" &&
      options.colorBuffer &&
      options.sogScalesBuffer &&
      options.sogScaleCodebookBuffer &&
      options.sogChunkInfoBuffer
    ) {
      this.material.setStorageBuffer("colorBuffer", options.colorBuffer);
      this.material.setStorageBuffer("scalesBuffer", options.sogScalesBuffer);
      this.material.setStorageBuffer("scaleCodebookBuffer", options.sogScaleCodebookBuffer);
      this.material.setStorageBuffer("chunkInfoBuffer", options.sogChunkInfoBuffer);
    }
    this.material.setFloat("markerPixels", 1.5);
    this.material.setFloat("samplesPerTile", this.samplesPerTile);
    this.material.setFloat("coverageMode", this.coverageMode === "bounded" ? 1.0 : 0.0);
    this.material.setFloat("splatRadiusScale", splatRadiusScale);
    this.maxMarkerPixels = getRasterMaxMarkerPixels(options.maxMarkerPixels ?? 18.0);
    this.material.setFloat("maxMarkerPixels", this.maxMarkerPixels);
    this.material.setFloat("useGaussianShape", this.shapeMode === "gaussian" ? 1.0 : 0.0);
    this.material.setFloat("sampleAlphaCompensation", this.sampleAlphaCompensation);
    this.material.setFloat("samplePassCount", this.staticSamplePasses);
    this.material.setFloat("sogCenterOffset", options.sogCenterOffset ?? 0);
    this.material.setFloat("sogQuatOffset", options.sogQuatOffset ?? 0);
    this.material.setFloat("sogScalesOffset", options.sogScalesOffset ?? 0);
    this.material.setFloat("sogScaleCodebookOffset", options.sogScaleCodebookOffset ?? 0);
    this.material.setFloat("minAlpha", this.alphaMode === "splat" ? 0.0 : 0.08);
    this.material.setFloat("maxAlpha", this.alphaMode === "splat" ? 1.0 : 0.92);
    this.material.setFloat("alphaClip", this.alphaMode === "splat" ? 1 / 255 : 0.0);
    this.material.setFloat("alphaScale", this.alphaScale);
    this.mesh.material = this.material;
  }

  static isEnabled(): boolean {
    return isEnabled();
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      this.mesh.setEnabled(false);
    }
  }

  update(viewportWidth: number, viewportHeight: number): void {
    const workStats = this.workQueuePass.getStats();
    const runtimePreviewLimit = this.getRuntimePreviewTileLimit(workStats.workTiles, workStats.queuedSplats);
    const previewTileLimit = runtimePreviewLimit.limit;
    const runtimeShapeMode = this.getRuntimeShapeMode();
    const previewTiles = Math.min(workStats.workTiles, previewTileLimit);
    const sourceWindow = this.getWorkSourceWindow(
      workStats.workTiles,
      previewTiles,
      this.previewWindowMode === "full",
    );
    const avgSplatsPerWorkItem = workStats.workTiles > 0 ? workStats.queuedSplats / workStats.workTiles : 0;
    const windowSplats = Math.min(
      workStats.queuedSplats,
      Math.max(0, Math.round(sourceWindow.count * avgSplatsPerWorkItem)),
    );
    const runtimeSampleCoverageTarget = this.getRuntimeSampleCoverageTarget();
    const runtimeSamplePasses = this.getRuntimeSamplePasses(
      windowSplats,
      previewTiles,
      runtimeSampleCoverageTarget,
      workStats.maxTileSplats,
    );
    const maxUsefulSamplePasses = this.getMaxUsefulSamplePasses(workStats.maxTileSplats);
    const previewCapacity = previewTiles * this.samplesPerTile * runtimeSamplePasses;
    this.material.setFloat("workTileCount", previewTiles);
    this.material.setFloat("workSourceTileCount", sourceWindow.count);
    this.material.setFloat("workSourceTileOffset", sourceWindow.offset);
    this.material.setFloat("maxTileSplats", workStats.maxTileSplats);
    this.material.setFloat("useGaussianShape", runtimeShapeMode === "gaussian" ? 1.0 : 0.0);
    this.material.setFloat("samplePassCount", runtimeSamplePasses);
    this.viewport.set(viewportWidth, viewportHeight);
    this.material.setVector2("viewport", this.viewport);
    this.mesh.forcedInstanceCount = Math.max(0, previewTiles * runtimeSamplePasses);
    this.mesh.setEnabled(this.enabled && workStats.dispatched && previewTiles > 0 && workStats.maxTileSplats > 0);
    const previewSplats = Math.min(windowSplats > 0 ? windowSplats : workStats.queuedSplats, previewCapacity);
    const truncatedSplats = Math.max(0, windowSplats - previewSplats);
    const sampledCoverage = previewSplats / Math.max(1, windowSplats);
    const runtimeSampleAlphaCompensation = this.getRuntimeSampleAlphaCompensation(
      sampledCoverage,
      runtimeSampleCoverageTarget,
    );
    this.material.setFloat("sampleAlphaCompensation", runtimeSampleAlphaCompensation);
    this.stats = {
      enabled: true,
      samplesPerTile: this.samplesPerTile,
      activeTiles: previewTiles,
      workTiles: workStats.workTiles,
      drawLimit: previewTileLimit,
      requestedDrawLimit: runtimePreviewLimit.requestedLimit,
      staticDrawLimit: this.previewTileLimit,
      motionDrawLimit: this.motionPreviewTileLimit,
      adaptiveDrawScale: this.adaptiveDrawScale,
      smoothedFrameMs: this.smoothedFrameMs,
      maxMarkerPixels: this.maxMarkerPixels,
      staticRamp: this.getStaticRampT(),
      previewSplats,
      windowSplats,
      sampledCoverage,
      windowCoverage: windowSplats / Math.max(1, workStats.queuedSplats),
      colorMode: this.colorMode,
      shapeMode: runtimeShapeMode,
      orderMode: this.orderMode,
      coverageMode: this.coverageMode,
      rasterCoverageMode: this.rasterCoverageMode,
      truncatedSplats,
      drawOrder: this.previewDrawOrder,
      windowMode: this.previewWindowMode,
      nearWindowMargin: this.previewNearWindowMargin,
      sampleAlphaCompensation: this.sampleAlphaCompensation,
      runtimeSampleAlphaCompensation,
      samplePasses: runtimeSamplePasses,
      maxUsefulSamplePasses,
      staticSamplePasses: this.staticSamplePasses,
      motionSamplePasses: this.motionSamplePasses,
      sampleCoverageTarget: this.sampleCoverageTarget,
      motionSampleCoverageTarget: this.motionSampleCoverageTarget,
      runtimeSampleCoverageTarget,
      samplePassesAdaptive: true,
      drawCoverageTarget: this.drawCoverageTarget,
      motionDrawCoverageTarget: this.motionDrawCoverageTarget,
      runtimeDrawCoverageTarget: runtimePreviewLimit.coverageTarget,
      drawCoverageAdaptive: this.drawCoverageTarget > 0,
    };
  }

  getStats(): ComputeTileSplatPreviewStats {
    return this.stats;
  }

  dispose(): void {
    this.mesh.dispose();
    this.material.dispose();
  }

  private getRuntimePreviewTileLimit(workTiles: number, queuedSplats: number): {
    limit: number;
    requestedLimit: number;
    coverageTarget: number;
  } {
    if (this.explicitPreviewTileLimit) {
      return {
        limit: this.previewTileLimit,
        requestedLimit: this.previewTileLimit,
        coverageTarget: 0,
      };
    }

    this.updateAdaptiveDrawScale();
    const adaptiveTileLimit = Math.max(1, Math.floor(this.previewTileLimit * this.adaptiveDrawScale));
    const fullStaticTileLimit = Math.min(this.previewTileLimit, adaptiveTileLimit);
    const camera = this.scene.activeCamera;
    if (!camera) {
      const requestedLimit = this.getCoverageRequestedTileLimit(workTiles, queuedSplats, this.drawCoverageTarget);
      return {
        limit: Math.min(fullStaticTileLimit, requestedLimit),
        requestedLimit,
        coverageTarget: this.drawCoverageTarget,
      };
    }

    this.updateMotionState(camera.globalPosition, camera.getDirection(Vector3.Forward()));
    const staticTileLimit = this.getRampedStaticTileLimit(fullStaticTileLimit);
    const runtimeDrawCoverageTarget = this.getRuntimeDrawCoverageTarget();
    const requestedLimit = this.getCoverageRequestedTileLimit(workTiles, queuedSplats, runtimeDrawCoverageTarget);
    const cappedLimit =
      this.motionDrawFrames > 0
        ? Math.min(staticTileLimit, this.motionPreviewTileLimit)
        : staticTileLimit;

    return {
      limit: Math.min(cappedLimit, requestedLimit),
      requestedLimit,
      coverageTarget: runtimeDrawCoverageTarget,
    };
  }

  private getRuntimeShapeMode(): "gaussian" | "marker" {
    if (this.shapeMode !== "gaussian" || !this.motionMarkerEnabled) {
      return this.shapeMode;
    }
    return this.motionDrawFrames > 0 ? "marker" : "gaussian";
  }

  private getRuntimeDrawCoverageTarget(): number {
    if (this.drawCoverageTarget <= 0 || this.motionDrawCoverageTarget >= this.drawCoverageTarget) {
      return this.drawCoverageTarget;
    }
    if (this.motionDrawFrames > 0) {
      return this.motionDrawCoverageTarget;
    }
    const t = this.getStaticRampT();
    return this.motionDrawCoverageTarget + (this.drawCoverageTarget - this.motionDrawCoverageTarget) * t;
  }

  private getCoverageRequestedTileLimit(workTiles: number, queuedSplats: number, coverageTarget: number): number {
    if (coverageTarget <= 0 || workTiles <= 0 || queuedSplats <= 0) {
      return this.previewTileLimit;
    }
    const avgSplatsPerWorkItem = queuedSplats / workTiles;
    const targetSplats = queuedSplats * coverageTarget;
    return Math.min(this.previewTileLimit, Math.max(1, Math.ceil(targetSplats / Math.max(1, avgSplatsPerWorkItem))));
  }

  private getRuntimeSamplePasses(
    windowSplats: number,
    previewTiles: number,
    runtimeSampleCoverageTarget: number,
    maxSplatsPerWorkItem: number,
  ): number {
    const maxPasses =
      this.motionDrawFrames > 0
        ? Math.min(this.staticSamplePasses, this.motionSamplePasses)
        : this.staticSamplePasses;
    if (windowSplats <= 0 || previewTiles <= 0) {
      return maxPasses;
    }
    const maxUsefulPasses = this.getMaxUsefulSamplePasses(maxSplatsPerWorkItem);
    if (this.rasterCoverageMode === "full") {
      return Math.min(MAX_RASTER_FULL_SAMPLE_PASSES, maxUsefulPasses);
    }
    const samplesPerPass = Math.max(1, previewTiles * this.samplesPerTile);
    const targetSamples = Math.max(1, Math.ceil(windowSplats * runtimeSampleCoverageTarget));
    return Math.min(maxPasses, maxUsefulPasses, Math.max(1, Math.ceil(targetSamples / samplesPerPass)));
  }

  private getMaxUsefulSamplePasses(maxSplatsPerWorkItem: number): number {
    if (maxSplatsPerWorkItem <= 0) {
      return Math.max(1, Math.min(this.staticSamplePasses, this.motionSamplePasses));
    }
    return Math.max(1, Math.ceil(maxSplatsPerWorkItem / Math.max(1, this.samplesPerTile)));
  }

  private getRuntimeSampleCoverageTarget(): number {
    if (this.rasterCoverageMode === "full") {
      return 1;
    }
    if (this.motionSampleCoverageTarget >= this.sampleCoverageTarget) {
      return this.sampleCoverageTarget;
    }
    if (this.motionDrawFrames > 0) {
      return this.motionSampleCoverageTarget;
    }
    const t = this.getStaticRampT();
    return this.motionSampleCoverageTarget + (this.sampleCoverageTarget - this.motionSampleCoverageTarget) * t;
  }

  private getRuntimeSampleAlphaCompensation(sampledCoverage: number, runtimeSampleCoverageTarget: number): number {
    if (this.rasterCoverageMode === "full") {
      return 1;
    }
    if (this.sampleAlphaCompensation <= 1 || runtimeSampleCoverageTarget <= 0) {
      return 1;
    }
    const need = 1 - Math.min(1, Math.max(0, sampledCoverage / runtimeSampleCoverageTarget));
    return 1 + (this.sampleAlphaCompensation - 1) * need;
  }

  private getWorkSourceWindow(
    workTiles: number,
    previewTiles: number,
    fullWindow = false,
  ): { offset: number; count: number } {
    if (this.previewDrawOrder === "coverage") {
      return { offset: 0, count: workTiles };
    }
    if (this.previewDrawOrder === "far" || previewTiles >= workTiles || fullWindow) {
      if (this.previewDrawOrder === "near" && previewTiles < workTiles) {
        return { offset: Math.max(0, workTiles - previewTiles), count: previewTiles };
      }
      return { offset: 0, count: previewTiles };
    }
    const marginTiles = Math.floor(previewTiles * this.previewNearWindowMargin);
    const count = Math.min(workTiles, Math.max(previewTiles, previewTiles + marginTiles));
    return { offset: Math.max(0, workTiles - count), count };
  }

  private updateMotionState(cameraPosition: Vector3, cameraForward: Vector3): void {
    const initialized = Number.isFinite(this.lastMotionCameraPosition.x);
    const moving =
      initialized &&
      (Vector3.DistanceSquared(cameraPosition, this.lastMotionCameraPosition) > MOTION_DRAW_MOVE_EPSILON_SQ ||
        Vector3.Dot(cameraForward, this.lastMotionCameraForward) < MOTION_DRAW_FORWARD_DOT);

    this.lastMotionCameraPosition.copyFrom(cameraPosition);
    this.lastMotionCameraForward.copyFrom(cameraForward);
    if (moving) {
      this.motionDrawFrames = MOTION_DRAW_HOLD_FRAMES;
      this.staticRampFrame = 0;
      this.wasMotionLimited = true;
    } else if (this.motionDrawFrames > 0) {
      this.motionDrawFrames--;
    } else if (this.wasMotionLimited) {
      this.staticRampFrame = Math.min(this.staticDrawRampFrames, this.staticRampFrame + 1);
      if (this.staticRampFrame >= this.staticDrawRampFrames) {
        this.wasMotionLimited = false;
      }
    }
  }

  private getRampedStaticTileLimit(fullStaticTileLimit: number): number {
    if (this.staticDrawRampFrames <= 0 || this.motionPreviewTileLimit >= fullStaticTileLimit) {
      return fullStaticTileLimit;
    }
    const t = this.getStaticRampT();
    const ramped = this.motionPreviewTileLimit + (fullStaticTileLimit - this.motionPreviewTileLimit) * t;
    return Math.min(fullStaticTileLimit, Math.max(this.motionPreviewTileLimit, Math.floor(ramped)));
  }

  private getStaticRampT(): number {
    if (this.staticDrawRampFrames <= 0 || !this.wasMotionLimited) {
      return 1;
    }
    return Math.min(1, Math.max(0, this.staticRampFrame / this.staticDrawRampFrames));
  }

  private updateAdaptiveDrawScale(): void {
    if (!this.adaptivePreviewDrawEnabled) {
      this.adaptiveDrawScale = 1;
      return;
    }

    const now = performance.now();
    if (this.lastAdaptiveFrameTime <= 0) {
      this.lastAdaptiveFrameTime = now;
      return;
    }

    const frameMs = Math.min(250, Math.max(0, now - this.lastAdaptiveFrameTime));
    this.lastAdaptiveFrameTime = now;
    this.smoothedFrameMs = this.smoothedFrameMs <= 0 ? frameMs : this.smoothedFrameMs * 0.85 + frameMs * 0.15;
    if (this.smoothedFrameMs > this.adaptiveFrameTargetMs) {
      this.adaptiveDrawScale = Math.max(this.adaptiveMinDrawScale, this.adaptiveDrawScale * ADAPTIVE_DECAY);
    } else if (this.smoothedFrameMs < this.adaptiveFrameRecoverMs) {
      this.adaptiveDrawScale = Math.min(1, this.adaptiveDrawScale * ADAPTIVE_RECOVER);
    }
  }
}

export { ComputeTileSplatPreviewPass };
export type { ComputeTileSplatPreviewOptions, ComputeTileSplatPreviewStats };
