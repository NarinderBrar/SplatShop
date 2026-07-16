import type { StorageBuffer } from "@babylonjs/core/Buffers/storageBuffer";
import { Matrix } from "@babylonjs/core/Maths/math.vector";
import type { Scene } from "@babylonjs/core/scene";

import type { SogStorageBufferOffsets } from "../../splat/SogBuffers";
import type { CustomWebGpuRenderPass, WebGpuRenderPipeline } from "./WebGpuRenderPipeline";
import commonVertexSource from "./shaders/splat-common.wgsl?raw";
import fragmentSource from "./shaders/splat-fragment.wgsl?raw";
import legacyVertexSource from "./shaders/legacy-splat-vertex.wgsl?raw";
import packedVertexSource from "./shaders/packed-sog-vertex.wgsl?raw";
import residentVertexSource from "./shaders/resident-sog-vertex.wgsl?raw";

const SPLATS_PER_INSTANCE = 128;
const VERTICES_PER_SPLAT = 6;
const UNIFORM_FLOATS = 96;

type RasterKind = "legacy" | "packed-sog" | "resident-sog";

type RasterQuality = {
  gaussianScale: number;
  minPixelRadius: number;
  maxPixelRadius: number;
  maxStdDev: number;
  clipXY: number;
  preBlurAmount: number;
  minAlpha: number;
  blurAmount: number;
  alphaClip: number;
};

type RasterPassOptions = {
  kind: RasterKind;
  scene: Scene;
  pipeline: WebGpuRenderPipeline;
  splatCapacity: number;
  quality: RasterQuality;
  getBuffers: () => Array<StorageBuffer | undefined>;
  getRenderCount: () => number;
  getVizMode: () => number;
  getEnabled: () => boolean;
  getOrder: () => number;
  getPackedBounds?: () => { min: readonly number[]; max: readonly number[] };
  getPackedOffsets?: () => SogStorageBufferOffsets;
};

type NativeDataBuffer = {
  underlyingResource?: GPUBuffer;
  buffer?: GPUBuffer;
};

class WebGpuSplatRasterPass implements CustomWebGpuRenderPass {
  private readonly device: GPUDevice;
  private readonly uniformBuffer: GPUBuffer;
  private readonly dummyStorageBuffer: GPUBuffer;
  private readonly renderPipeline: GPURenderPipeline;
  private bindGroup?: GPUBindGroup;
  private boundBuffers: GPUBuffer[] = [];
  private readonly uniformData = new Float32Array(UNIFORM_FLOATS);
  private disposed = false;

  constructor(private readonly options: RasterPassOptions) {
    this.device = options.pipeline.device;
    this.uniformBuffer = this.device.createBuffer({
      label: `${options.kind}-splat-uniforms`,
      size: this.uniformData.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.dummyStorageBuffer = this.device.createBuffer({
      label: `${options.kind}-splat-dummy-storage`,
      size: Math.max(4, options.splatCapacity * Uint32Array.BYTES_PER_ELEMENT),
      usage: GPUBufferUsage.STORAGE,
    });
    this.renderPipeline = this.createRenderPipeline();
  }

  get order(): number {
    return this.options.getOrder();
  }

  draw(pass: GPURenderPassEncoder): void {
    if (this.disposed || !this.options.getEnabled()) {
      return;
    }

    const renderCount = this.options.getRenderCount();
    if (renderCount <= 0) {
      return;
    }

    this.ensureBindGroup();
    if (!this.bindGroup || !this.updateUniforms(renderCount)) {
      return;
    }

    pass.setPipeline(this.renderPipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.draw(VERTICES_PER_SPLAT * SPLATS_PER_INSTANCE, Math.ceil(renderCount / SPLATS_PER_INSTANCE));
  }

  private createRenderPipeline(): GPURenderPipeline {
    const storageCount = this.options.kind === "legacy" ? 7 : 9;
    const bindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        ...Array.from({ length: storageCount }, (_, index): GPUBindGroupLayoutEntry => ({
          binding: index + 1,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: "read-only-storage" },
        })),
      ],
    });
    const layout = this.device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] });
    const kindVertexSource = this.options.kind === "packed-sog"
      ? packedVertexSource
      : this.options.kind === "resident-sog"
        ? residentVertexSource
        : legacyVertexSource;
    const vertexCode = `${commonVertexSource}\n${kindVertexSource}`;
    const format = navigator.gpu?.getPreferredCanvasFormat() ?? "bgra8unorm";

    this.device.pushErrorScope("validation");
    const pipeline = this.device.createRenderPipeline({
      label: `${this.options.kind}-splat-raster-pipeline`,
      layout,
      vertex: {
        module: this.device.createShaderModule({ code: vertexCode }),
        entryPoint: "vsMain",
      },
      fragment: {
        module: this.device.createShaderModule({ code: fragmentSource }),
        entryPoint: "fsMain",
        targets: [{
          format,
          blend: {
            color: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
          },
        }],
      },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: {
        format: this.options.pipeline.depthStencilFormat,
        depthWriteEnabled: false,
        depthCompare: "always",
      },
      multisample: { count: this.options.pipeline.sampleCount },
    });
    void this.device.popErrorScope().then((error) => {
      if (error) {
        console.error(`[${this.options.kind}] WebGPU raster pipeline validation failed: ${error.message}`);
      }
    });
    return pipeline;
  }

  private ensureBindGroup(): void {
    const nativeBuffers = this.options.getBuffers().map((buffer) => buffer ? this.getNativeBuffer(buffer) : this.dummyStorageBuffer);
    if (nativeBuffers.length === 0 || nativeBuffers.some((buffer) => !buffer)) {
      return;
    }
    if (this.bindGroup && nativeBuffers.every((buffer, index) => buffer === this.boundBuffers[index])) {
      return;
    }

    this.boundBuffers = nativeBuffers;
    this.bindGroup = this.device.createBindGroup({
      layout: this.renderPipeline.getBindGroupLayout(0) as unknown as GPUBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        ...nativeBuffers.map((buffer, index) => ({ binding: index + 1, resource: { buffer } })),
      ],
    });
  }

  private getNativeBuffer(storage: StorageBuffer): GPUBuffer {
    const dataBuffer = storage.getBuffer() as unknown as NativeDataBuffer;
    const native = dataBuffer.underlyingResource ?? dataBuffer.buffer;
    if (!native) {
      throw new Error("Babylon storage buffer has no native WebGPU resource.");
    }
    return native;
  }

  private updateUniforms(renderCount: number): boolean {
    const camera = this.options.scene.activeCamera;
    if (!camera) {
      return false;
    }

    const engine = this.options.scene.getEngine();
    const data = this.uniformData;
    data.fill(0);
    this.options.scene.getTransformMatrix().copyToArray(data, 0);
    camera.getViewMatrix().copyToArray(data, 16);
    Matrix.IdentityReadOnly.copyToArray(data, 32);
    camera.getProjectionMatrix().copyToArray(data, 48);

    const quality = this.options.quality;
    data.set([engine.getRenderWidth(true), engine.getRenderHeight(true), quality.gaussianScale, quality.minPixelRadius], 64);
    data.set([quality.maxPixelRadius, quality.maxStdDev, quality.clipXY, quality.preBlurAmount], 68);
    data.set([renderCount, this.options.getVizMode(), quality.minAlpha, quality.blurAmount], 72);
    data[76] = quality.alphaClip;

    const bounds = this.options.getPackedBounds?.();
    if (bounds) {
      data.set(bounds.min.slice(0, 3), 80);
      data.set(bounds.max.slice(0, 3), 84);
    }
    const offsets = this.options.getPackedOffsets?.();
    if (offsets) {
      data.set([offsets.meansL, offsets.meansU, offsets.quats, offsets.scales], 88);
      data.set([offsets.color, offsets.state, offsets.scaleCodebook, 0], 92);
    }

    this.device.queue.writeBuffer(this.uniformBuffer, 0, data);
    return true;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.uniformBuffer.destroy();
    this.dummyStorageBuffer.destroy();
    this.bindGroup = undefined;
    this.boundBuffers = [];
  }
}

export { WebGpuSplatRasterPass };
export type { RasterPassOptions, RasterQuality };
