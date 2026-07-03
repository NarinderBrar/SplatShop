import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Scene } from "@babylonjs/core/scene";

const FRAME_SCALAR_VIEWPORT_WIDTH = 0;
const FRAME_SCALAR_VIEWPORT_HEIGHT = 1;
const FRAME_SCALAR_SPLAT_COUNT = 2;
const FRAME_SCALAR_FRAME_ID = 3;
const FRAME_SCALAR_COUNT = 4;

class FrameDataSoA {
  readonly worldViewProjection = Matrix.Identity();
  readonly view = Matrix.Identity();
  readonly projection = Matrix.Identity();
  readonly cameraPosition = new Float32Array(4);
  readonly cameraForward = new Float32Array(4);
  readonly scalars = new Float32Array(FRAME_SCALAR_COUNT);

  private frameId = 0;

  update(
    scene: Scene,
    viewportWidth: number,
    viewportHeight: number,
    splatCount: number,
  ): this {
    const camera = scene.activeCamera;
    this.worldViewProjection.copyFrom(scene.getTransformMatrix());
    if (camera) {
      this.view.copyFrom(camera.getViewMatrix());
      this.projection.copyFrom(camera.getProjectionMatrix());
      const position = camera.globalPosition;
      camera.getDirectionToRef(FrameDataSoA.forwardReference, FrameDataSoA.forwardScratch);
      const forward = FrameDataSoA.forwardScratch;
      this.cameraPosition[0] = position.x;
      this.cameraPosition[1] = position.y;
      this.cameraPosition[2] = position.z;
      this.cameraPosition[3] = 1;
      this.cameraForward[0] = forward.x;
      this.cameraForward[1] = forward.y;
      this.cameraForward[2] = forward.z;
      this.cameraForward[3] = 0;
    }

    this.scalars[FRAME_SCALAR_VIEWPORT_WIDTH] = viewportWidth;
    this.scalars[FRAME_SCALAR_VIEWPORT_HEIGHT] = viewportHeight;
    this.scalars[FRAME_SCALAR_SPLAT_COUNT] = splatCount;
    this.scalars[FRAME_SCALAR_FRAME_ID] = this.frameId++;
    return this;
  }

  get viewportWidth(): number {
    return this.scalars[FRAME_SCALAR_VIEWPORT_WIDTH];
  }

  get viewportHeight(): number {
    return this.scalars[FRAME_SCALAR_VIEWPORT_HEIGHT];
  }

  get splatCount(): number {
    return this.scalars[FRAME_SCALAR_SPLAT_COUNT];
  }

  private static readonly forwardReference = Vector3.Forward();
  private static readonly forwardScratch = new Vector3();
}

export { FrameDataSoA };
