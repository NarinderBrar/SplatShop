import type { Color4 } from "@babylonjs/core/Maths/math.color";
import type { Scene } from "@babylonjs/core/scene";

type BabylonWebGpuEngine = ReturnType<Scene["getEngine"]> & {
  _device?: GPUDevice;
  _currentRenderPass?: GPURenderPassEncoder;
  _getCurrentRenderPass?: () => GPURenderPassEncoder | undefined;
  _clearFullQuad?: (color: Color4, clearColor: boolean, clearDepth: boolean) => void;
  flushFramebuffer?: () => void;
  _mainPassSampleCount?: number;
  _mainRenderPassWrapper?: { depthTextureFormat?: GPUTextureFormat };
};

interface CustomWebGpuRenderPass {
  readonly order: number;
  draw(pass: GPURenderPassEncoder): void;
  dispose(): void;
}

const pipelines = new WeakMap<Scene, WebGpuRenderPipeline>();

class WebGpuRenderPipeline {
  readonly device: GPUDevice;
  readonly sampleCount: number;
  readonly depthStencilFormat: GPUTextureFormat;
  private readonly engine: BabylonWebGpuEngine;
  private readonly passes = new Set<CustomWebGpuRenderPass>();
  private readonly renderFunction: (updateCameras: boolean, ignoreAnimations: boolean) => void;
  private disposed = false;

  constructor(readonly scene: Scene) {
    this.engine = scene.getEngine() as BabylonWebGpuEngine;
    const device = this.engine._device;
    if (!device) {
      throw new Error("Custom WebGPU rendering requires Babylon's initialized WebGPU device.");
    }

    this.device = device;
    this.sampleCount = Math.max(1, this.engine._mainPassSampleCount ?? 1);
    this.depthStencilFormat = this.engine._mainRenderPassWrapper?.depthTextureFormat ?? "depth24plus-stencil8";
    this.renderFunction = () => this.render();
    pipelines.set(scene, this);
    scene.customRenderFunction = this.renderFunction;
  }

  register(pass: CustomWebGpuRenderPass): () => void {
    if (this.disposed) {
      throw new Error("Cannot register a pass on a disposed WebGPU render pipeline.");
    }
    this.passes.add(pass);
    return () => this.passes.delete(pass);
  }

  private render(): void {
    if (this.disposed) {
      return;
    }

    // Compute work (including depth-key generation and radix sorting) cannot be
    // encoded while Babylon's render pass from the previous frame is still open.
    // End it before notifying the existing per-frame observers.
    if (this.engine._currentRenderPass) {
      this.engine.flushFramebuffer?.();
    }

    this.scene.updateTransformMatrix();

    // Babylon intentionally skips this observable when customRenderFunction is set.
    // Existing splat passes use it for sorting, LOD, compute work, and viewport updates.
    this.scene.onBeforeRenderObservable.notifyObservers(this.scene);

    const camera = this.scene.activeCamera;
    if (!camera || !this.engine._clearFullQuad || !this.engine._getCurrentRenderPass) {
      return;
    }

    this.scene.onBeforeCameraRenderObservable.notifyObservers(camera);

    this.engine._clearFullQuad(this.scene.clearColor, true, true);
    const renderPass = this.engine._getCurrentRenderPass();
    if (!renderPass) {
      return;
    }

    const orderedPasses = Array.from(this.passes).sort((a, b) => a.order - b.order);
    for (const pass of orderedPasses) {
      pass.draw(renderPass);
    }

    this.engine.flushFramebuffer?.();
    this.scene.onAfterCameraRenderObservable.notifyObservers(camera);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (this.scene.customRenderFunction === this.renderFunction) {
      this.scene.customRenderFunction = undefined;
    }
    this.passes.clear();
    pipelines.delete(this.scene);
  }
}

const getWebGpuRenderPipeline = (scene: Scene): WebGpuRenderPipeline | undefined => pipelines.get(scene);

export { WebGpuRenderPipeline, getWebGpuRenderPipeline };
export type { CustomWebGpuRenderPass };
