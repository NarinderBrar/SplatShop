import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Material } from "@babylonjs/core/Materials/material";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { Scene } from "@babylonjs/core/scene";

import type { SsogChunkEntry } from "../splat/SplatAsset";

type DebugChunkBoundStyle = "unloaded" | "loaded-waiting";

const VERTEX_SOURCE = `
attribute position: vec3f;
attribute color: vec4f;

uniform worldViewProjection: mat4x4f;

varying vColor: vec4f;

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
  vertexOutputs.position = uniforms.worldViewProjection * vec4f(vertexInputs.position, 1.0);
  vertexOutputs.vColor = vertexInputs.color;
}
`;

const FRAGMENT_SOURCE = `
varying vColor: vec4f;

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  fragmentOutputs.color = input.vColor;
}
`;

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

class SsogDebugBounds {
  private readonly bounds = new Map<string, AbstractMesh>();
  private readonly styles = new Map<string, DebugChunkBoundStyle>();
  private readonly material: ShaderMaterial;
  private visible = false;

  constructor(
    private readonly scene: Scene,
  ) {
    this.material = new ShaderMaterial(
      "SsogDebugBoundsMaterial",
      scene,
      {
        vertexSource: VERTEX_SOURCE,
        fragmentSource: FRAGMENT_SOURCE,
      },
      {
        attributes: ["position", "color"],
        uniforms: ["worldViewProjection"],
        needAlphaBlending: true,
        shaderLanguage: ShaderLanguage.WGSL,
      },
    );
    this.material.fillMode = Material.LineListDrawMode;
    this.material.disableDepthWrite = true;
  }

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

    mesh.dispose();
    this.bounds.delete(key);
    this.styles.delete(key);
  }

  has(key: string): boolean {
    return this.bounds.has(key);
  }

  disposeAll(): void {
    this.bounds.forEach((mesh) => {
      mesh.dispose();
    });
    this.bounds.clear();
    this.styles.clear();
    this.material.dispose();
  }

  private create(key: string, entry: SsogChunkEntry, style: DebugChunkBoundStyle): void {
    this.styles.set(key, style);
    const baseColor = getColor(key);
    const color = style === "loaded-waiting" ? baseColor.scale(0.65) : baseColor;
    const lines = getBoundLines(entry);
    const positions = new Float32Array(lines.length * 2 * 3);
    const colors = new Float32Array(lines.length * 2 * 4);
    const indices = new Uint32Array(lines.length * 2);
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex];
      for (let pointIndex = 0; pointIndex < 2; pointIndex++) {
        const vertexIndex = lineIndex * 2 + pointIndex;
        const point = line[pointIndex];
        positions[vertexIndex * 3 + 0] = point.x;
        positions[vertexIndex * 3 + 1] = point.y;
        positions[vertexIndex * 3 + 2] = point.z;
        colors[vertexIndex * 4 + 0] = color.r;
        colors[vertexIndex * 4 + 1] = color.g;
        colors[vertexIndex * 4 + 2] = color.b;
        colors[vertexIndex * 4 + 3] = style === "loaded-waiting" ? 0.65 : 1;
        indices[vertexIndex] = vertexIndex;
      }
    }

    const mesh = new Mesh(`ssog-debug-bound-${style}-${key}`, this.scene);
    mesh.setVerticesData("position", positions, false, 3);
    mesh.setVerticesData("color", colors, false, 4);
    mesh.setIndices(indices);
    mesh.material = this.material;
    mesh.isPickable = false;
    mesh.alwaysSelectAsActiveMesh = true;
    mesh.setEnabled(this.visible);
    this.bounds.set(key, mesh);
  }
}

export { SsogDebugBounds };
