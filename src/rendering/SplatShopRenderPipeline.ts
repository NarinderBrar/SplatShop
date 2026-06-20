import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { PostProcess } from "@babylonjs/core/PostProcesses/postProcess";
import { PostProcessRenderEffect } from "@babylonjs/core/PostProcesses/RenderPipeline/postProcessRenderEffect";
import { PostProcessRenderPipeline } from "@babylonjs/core/PostProcesses/RenderPipeline/postProcessRenderPipeline";
import { Scene } from "@babylonjs/core/scene";
import "@babylonjs/core/Shaders/postprocess.vertex";
import "@babylonjs/core/ShadersWGSL/postprocess.vertex";
import "@babylonjs/core/PostProcesses/RenderPipeline/postProcessRenderPipelineManagerSceneComponent";
import compositeFragmentGlsl from "./shaders/splat-shop-render-pipeline.composite.fragment.glsl?raw";
import compositeFragmentWgsl from "./shaders/splat-shop-render-pipeline.composite.fragment.wgsl?raw";
import postprocessVertexWgsl from "./shaders/splat-shop-render-pipeline.postprocess-vertex.wgsl?raw";

const PIPELINE_NAME = "SplatShopPipeline";
const COMPOSITE_PASS = "SplatShopComposite";

ShaderStore.ShadersStoreWGSL.postprocessVertexShader ??= postprocessVertexWgsl;
ShaderStore.ShadersStore[`${COMPOSITE_PASS}PixelShader`] = compositeFragmentGlsl;
ShaderStore.ShadersStoreWGSL[`${COMPOSITE_PASS}PixelShader`] = compositeFragmentWgsl;

export class SplatShopRenderPipeline extends PostProcessRenderPipeline {
  private readonly scene: Scene;
  private readonly camera: ArcRotateCamera;
  private readonly compositePass: PostProcess;
  private startTime = performance.now();
  private attached = false;

  constructor(scene: Scene, camera: ArcRotateCamera) {
    super(scene.getEngine(), PIPELINE_NAME);

    this.scene = scene;
    this.camera = camera;
    this.compositePass = new PostProcess(
      COMPOSITE_PASS,
      COMPOSITE_PASS,
      ["time", "strength"],
      null,
      1,
      null,
      Texture.BILINEAR_SAMPLINGMODE,
      scene.getEngine(),
      true,
      null,
      undefined,
      "postprocess",
      undefined,
      false,
      undefined,
      scene.getEngine().isWebGPU ? ShaderLanguage.WGSL : ShaderLanguage.GLSL,
    );

    this.compositePass.onApply = (effect) => {
      effect.setFloat("time", (performance.now() - this.startTime) / 1000);
      effect.setFloat("strength", 0.35);
    };

    this.addEffect(
      new PostProcessRenderEffect(
        scene.getEngine(),
        `${COMPOSITE_PASS}Effect`,
        () => this.compositePass,
        true,
      ),
    );
  }

  attach(): void {
    if (this.attached) {
      return;
    }

    const manager = this.scene.postProcessRenderPipelineManager;
    manager.addPipeline(this);
    manager.attachCamerasToRenderPipeline(PIPELINE_NAME, this.camera);
    this.attached = true;
  }

  resetClock(): void {
    this.startTime = performance.now();
  }
}
