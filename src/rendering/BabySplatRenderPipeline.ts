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

const PIPELINE_NAME = "BabySplatPipeline";
const COMPOSITE_PASS = "BabySplatComposite";

ShaderStore.ShadersStore[`${COMPOSITE_PASS}PixelShader`] = `
precision highp float;

varying vec2 vUV;
uniform sampler2D textureSampler;
uniform float time;
uniform float strength;

void main(void) {
  vec4 color = texture2D(textureSampler, vUV);
  float vignette = smoothstep(0.92, 0.2, distance(vUV, vec2(0.5)));
  float pulse = 0.5 + 0.5 * sin(time * 0.9);
  vec3 warmLift = vec3(0.06, 0.025, -0.015) * strength * pulse;
  gl_FragColor = vec4(color.rgb * (0.82 + 0.18 * vignette) + warmLift, color.a);
}
`;

ShaderStore.ShadersStoreWGSL[`${COMPOSITE_PASS}PixelShader`] = `
varying vUV: vec2f;
var textureSamplerSampler: sampler;
var textureSampler: texture_2d<f32>;
uniform time: f32;
uniform strength: f32;

#define CUSTOM_FRAGMENT_DEFINITIONS

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  let color = textureSample(textureSampler, textureSamplerSampler, input.vUV);
  let vignette = smoothstep(0.92, 0.2, distance(input.vUV, vec2f(0.5, 0.5)));
  let pulse = 0.5 + 0.5 * sin(uniforms.time * 0.9);
  let warmLift = vec3f(0.06, 0.025, -0.015) * uniforms.strength * pulse;
  fragmentOutputs.color = vec4f(color.rgb * (0.82 + 0.18 * vignette) + warmLift, color.a);
}
`;

export class BabySplatRenderPipeline extends PostProcessRenderPipeline {
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
