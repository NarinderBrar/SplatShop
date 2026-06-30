import type { Scene } from "@babylonjs/core/scene";

import type { SelectionMode } from "../app/createUI";
import { SplatStateCommandQueue, type SplatStateCommandStats } from "./SplatStateCommandQueue";
import { SplatStateBuffer, SPLAT_STATE_SELECTED } from "./SplatStateBuffer";

type SelectionSource = {
  centers: Float32Array;
  centerStride: 3 | 4;
  colors: Float32Array;
};

type NdcPoint = {
  x: number;
  y: number;
};

type ProjectedSplat = {
  x: number;
  y: number;
  depth: number;
};

const DEFAULT_PICK_RADIUS_NDC = 0.025;
const MAX_CONNECTED_DISTANCE = 10;

class SelectionPass {
  private readonly state: SplatStateBuffer;
  private readonly commands = new SplatStateCommandQueue();
  private selectedCount = 0;

  constructor(
    scene: Scene,
    private readonly source: SelectionSource,
    private readonly numSplats: number,
  ) {
    this.state = new SplatStateBuffer(scene, numSplats);
  }

  selectPoint(
    ndcX: number,
    ndcY: number,
    threshold: number,
    selectionMode: SelectionMode,
    selectBehind: boolean,
    viewProjection: Float32Array,
  ): Promise<number> {
    return this.commands.enqueue("selection", () =>
      this.selectPointNow(ndcX, ndcY, threshold, selectionMode, selectBehind, viewProjection),
    );
  }

  selectRect(
    minX: number,
    minY: number,
    maxX: number,
    maxY: number,
    selectionMode: SelectionMode,
    selectBehind: boolean,
    viewProjection: Float32Array,
  ): Promise<number> {
    return this.commands.enqueue("selection", () =>
      this.selectProjectedSplats(
        selectionMode,
        selectBehind,
        viewProjection,
        (projected) =>
          projected.x >= minX &&
          projected.x <= maxX &&
          projected.y >= minY &&
          projected.y <= maxY,
      ),
    );
  }

  selectCircle(
    centerX: number,
    centerY: number,
    radius: number,
    selectionMode: SelectionMode,
    selectBehind: boolean,
    viewProjection: Float32Array,
  ): Promise<number> {
    const radiusSq = radius * radius;
    return this.commands.enqueue("selection", () =>
      this.selectProjectedSplats(
        selectionMode,
        selectBehind,
        viewProjection,
        (projected) => {
          const dx = projected.x - centerX;
          const dy = projected.y - centerY;
          return dx * dx + dy * dy <= radiusSq;
        },
      ),
    );
  }

  selectLasso(
    points: readonly NdcPoint[],
    selectionMode: SelectionMode,
    selectBehind: boolean,
    viewProjection: Float32Array,
  ): Promise<number> {
    if (points.length < 3) {
      return Promise.resolve(this.selectedCount);
    }

    return this.commands.enqueue("selection", () =>
      this.selectProjectedSplats(
        selectionMode,
        selectBehind,
        viewProjection,
        (projected) => this.isPointInPolygon(projected, points),
      ),
    );
  }

  clearSelection(): Promise<number> {
    return this.commands.enqueue("selection", () => {
      this.state.clearFlag(SPLAT_STATE_SELECTED);
      this.selectedCount = 0;
      this.state.flush();
      return 0;
    });
  }

  getStateBuffer(): SplatStateBuffer {
    return this.state;
  }

  getCommandStats(): SplatStateCommandStats {
    return this.commands.getStats();
  }

  dispose(): void {
    this.commands.dispose();
    this.state.dispose();
  }

  private selectPointNow(
    ndcX: number,
    ndcY: number,
    threshold: number,
    selectionMode: SelectionMode,
    selectBehind: boolean,
    viewProjection: Float32Array,
  ): number {
    if (this.numSplats <= 0) {
      return 0;
    }

    if (selectionMode === "normal") {
      this.state.clearFlag(SPLAT_STATE_SELECTED);
      this.selectedCount = 0;
    }

    const seedIndex = this.findNearestProjectedSplat(ndcX, ndcY, selectBehind, viewProjection);
    if (seedIndex < 0) {
      this.state.flush();
      return this.selectedCount;
    }

    const seedCenter = this.getCenter(seedIndex);
    const seedColor = this.getColor(seedIndex);
    const matchedIndices: number[] = [];

    for (let index = 0; index < this.numSplats; index++) {
      const color = this.getColor(index);
      const dr = color[0] - seedColor[0];
      const dg = color[1] - seedColor[1];
      const db = color[2] - seedColor[2];
      if (Math.hypot(dr, dg, db) > threshold) {
        continue;
      }

      const center = this.getCenter(index);
      if (
        Math.hypot(
          center[0] - seedCenter[0],
          center[1] - seedCenter[1],
          center[2] - seedCenter[2],
        ) > MAX_CONNECTED_DISTANCE
      ) {
        continue;
      }

      matchedIndices.push(index);
    }

    this.state.setMany(matchedIndices, SPLAT_STATE_SELECTED, selectionMode !== "sub");
    this.selectedCount = this.state.count(SPLAT_STATE_SELECTED);
    this.state.flush();
    return this.selectedCount;
  }

  private findNearestProjectedSplat(
    ndcX: number,
    ndcY: number,
    selectBehind: boolean,
    viewProjection: Float32Array,
  ): number {
    let bestIndex = -1;
    let bestDistanceSq = DEFAULT_PICK_RADIUS_NDC * DEFAULT_PICK_RADIUS_NDC;
    let bestDepth = Number.POSITIVE_INFINITY;

    for (let index = 0; index < this.numSplats; index++) {
      const projected = this.projectSplat(index, selectBehind, viewProjection);
      if (!projected) {
        continue;
      }

      const dx = projected.x - ndcX;
      const dy = projected.y - ndcY;
      const distanceSq = dx * dx + dy * dy;
      if (distanceSq > bestDistanceSq) {
        continue;
      }

      if (distanceSq < bestDistanceSq || projected.depth < bestDepth) {
        bestIndex = index;
        bestDistanceSq = distanceSq;
        bestDepth = projected.depth;
      }
    }

    return bestIndex;
  }

  private selectProjectedSplats(
    selectionMode: SelectionMode,
    selectBehind: boolean,
    viewProjection: Float32Array,
    predicate: (projected: ProjectedSplat, index: number) => boolean,
  ): number {
    if (selectionMode === "normal") {
      this.state.clearFlag(SPLAT_STATE_SELECTED);
      this.selectedCount = 0;
    }

    const matchedIndices: number[] = [];
    for (let index = 0; index < this.numSplats; index++) {
      const projected = this.projectSplat(index, selectBehind, viewProjection);
      if (projected && predicate(projected, index)) {
        matchedIndices.push(index);
      }
    }

    this.state.setMany(matchedIndices, SPLAT_STATE_SELECTED, selectionMode !== "sub");
    this.selectedCount = this.state.count(SPLAT_STATE_SELECTED);
    this.state.flush();
    return this.selectedCount;
  }

  private projectSplat(
    index: number,
    selectBehind: boolean,
    viewProjection: Float32Array,
  ): ProjectedSplat | undefined {
    const [x, y, z] = this.getCenter(index);
    const clipX = viewProjection[0] * x + viewProjection[4] * y + viewProjection[8] * z + viewProjection[12];
    const clipY = viewProjection[1] * x + viewProjection[5] * y + viewProjection[9] * z + viewProjection[13];
    const clipZ = viewProjection[2] * x + viewProjection[6] * y + viewProjection[10] * z + viewProjection[14];
    const clipW = viewProjection[3] * x + viewProjection[7] * y + viewProjection[11] * z + viewProjection[15];
    if (clipW <= 0) {
      return undefined;
    }

    const depth = clipZ / clipW;
    if (!selectBehind && depth > 1) {
      return undefined;
    }

    return {
      x: clipX / clipW,
      y: clipY / clipW,
      depth,
    };
  }

  private isPointInPolygon(point: NdcPoint, polygon: readonly NdcPoint[]): boolean {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const a = polygon[i];
      const b = polygon[j];
      const crosses =
        a.y > point.y !== b.y > point.y &&
        point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x;
      if (crosses) {
        inside = !inside;
      }
    }
    return inside;
  }

  private getCenter(index: number): [number, number, number] {
    const offset = index * this.source.centerStride;
    return [
      this.source.centers[offset + 0],
      this.source.centers[offset + 1],
      this.source.centers[offset + 2],
    ];
  }

  private getColor(index: number): [number, number, number] {
    const offset = index * 4;
    return [
      this.source.colors[offset + 0],
      this.source.colors[offset + 1],
      this.source.colors[offset + 2],
    ];
  }
}

export { SelectionPass };
export type { SelectionSource };
