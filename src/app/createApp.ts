import { Color4 } from "@babylonjs/core/Maths/math";
import { Scene } from "@babylonjs/core/scene";

import { AssetLoader } from "../asset-loader";
import { LoadingProgress } from "../debug/LoadingProgress";
import { ViewerDebugStats } from "../debug/ViewerDebugStats";
import { initFileHandler } from "../file-handler";
import { createEngine } from "../rendering/createEngine";
import { renderDiagnostics } from "../rendering/RenderDiagnostics";
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

type ScreenPoint = {
  x: number;
  y: number;
};

type DragSelectionTool = Extract<ToolId, "circleSelect" | "marqueeSelect" | "lassoSelect">;

type SelectionGesture = {
  tool: DragSelectionTool;
  pointerId: number;
  start: ScreenPoint;
  current: ScreenPoint;
  points: ScreenPoint[];
  overlay: HTMLElement | SVGSVGElement;
  polyline?: SVGPolylineElement;
};

const isDragSelectionTool = (tool: ToolId): tool is DragSelectionTool =>
  tool === "circleSelect" || tool === "marqueeSelect" || tool === "lassoSelect";

const toScreenPoint = (event: PointerEvent): ScreenPoint => ({
  x: event.clientX,
  y: event.clientY,
});

const getDistance = (a: ScreenPoint, b: ScreenPoint): number => Math.hypot(a.x - b.x, a.y - b.y);

const toNdcPoint = (canvas: HTMLCanvasElement, point: ScreenPoint): ScreenPoint => {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((point.x - rect.left) / rect.width) * 2 - 1,
    y: -((point.y - rect.top) / rect.height) * 2 + 1,
  };
};

const createDomOverlayRoot = (): HTMLDivElement => {
  const root = document.createElement("div");
  root.id = "viewer-dom-overlays";
  document.body.appendChild(root);
  return root;
};

const createSelectionOverlay = (
  tool: DragSelectionTool,
  start: ScreenPoint,
  overlayRoot: HTMLElement,
): SelectionGesture["overlay"] => {
  if (tool === "lassoSelect") {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const polyline = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
    svg.classList.add("selection-lasso-overlay");
    polyline.classList.add("selection-lasso-overlay__path");
    polyline.setAttribute("points", `${start.x},${start.y}`);
    svg.appendChild(polyline);
    overlayRoot.appendChild(svg);
    return svg;
  }

  const overlay = document.createElement("div");
  overlay.className = `selection-gesture-overlay selection-gesture-overlay--${tool === "circleSelect" ? "circle" : "rect"}`;
  overlayRoot.appendChild(overlay);
  return overlay;
};

const getLassoPolyline = (overlay: SelectionGesture["overlay"]): SVGPolylineElement | undefined =>
  overlay instanceof SVGSVGElement ? overlay.querySelector("polyline") ?? undefined : undefined;

const updateSelectionOverlay = (gesture: SelectionGesture): void => {
  if (gesture.tool === "lassoSelect") {
    gesture.polyline?.setAttribute("points", gesture.points.map((point) => `${point.x},${point.y}`).join(" "));
    return;
  }

  const overlay = gesture.overlay as HTMLElement;
  if (gesture.tool === "circleSelect") {
    const radius = Math.max(1, getDistance(gesture.start, gesture.current));
    overlay.style.left = `${gesture.start.x - radius}px`;
    overlay.style.top = `${gesture.start.y - radius}px`;
    overlay.style.width = `${radius * 2}px`;
    overlay.style.height = `${radius * 2}px`;
    return;
  }

  const left = Math.min(gesture.start.x, gesture.current.x);
  const top = Math.min(gesture.start.y, gesture.current.y);
  overlay.style.left = `${left}px`;
  overlay.style.top = `${top}px`;
  overlay.style.width = `${Math.max(1, Math.abs(gesture.current.x - gesture.start.x))}px`;
  overlay.style.height = `${Math.max(1, Math.abs(gesture.current.y - gesture.start.y))}px`;
};

export async function createApp(
  canvas: HTMLCanvasElement,
  status: HTMLElement,
): Promise<void> {
  const { engine, mode } = await createEngine(canvas);
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.03, 0.035, 0.04, 1);
  const cameraManager = new CameraManager(canvas, scene);
  const overlayRoot = createDomOverlayRoot();

  const debugStats = new ViewerDebugStats(mode, overlayRoot);
  const loadingProgress = new LoadingProgress(overlayRoot);
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

  const applySelectionResult = (targetCloud: SplatCloud, selection: Promise<number>): void => {
    void selection
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
  };

  let selectionGesture: SelectionGesture | undefined;

  canvas.addEventListener("pointerdown", (event: PointerEvent) => {
    if (!currentSplatCloud?.hasSelection) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const targetCloud = currentSplatCloud;
    const viewProjArray = cameraManager.getViewProjectionArray();

    if (activeTool === "pointSelect") {
      const { x: ndcX, y: ndcY } = toNdcPoint(canvas, toScreenPoint(event));
      applySelectionResult(
        targetCloud,
        targetCloud.selectPoint(
          ndcX,
          ndcY,
          selectionThreshold,
          selectionMode,
          selectBehind,
          viewProjArray,
        ),
      );
      return;
    }

    if (!isDragSelectionTool(activeTool)) {
      return;
    }

    const start = toScreenPoint(event);
    const overlay = createSelectionOverlay(activeTool, start, overlayRoot);
    selectionGesture = {
      tool: activeTool,
      pointerId: event.pointerId,
      start,
      current: start,
      points: [start],
      overlay,
      polyline: getLassoPolyline(overlay),
    };
    updateSelectionOverlay(selectionGesture);
    canvas.setPointerCapture(event.pointerId);
    cameraManager.camera.detachControl();
  });

  canvas.addEventListener("pointermove", (event: PointerEvent) => {
    if (!selectionGesture || event.pointerId !== selectionGesture.pointerId) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const current = toScreenPoint(event);
    selectionGesture.current = current;
    if (
      selectionGesture.tool === "lassoSelect" &&
      getDistance(selectionGesture.points[selectionGesture.points.length - 1], current) >= 3
    ) {
      selectionGesture.points.push(current);
    }
    updateSelectionOverlay(selectionGesture);
  });

  const finishSelectionGesture = (event: PointerEvent, cancelled: boolean): void => {
    if (!selectionGesture || event.pointerId !== selectionGesture.pointerId) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const gesture = selectionGesture;
    selectionGesture = undefined;
    gesture.overlay.remove();
    if (canvas.hasPointerCapture(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId);
    }
    cameraManager.camera.attachControl(canvas, true);

    const targetCloud = currentSplatCloud;
    if (cancelled || !targetCloud?.hasSelection) {
      return;
    }

    const viewProjArray = cameraManager.getViewProjectionArray();
    const start = toNdcPoint(canvas, gesture.start);
    const current = toNdcPoint(canvas, gesture.current);
    if (getDistance(gesture.start, gesture.current) < 3) {
      applySelectionResult(
        targetCloud,
        targetCloud.selectPoint(start.x, start.y, selectionThreshold, selectionMode, selectBehind, viewProjArray),
      );
      return;
    }

    if (gesture.tool === "marqueeSelect") {
      applySelectionResult(
        targetCloud,
        targetCloud.selectRect(
          Math.min(start.x, current.x),
          Math.min(start.y, current.y),
          Math.max(start.x, current.x),
          Math.max(start.y, current.y),
          selectionMode,
          selectBehind,
          viewProjArray,
        ),
      );
      return;
    }

    if (gesture.tool === "circleSelect") {
      const rect = canvas.getBoundingClientRect();
      const radiusPixels = getDistance(gesture.start, gesture.current);
      const radiusNdc = Math.max((radiusPixels / rect.width) * 2, (radiusPixels / rect.height) * 2);
      applySelectionResult(
        targetCloud,
        targetCloud.selectCircle(start.x, start.y, radiusNdc, selectionMode, selectBehind, viewProjArray),
      );
      return;
    }

    const lassoPoints = gesture.points.map((point) => toNdcPoint(canvas, point));
    applySelectionResult(
      targetCloud,
      targetCloud.selectLasso(lassoPoints, selectionMode, selectBehind, viewProjArray),
    );
  };

  canvas.addEventListener("pointerup", (event: PointerEvent) => {
    finishSelectionGesture(event, false);
  });

  canvas.addEventListener("pointercancel", (event: PointerEvent) => {
    finishSelectionGesture(event, true);
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
    (progress) => {
      if (progress.stage === "read") {
        loadingProgress.setFileProgress(progress.filename, progress.bytesLoaded, progress.totalBytes);
      }
    },
  );

  const startupUrl = getStartupSplatUrl();
  status.textContent = `Loading ${startupUrl}...`;
  loadingProgress.start(`Loading ${getFilenameFromUrl(startupUrl)}`);
  void fileHandler.importFiles([
    { filename: getFilenameFromUrl(startupUrl), url: startupUrl },
  ]);

  engine.runRenderLoop(() => {
    renderDiagnostics.beginFrame();
    scene.render();
    debugStats.update();
    loadingProgress.update(currentSplatCloud);
  });

  window.addEventListener("resize", () => {
    engine.resize();
  });
}
