import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import "@babylonjs/core/Rendering/edgesRenderer";
import type { Scene } from "@babylonjs/core/scene";

import type { SsogChunkEntry } from "../splat/SplatAsset";

type DebugChunkBoundStyle = "unloaded" | "loaded-waiting";

const getColor = (key: string): Color3 => {
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }

  return new Color3(
    0.35 + ((hash & 0xff) / 255) * 0.65,
    0.35 + (((hash >> 8) & 0xff) / 255) * 0.65,
    0.35 + (((hash >> 16) & 0xff) / 255) * 0.65,
  );
};

const getBoundLines = (entry: SsogChunkEntry): Vector3[][] => {
  const min = entry.bound.min;
  const max = entry.bound.max;
  const corners = [
    new Vector3(min[0], min[1], min[2]),
    new Vector3(max[0], min[1], min[2]),
    new Vector3(max[0], max[1], min[2]),
    new Vector3(min[0], max[1], min[2]),
    new Vector3(min[0], min[1], max[2]),
    new Vector3(max[0], min[1], max[2]),
    new Vector3(max[0], max[1], max[2]),
    new Vector3(min[0], max[1], max[2]),
  ];
  const edges: [number, number][] = [
    [0, 1], [1, 2], [2, 3], [3, 0],
    [4, 5], [5, 6], [6, 7], [7, 4],
    [0, 4], [1, 5], [2, 6], [3, 7],
  ];

  return edges.map(([start, end]) => [corners[start], corners[end]]);
};

const getBoundBox = (
  entry: SsogChunkEntry,
): { center: Vector3; width: number; height: number; depth: number } => {
  const min = entry.bound.min;
  const max = entry.bound.max;
  return {
    center: new Vector3((min[0] + max[0]) * 0.5, (min[1] + max[1]) * 0.5, (min[2] + max[2]) * 0.5),
    width: Math.max(0.001, max[0] - min[0]),
    height: Math.max(0.001, max[1] - min[1]),
    depth: Math.max(0.001, max[2] - min[2]),
  };
};

class SsogDebugBounds {
  private readonly bounds = new Map<string, AbstractMesh>();
  private readonly styles = new Map<string, DebugChunkBoundStyle>();
  private visible = false;

  constructor(
    private readonly scene: Scene,
  ) {}

  get isVisible(): boolean {
    return this.visible;
  }

  setVisible(v: boolean): void {
    this.visible = v;
    this.bounds.forEach((mesh) => mesh.setEnabled(v));
  }

  ensure(key: string, entry: SsogChunkEntry, style: DebugChunkBoundStyle): void {
    const existing = this.bounds.get(key);
    if (existing) {
      if (this.styles.get(key) !== style) {
        this.dispose(key);
      } else {
        existing.setEnabled(this.visible);
        return;
      }
    }
    this.create(key, entry, style);
  }

  dispose(key: string): void {
    const mesh = this.bounds.get(key);
    if (!mesh) {
      return;
    }

    mesh.material?.dispose();
    mesh.dispose();
    this.bounds.delete(key);
    this.styles.delete(key);
  }

  has(key: string): boolean {
    return this.bounds.has(key);
  }

  disposeAll(): void {
    this.bounds.forEach((mesh) => {
      mesh.material?.dispose();
      mesh.dispose();
    });
    this.bounds.clear();
    this.styles.clear();
  }

  private create(key: string, entry: SsogChunkEntry, style: DebugChunkBoundStyle): void {
    this.styles.set(key, style);
    const color = getColor(key);

    if (style === "unloaded") {
      const mesh = MeshBuilder.CreateLineSystem(
        `ssog-debug-bound-${key}`,
        { lines: getBoundLines(entry) },
        this.scene,
      );
      mesh.color = color;
      mesh.isPickable = false;
      mesh.alwaysSelectAsActiveMesh = true;
      mesh.setEnabled(this.visible);
      this.bounds.set(key, mesh);
      return;
    }

    const box = getBoundBox(entry);
    const mesh = MeshBuilder.CreateBox(
      `ssog-debug-loaded-bound-${key}`,
      { width: box.width, height: box.height, depth: box.depth },
      this.scene,
    );
    mesh.position.copyFrom(box.center);
    const material = new StandardMaterial(`ssog-debug-loaded-bound-material-${key}`, this.scene);
    material.diffuseColor = color;
    material.emissiveColor = color.scale(0.45);
    material.alpha = 0.08;
    material.disableLighting = true;
    mesh.material = material;
    mesh.enableEdgesRendering();
    mesh.edgesWidth = 6;
    mesh.edgesColor = new Color4(color.r, color.g, color.b, 0.9);
    mesh.isPickable = false;
    mesh.alwaysSelectAsActiveMesh = true;
    mesh.setEnabled(this.visible);
    this.bounds.set(key, mesh);
  }
}

export { SsogDebugBounds };
