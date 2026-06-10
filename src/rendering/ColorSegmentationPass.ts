import { StorageBuffer } from "@babylonjs/core/Buffers/storageBuffer";
import { ComputeShader } from "@babylonjs/core/Compute/computeShader";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader";
import type { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import type { Scene } from "@babylonjs/core/scene";

const WORKGROUP_SIZE = 256;

const COMPUTE_SOURCE = `
@group(0) @binding(0) var<storage, read> colorBuffer: array<vec4f>;
@group(0) @binding(1) var<storage, read_write> colorGroupBuffer: array<u32>;
@group(0) @binding(2) var<storage, read> paramsBuffer: array<f32>;

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) globalId: vec3u) {
  let index = globalId.x;
  let splatCount = u32(paramsBuffer[0]);
  if (index >= splatCount) {
    return;
  }

  let color = colorBuffer[index].rgb;
  let r = u32(color.r * 255.0) >> 5u;
  let g = u32(color.g * 255.0) >> 5u;
  let b = u32(color.b * 255.0) >> 5u;
  colorGroupBuffer[index] = (r << 6u) | (g << 3u) | b;
}
`;

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
