import { StorageBuffer } from "@babylonjs/core/Buffers/storageBuffer";
import { ComputeShader } from "@babylonjs/core/Compute/computeShader";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader";
import type { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import type { Scene } from "@babylonjs/core/scene";
import ColorSegmentationPass_COMPUTE_SOURCE_raw from "./shaders/color-segmentation-pass.compute-source.wgsl?raw";

const WORKGROUP_SIZE = 256;

const COMPUTE_SOURCE = ColorSegmentationPass_COMPUTE_SOURCE_raw.replaceAll("__COMPUTE_SOURCE_EXPR_0__", String(WORKGROUP_SIZE));

class ColorSegmentationPass {
  private readonly shader: ComputeShader;
  private readonly params: StorageBuffer;
  private readonly paramsData = new Float32Array(1);
  private readonly groupBuffer: StorageBuffer;
  private dispatched = false;

  constructor(
    scene: Scene,
    colorBuffer: StorageBuffer,
    splatCount: number,
  ) {
    const engine = scene.getEngine() as WebGPUEngine;
    this.paramsData[0] = splatCount;
    this.params = new StorageBuffer(engine, this.paramsData.byteLength, undefined, "ColorSegmentationParams");
    this.params.update(this.paramsData);

    const byteLength = Math.max(splatCount * 4, 4);
    this.groupBuffer = new StorageBuffer(engine, byteLength, undefined, "ColorGroupBuffer");

    this.shader = new ComputeShader(
      "ColorSegmentationPass",
      engine,
      { computeSource: COMPUTE_SOURCE },
      {
        bindingsMapping: {
          colorBuffer: { group: 0, binding: 0 },
          colorGroupBuffer: { group: 0, binding: 1 },
          paramsBuffer: { group: 0, binding: 2 },
        },
      },
    );
    this.shader.setStorageBuffer("colorBuffer", colorBuffer);
    this.shader.setStorageBuffer("colorGroupBuffer", this.groupBuffer);
    this.shader.setStorageBuffer("paramsBuffer", this.params);
  }

  getColorGroupBuffer(): StorageBuffer {
    return this.groupBuffer;
  }

  dispatch(): boolean {
    if (this.dispatched) {
      return true;
    }
    const count = this.paramsData[0];
    if (count <= 0) {
      return false;
    }
    const result = this.shader.dispatch(Math.ceil(count / WORKGROUP_SIZE));
    if (result) {
      this.dispatched = true;
    }
    return result;
  }

  dispose(): void {
    this.params.dispose();
    this.groupBuffer.dispose();
  }
}

export { ColorSegmentationPass };
