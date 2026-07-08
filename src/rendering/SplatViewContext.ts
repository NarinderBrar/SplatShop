import type { Camera } from "@babylonjs/core/Cameras/camera";
import type { Scene } from "@babylonjs/core/scene";

import { getQualitySplatBudgetForPreset, type SplatQualityPreset } from "./qualityProfiles";

type SplatViewKind = "interactive" | "screenshot" | "thumbnail" | "minimap" | "portal" | "offline";

type SplatViewContext = {
  id: string;
  kind: SplatViewKind;
  camera?: Camera;
  qualityPreset?: SplatQualityPreset;
  splatBudget?: number;
  viewportHeight?: number;
};

const MAIN_SPLAT_VIEW_ID = "main";

const getMainSplatViewContext = (scene: Scene, qualityPreset?: SplatQualityPreset): SplatViewContext => ({
  id: MAIN_SPLAT_VIEW_ID,
  kind: "interactive",
  camera: scene.activeCamera ?? undefined,
  qualityPreset,
});

const resolveSplatViewCamera = (scene: Scene, view?: SplatViewContext): Camera | undefined =>
  view?.camera ?? scene.activeCamera ?? undefined;

const resolveSplatViewViewportHeight = (scene: Scene, view?: SplatViewContext): number =>
  Math.max(1, view?.viewportHeight ?? scene.getEngine().getRenderHeight(true));

const resolveSplatViewBudget = (
  sourceSplats: number,
  fallbackBudget: number,
  view?: SplatViewContext,
): number => {
  if (view?.splatBudget !== undefined && Number.isFinite(view.splatBudget) && view.splatBudget > 0) {
    return Math.min(sourceSplats, Math.floor(view.splatBudget));
  }
  if (view?.qualityPreset) {
    return getQualitySplatBudgetForPreset(sourceSplats, view.qualityPreset, { referenceParam: "ssogReference" });
  }
  return Math.min(sourceSplats, Math.max(1, Math.floor(fallbackBudget)));
};

export {
  MAIN_SPLAT_VIEW_ID,
  getMainSplatViewContext,
  resolveSplatViewBudget,
  resolveSplatViewCamera,
  resolveSplatViewViewportHeight,
};
export type { SplatViewContext, SplatViewKind };
