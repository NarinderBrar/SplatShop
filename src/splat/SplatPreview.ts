import { Vector3 } from "@babylonjs/core/Maths/math.vector";

import type { SplatData } from "./SplatData";

class SplatPreview {
  private centerAndRadius?: { center: Vector3; radius: number };

  setData(splatData: SplatData): void {
    const x = splatData.getFloatProp("x");
    const y = splatData.getFloatProp("y");
    const z = splatData.getFloatProp("z");

    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let minZ = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    let maxZ = Number.NEGATIVE_INFINITY;

    for (let i = 0; i < splatData.numSplats; i++) {
      minX = Math.min(minX, x[i]);
      minY = Math.min(minY, y[i]);
      minZ = Math.min(minZ, z[i]);
      maxX = Math.max(maxX, x[i]);
      maxY = Math.max(maxY, y[i]);
      maxZ = Math.max(maxZ, z[i]);
    }

    const center = new Vector3(
      (minX + maxX) * 0.5,
      (minY + maxY) * 0.5,
      (minZ + maxZ) * 0.5,
    );
    const radius = Math.max(
      0.01,
      Vector3.Distance(center, new Vector3(maxX, maxY, maxZ)),
      Vector3.Distance(center, new Vector3(minX, minY, minZ)),
    );

    this.centerAndRadius = { center, radius };
  }

  getCenterAndRadius(): { center: Vector3; radius: number } | undefined {
    return this.centerAndRadius;
  }

  setVisible(_visible: boolean): void {
    // Kept for the old point-preview call site; bounds are now CPU-only.
  }

  dispose(): void {
    this.centerAndRadius = undefined;
  }
}

export { SplatPreview };
