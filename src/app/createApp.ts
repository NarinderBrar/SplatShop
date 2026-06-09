import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { Color4, Vector3 } from "@babylonjs/core/Maths/math";
import { Scene } from "@babylonjs/core/scene";

import { AssetLoader } from "../asset-loader";
import { LoadingProgress } from "../debug/LoadingProgress";
import { ViewerDebugStats } from "../debug/ViewerDebugStats";
import { initFileHandler } from "../file-handler";
import { createEngine } from "../rendering/createEngine";
import type { SplatCloud } from "../splat/SplatCloud";

const DEFAULT_SPLAT_URL = "/Room.sog";
const DEFAULT_CAMERA_RADIUS_SCALE = 0.72;

const getViewerUpVector = (): Vector3 => {
  const value = new URLSearchParams(window.location.search).get("up");
  return value === "y" || value === "positiveY" ? Vector3.Up() : Vector3.Down();
};

const getStartupSplatUrl = (): string => {
  const params = new URLSearchParams(window.location.search);
  const rawUrl = params.get("url") ?? params.get("asset") ?? params.get("src");
  if (!rawUrl) {
    return DEFAULT_SPLAT_URL;
  }

  try {
    return new URL(rawUrl, window.location.href).href;
  } catch {
    return DEFAULT_SPLAT_URL;
  }
};

const getFilenameFromUrl = (url: string): string => {
  try {
    const pathname = new URL(url, window.location.href).pathname;
    return decodeURIComponent(pathname.split("/").filter(Boolean).at(-1) ?? "Room.sog");
  } catch {
    return url.split("/").filter(Boolean).at(-1) ?? "Room.sog";
  }
};

export async function createApp(
  canvas: HTMLCanvasElement,
  status: HTMLElement,
): Promise<void> {
  const { engine, mode } = await createEngine(canvas);
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.03, 0.035, 0.04, 1);

  const camera = new ArcRotateCamera(
    "MainCamera",
    Math.PI * 0.25,
    Math.PI * 0.35,
    6,
    Vector3.Zero(),
    scene,
  );
  camera.upVector = getViewerUpVector();
  camera.attachControl(canvas, true);
  camera.minZ = 0.01;
  camera.wheelPrecision = 45;

  const debugStats = new ViewerDebugStats(mode);
  const loadingProgress = new LoadingProgress();
  let currentSplatCloud: SplatCloud | undefined;
  status.textContent = `${mode} active. Loading SuperSplat-compatible splat path.`;

  const assetLoader = new AssetLoader();
  const fileHandler = initFileHandler(canvas, scene, assetLoader, status, (splatCloud) => {
    currentSplatCloud = splatCloud;
    debugStats.setCloud(splatCloud);
    loadingProgress.setCloud(splatCloud);
    const framing = splatCloud.getCenterAndRadius();
    if (framing) {
      camera.setTarget(framing.center);
      camera.radius = Math.max(framing.radius * DEFAULT_CAMERA_RADIUS_SCALE, 0.35);
    }
  }, (filename) => loadingProgress.start(`Loading ${filename}`));

  const startupUrl = getStartupSplatUrl();
  status.textContent = `Loading ${startupUrl}...`;
  loadingProgress.start(`Loading ${getFilenameFromUrl(startupUrl)}`);
  void fileHandler.importFiles([{ filename: getFilenameFromUrl(startupUrl), url: startupUrl }]);

  engine.runRenderLoop(() => {
    scene.render();
    debugStats.update();
    loadingProgress.update(currentSplatCloud);
  });

  window.addEventListener("resize", () => {
    engine.resize();
  });
}
