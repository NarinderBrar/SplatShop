import { Color4 } from "@babylonjs/core/Maths/math";
import { Scene } from "@babylonjs/core/scene";

import { AssetLoader } from "../asset-loader";
import { LoadingProgress } from "../debug/LoadingProgress";
import { ViewerDebugStats } from "../debug/ViewerDebugStats";
import { initFileHandler } from "../file-handler";
import { createEngine } from "../rendering/createEngine";
import { createUI } from "./createUI";
import { CameraManager } from "./CameraManager";
import type { SplatCloud } from "../splat/SplatCloud";
import type { ToolId, SelectionMode } from "./createUI";

const DEFAULT_SPLAT_URL = "/Room.sog";

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
    return decodeURIComponent(
      pathname.split("/").filter(Boolean).at(-1) ?? "Room.sog",
    );
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
  const cameraManager = new CameraManager(canvas, scene);

  const debugStats = new ViewerDebugStats(mode);
  const loadingProgress = new LoadingProgress();
  let currentSplatCloud: SplatCloud | undefined;
  status.textContent = `${mode} active. Loading SuperSplat-compatible splat path.`;

  const assetLoader = new AssetLoader();
  let activeVizMode = 0;
  let debugVisible = false;
  let activeTool: ToolId = "pointSelect";
  let selectionThreshold = 0.14;
  let selectionMode: SelectionMode = "normal";
  let selectBehind = true;

  debugStats.setVisible(false);
  const ui = createUI(
    {
      onToolSelect: (tool) => {
        activeTool = tool;
      },
      onSelectionModeChange: (mode) => {
        selectionMode = mode;
      },
      onThresholdChange: (value) => {
        selectionThreshold = value;
      },
      onBehindToggle: (value) => {
        selectBehind = value;
      },
      onVizModeChange: (mode) => {
        activeVizMode = mode;
        currentSplatCloud?.setVizMode(mode);
      },
      onPropertyTabChange: (tab) => {
        debugVisible = tab === "debug";
        debugStats.setVisible(debugVisible);
        currentSplatCloud?.setDebugChunkBoundsVisible(debugVisible);
      },
    },
    debugStats.getElement(),
  );

  canvas.addEventListener("pointerdown", (event: PointerEvent) => {
    if (activeTool !== "pointSelect" || !currentSplatCloud?.hasSelection) {
      return;
    }

    const targetCloud = currentSplatCloud;
    const rect = canvas.getBoundingClientRect();
    const ndcX = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    const viewProjArray = cameraManager.getViewProjectionArray();

    void targetCloud
      .selectPoint(
        ndcX,
        ndcY,
        selectionThreshold,
        selectionMode,
        selectBehind,
        viewProjArray,
      )
      .then((selectedCount) => {
        if (currentSplatCloud === targetCloud) {
          ui.setSelectedCount(selectedCount);
        }
      })
      .catch(() => {
        if (currentSplatCloud === targetCloud) {
          ui.setSelectedCount(0);
        }
      });
  });

  const fileHandler = initFileHandler(
    canvas,
    scene,
    assetLoader,
    status,
    (splatCloud) => {
      currentSplatCloud = splatCloud;
      ui.setSelectedCount(0);
      splatCloud.setVizMode(activeVizMode);
      splatCloud.setDebugChunkBoundsVisible(debugVisible);
      debugStats.setCloud(splatCloud);
      loadingProgress.setCloud(splatCloud);
    },
    (filename) => loadingProgress.start(`Loading ${filename}`),
  );

  const startupUrl = getStartupSplatUrl();
  status.textContent = `Loading ${startupUrl}...`;
  loadingProgress.start(`Loading ${getFilenameFromUrl(startupUrl)}`);
  void fileHandler.importFiles([
    { filename: getFilenameFromUrl(startupUrl), url: startupUrl },
  ]);

  engine.runRenderLoop(() => {
    scene.render();
    debugStats.update();
    loadingProgress.update(currentSplatCloud);
  });

  window.addEventListener("resize", () => {
    engine.resize();
  });
}
